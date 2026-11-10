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

const findBytes = (source: Uint8Array, pattern: Uint8Array, start = 0): number => {
  for (let index = start; index <= source.byteLength - pattern.byteLength; index += 1) {
    if (source[index] !== pattern[0]) continue;
    let matches = true;
    for (let offset = 1; offset < pattern.byteLength; offset += 1) {
      if (source[index + offset] !== pattern[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
};

const parseMultipartPayload = (body: Uint8Array, contentType: string): UploadPayloadResult => {
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundary === undefined || boundary.length > 70 || /[^\x20-\x7e]/u.test(boundary)) {
    return { ok: false, status: 400, error: "media_upload_invalid" };
  }
  const encoder = new TextEncoder();
  const opening = encoder.encode(`--${boundary}\r\n`);
  if (findBytes(body, opening) !== 0) return { ok: false, status: 400, error: "media_upload_invalid" };
  const headerStart = opening.byteLength;
  const headerEndMarker = encoder.encode("\r\n\r\n");
  const headerEnd = findBytes(body, headerEndMarker, headerStart);
  if (headerEnd < 0 || headerEnd - headerStart > MULTIPART_ENVELOPE_LIMIT) {
    return { ok: false, status: 400, error: "media_upload_invalid" };
  }
  const headers = new TextDecoder().decode(body.subarray(headerStart, headerEnd)).split("\r\n");
  const disposition = headers.find((header) => header.toLowerCase().startsWith("content-disposition:"));
  const mimeHeader = headers.find((header) => header.toLowerCase().startsWith("content-type:"));
  const name = disposition === undefined ? null : /(?:^|;)\s*name="([^"]*)"/iu.exec(disposition)?.[1] ?? null;
  const fileName = disposition === undefined ? null : /(?:^|;)\s*filename="([^"]*)"/iu.exec(disposition)?.[1] ?? null;
  const declaredMimeType = mimeHeader?.slice(mimeHeader.indexOf(":") + 1).trim() ?? "";
  if (name !== "file" || fileName === null || declaredMimeType.length === 0) {
    return { ok: false, status: 400, error: "media_upload_invalid" };
  }

  const contentStart = headerEnd + headerEndMarker.byteLength;
  const closingBoundary = encoder.encode(`\r\n--${boundary}`);
  const contentEnd = findBytes(body, closingBoundary, contentStart);
  if (contentEnd < contentStart) return { ok: false, status: 400, error: "media_upload_invalid" };
  const fileBytes = body.subarray(contentStart, contentEnd);
  if (fileBytes.byteLength > MEDIA_MAXIMUM_BYTES) return { ok: false, status: 413, error: "media_too_large" };

  const suffixOffset = contentEnd + closingBoundary.byteLength;
  const closingSuffix = encoder.encode("--\r\n");
  if (findBytes(body, closingSuffix, suffixOffset) !== suffixOffset ||
    suffixOffset + closingSuffix.byteLength !== body.byteLength) {
    return { ok: false, status: 400, error: "media_upload_invalid" };
  }
  return {
    ok: true,
    payload: { bytes: new Uint8Array(fileBytes), declaredMimeType, fileName },
  };
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

  if (multipart) return parseMultipartPayload(body, contentType);

  const declaredMimeType = request.headers.get("Content-Type") ?? "";
  const fileName = request.headers.get("X-File-Name") ?? "media";
  return { ok: true, payload: { bytes: body, declaredMimeType, fileName } };
};

const isMediaInUse = (channelId: string, id: string): Promise<boolean> => {
  // Alert actions will add channel-scoped references in the follow-up issue.
  void channelId;
  void id;
  return Promise.resolve(false);
};

export const createOverlayAlertsRoutes = (options: {
  isMediaInUse?: (channelId: string, id: string) => Promise<boolean>;
} = {}): Hono<ModuleRouteEnvironment> => {
  const routes = new Hono<ModuleRouteEnvironment>();
  const checkMediaInUse = options.isMediaInUse ?? isMediaInUse;

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
    if (await checkMediaInUse(channelId, id)) return context.json({ error: "media_in_use" }, 409);

    const now = nowIso();
    if (!await currentManagerCanMutate(context, channelId, now)) {
      return context.json({ error: "media_management_denied" }, 403);
    }
    const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
    const mutation = context.env.DB.prepare(
      `DELETE FROM media_assets WHERE channel_id = ? AND id = ? ${authorization.sql} RETURNING id`,
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
    return asset === null ? context.json({ error: "media_not_found" }, 404) : mediaAssetResponse(asset);
  });

  return routes;
};

export const overlayAlertsRoutes = createOverlayAlertsRoutes();

