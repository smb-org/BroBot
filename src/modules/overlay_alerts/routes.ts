import { Hono, type Context } from "hono";

import { canManage, type AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import {
  detectMediaType,
  MEDIA_MAXIMUM_ASSETS_PER_CHANNEL,
  MEDIA_MAXIMUM_BYTES,
  safeMediaFileName,
  sha256Hex,
} from "./domain/media";
import {
  findMediaAsset,
  findMediaAssetByHash,
  getMediaAssetForDelivery,
  listMediaAssets,
  mediaAssetResponse,
  OVERLAY_ALERTS_MODULE_ID,
} from "./repository";

const MULTIPART_ENVELOPE_LIMIT = 16_384;
type MediaRouteContext = Context<ModuleRouteEnvironment>;

interface UploadPayload {
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName: string;
}

type UploadPayloadResult =
  | { ok: true; payload: UploadPayload }
  | { ok: false; status: 400 | 413 | 415; error: string };

const channelIdFrom = (context: MediaRouteContext): string => context.req.param("channelId") ?? "";
const nowIso = (): string => new Date().toISOString();

const requireManager = (context: MediaRouteContext): Response | null =>
  canManage(context.get("channelRole"))
    ? null
    : context.json({ error: "media_management_denied" }, 403);

const currentManagerCanMutate = async (context: MediaRouteContext, channelId: string, now: string): Promise<boolean> => {
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const currentMember = await context.env.DB.prepare(
    `SELECT channel_id FROM channels WHERE channel_id = ? ${authorization.sql}`,
  ).bind(channelId, ...authorization.values).first<{ channel_id: string }>();
  return currentMember !== null;
};

const contentLength = (request: Request): number | null => {
  const raw = request.headers.get("Content-Length");
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const readBoundedBody = async (request: Request, maximumBytes: number): Promise<Uint8Array | null> => {
  // Empty POST requests have no stream at runtime, despite the worker Request type being non-nullable.
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** The body is already size-capped, so the platform parser only sees bounded input. */
const parseMultipartPayload = async (body: Uint8Array, contentType: string): Promise<UploadPayloadResult> => {
  const invalid = { ok: false, status: 400, error: "media_upload_invalid" } as const;
  let form: FormData;
  try {
    form = await new Response(new Blob([new Uint8Array(body)]), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    return invalid;
  }
  const file = form.get("file");
  if (typeof file === "string" || file === null || file.type.length === 0) return invalid;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MEDIA_MAXIMUM_BYTES) return { ok: false, status: 413, error: "media_too_large" };
  return { ok: true, payload: { bytes, declaredMimeType: file.type, fileName: file.name } };
};

const readUploadPayload = async (request: Request): Promise<UploadPayloadResult> => {
  const contentType = request.headers.get("Content-Type") ?? "";
  const multipart = contentType.toLowerCase().startsWith("multipart/form-data");
  const maximumBodyBytes = multipart ? MEDIA_MAXIMUM_BYTES + MULTIPART_ENVELOPE_LIMIT : MEDIA_MAXIMUM_BYTES;
  const declaredLength = contentLength(request);
  if (declaredLength !== null && declaredLength > maximumBodyBytes) {
    return { ok: false, status: 413, error: "media_too_large" };
  }
  const body = await readBoundedBody(request, maximumBodyBytes);
  if (body === null) return { ok: false, status: 413, error: "media_too_large" };

  if (multipart) return await parseMultipartPayload(body, contentType);

  const declaredMimeType = request.headers.get("Content-Type") ?? "";
  const fileName = request.headers.get("X-File-Name") ?? "media";
  return { ok: true, payload: { bytes: body, declaredMimeType, fileName } };
};

const mediaInUseRewardNames = async (db: D1Database, channelId: string, id: string): Promise<string[]> => {
  const result = await db.prepare(
    `SELECT title FROM channel_points_rewards
      WHERE channel_id = ? AND action_module_id = 'overlay_alerts' AND action_id = 'show-alert'
        AND (json_extract(action_config_json, '$.imageAssetId') = ?
          OR json_extract(action_config_json, '$.soundAssetId') = ?)
      ORDER BY title COLLATE NOCASE, id`,
  ).bind(channelId, id, id).all<{ title: string }>();
  return result.results.map(({ title }) => title);
};

export const createOverlayAlertsRoutes = (options: {
  mediaInUseRewardNames?: (channelId: string, id: string) => Promise<readonly string[]>;
  /** Kept for existing route tests and callers that only need to simulate a guard. */
  isMediaInUse?: (channelId: string, id: string) => Promise<boolean>;
} = {}): Hono<ModuleRouteEnvironment> => {
  const routes = new Hono<ModuleRouteEnvironment>();
  const listMediaInUseRewardNames = options.mediaInUseRewardNames;

  routes.get("/media", async (context) => {
    const assets = await listMediaAssets(context.env.DB, channelIdFrom(context));
    return context.json({ assets });
  });

  routes.post("/media", async (context) => {
    const deniedResponse = requireManager(context);
    if (deniedResponse !== null) return deniedResponse;
    const upload = await readUploadPayload(context.req.raw);
    if (!upload.ok) return context.json({ error: upload.error }, upload.status);
    if (upload.payload.bytes.byteLength === 0) return context.json({ error: "media_upload_invalid" }, 400);
    if (upload.payload.bytes.byteLength > MEDIA_MAXIMUM_BYTES) {
      return context.json({ error: "media_too_large" }, 413);
    }
    const detected = detectMediaType(upload.payload.bytes, upload.payload.declaredMimeType);
    if (detected === null) return context.json({ error: "media_type_invalid" }, 415);

    const channelId = channelIdFrom(context);
    const now = nowIso();
    if (!await currentManagerCanMutate(context, channelId, now)) {
      return context.json({ error: "media_management_denied" }, 403);
    }
    const sha256 = await sha256Hex(upload.payload.bytes);
    const duplicate = await findMediaAssetByHash(context.env.DB, channelId, sha256);
    if (duplicate !== null) return context.json({ asset: duplicate });

    const id = crypto.randomUUID();
    const fileName = safeMediaFileName(upload.payload.fileName);
    const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
    const mutation = context.env.DB.prepare(
      `INSERT INTO media_assets (
         channel_id, id, kind, mime_type, byte_size, sha256, file_name, data, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM media_assets WHERE channel_id = ?) < ? ${authorization.sql}
       ON CONFLICT(channel_id, sha256) DO NOTHING
       RETURNING id`,
    ).bind(
      channelId, id, detected.kind, detected.mimeType, upload.payload.bytes.byteLength, sha256,
      fileName, upload.payload.bytes, now, channelId, MEDIA_MAXIMUM_ASSETS_PER_CHANNEL,
      ...authorization.values,
    );
    const audit = context.get("prepareModuleAudit")({
      channelId,
      moduleId: OVERLAY_ALERTS_MODULE_ID,
      action: "overlay_alerts.media.uploaded" satisfies AuditAction,
      before: null,
      after: { mediaId: id, name: fileName, kind: detected.kind, mimeType: detected.mimeType, byteSize: upload.payload.bytes.byteLength },
    }, now);
    const [result] = await context.env.DB.batch([mutation, audit]);
    if ((result?.meta.changes ?? 0) > 0) {
      const asset = await findMediaAsset(context.env.DB, channelId, id);
      return context.json({ asset }, 201);
    }

    const existing = await findMediaAssetByHash(context.env.DB, channelId, sha256);
    if (existing !== null) return context.json({ asset: existing });
    const count = await context.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_assets WHERE channel_id = ?",
    ).bind(channelId).first<{ count: number }>();
    return (count?.count ?? 0) >= MEDIA_MAXIMUM_ASSETS_PER_CHANNEL
      ? context.json({ error: "media_limit_reached" }, 409)
      : context.json({ error: "media_management_denied" }, 403);
  });

  routes.delete("/media/:id", async (context) => {
    const deniedResponse = requireManager(context);
    if (deniedResponse !== null) return deniedResponse;
    const channelId = channelIdFrom(context);
    const id = context.req.param("id");
    const asset = await findMediaAsset(context.env.DB, channelId, id);
    if (asset === null) return context.json({ error: "media_not_found" }, 404);
    const rewardNames = listMediaInUseRewardNames === undefined
      ? await mediaInUseRewardNames(context.env.DB, channelId, id)
      : await listMediaInUseRewardNames(channelId, id);
    const legacyGuardBlocked = options.isMediaInUse === undefined ? false : await options.isMediaInUse(channelId, id);
    if (rewardNames.length > 0 || legacyGuardBlocked) {
      return context.json({ error: "media_in_use", ...(rewardNames.length === 0 ? {} : { rewards: rewardNames }) }, 409);
    }

    const now = nowIso();
    if (!await currentManagerCanMutate(context, channelId, now)) {
      return context.json({ error: "media_management_denied" }, 403);
    }
    const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
    const mutation = context.env.DB.prepare(
      `DELETE FROM media_assets
        WHERE channel_id = ? AND id = ? ${authorization.sql}
          AND NOT EXISTS (
            SELECT 1 FROM channel_points_rewards AS reward
             WHERE reward.channel_id = media_assets.channel_id
               AND reward.action_module_id = 'overlay_alerts' AND reward.action_id = 'show-alert'
               AND (json_extract(reward.action_config_json, '$.imageAssetId') = media_assets.id
                 OR json_extract(reward.action_config_json, '$.soundAssetId') = media_assets.id)
          )
        RETURNING id`,
    ).bind(channelId, id, ...authorization.values);
    const audit = context.get("prepareModuleAudit")({
      channelId,
      moduleId: OVERLAY_ALERTS_MODULE_ID,
      action: "overlay_alerts.media.deleted" satisfies AuditAction,
      before: { mediaId: id, name: asset.fileName, kind: asset.kind, mimeType: asset.mimeType, byteSize: asset.byteSize },
      after: null,
    }, now);
    const [result] = await context.env.DB.batch([mutation, audit]);
    if ((result?.meta.changes ?? 0) === 0) {
      const usedBy = await mediaInUseRewardNames(context.env.DB, channelId, id);
      if (usedBy.length > 0) return context.json({ error: "media_in_use", rewards: usedBy }, 409);
      return await findMediaAsset(context.env.DB, channelId, id) === null
        ? context.json({ error: "media_not_found" }, 404)
        : context.json({ error: "media_management_denied" }, 403);
    }
    return context.body(null, 204);
  });

  routes.get("/media/:id/:sha256", async (context) => {
    const asset = await getMediaAssetForDelivery(
      context.env.DB,
      channelIdFrom(context),
      context.req.param("id"),
      context.req.param("sha256"),
    );
    return asset === null ? context.json({ error: "media_not_found" }, 404) : mediaAssetResponse(asset, context.req.raw);
  });

  return routes;
};

export const overlayAlertsRoutes = createOverlayAlertsRoutes();

