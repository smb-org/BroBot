import { Hono, type Context } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import {
  canManageOverlayAccesses,
  getActiveOverlayAccessCount,
  getOverlayAccessForReplacement,
  issueOverlayAccess,
  listOverlayAccessesForOverlay,
  revealOverlayAccess,
  revokeOverlayAccess,
  tokenEncryptionKeyRing,
} from "../auth/overlay-access-service";
import { OVERLAY_ACCESS_MAXIMUM_COUNT } from "../auth/overlay-access-repository";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { getOverlayForChannel } from "../db/overlays";
import { closeRealtimeTokenBeforeResponse } from "../realtime-revocation";

interface OverlayAccessRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}
type OverlayAccessContext = Context<OverlayAccessRouteEnvironment>;

const accessPath = "/api/channels/:channelId/overlays/:overlayId/accesses";
const nowIso = (): string => new Date().toISOString();
const routeParam = (context: OverlayAccessContext, name: "channelId" | "overlayId"): string =>
  context.req.param(name) ?? "";

const issueAccessSchema = z.object({
  label: z.string().trim().min(1).max(40),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional().default(null),
}).strict();
const replaceAccessSchema = z.object({
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional().default(null),
}).strict();

const truncateLabel = (label: string, maximumLength: number): string => {
  let result = "";
  for (const character of label) {
    if (result.length + character.length > maximumLength) break;
    result += character;
  }
  return result.trimEnd();
};

const replacementLabel = (label: string): string => `${truncateLabel(label, 38)} 2`;

const denied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "overlay_access_manage_denied" }, 403);

const managementAllowed = async (
  context: OverlayAccessContext,
  now: string,
): Promise<boolean> => canManageOverlayAccesses(
  context.env.DB,
  context.get("actor"),
  routeParam(context, "channelId"),
  now,
);

const issue = async (
  context: OverlayAccessContext,
  label: string,
  expiresAt: string | null,
  now: string,
) => issueOverlayAccess(context.env.DB, {
  channelId: routeParam(context, "channelId"),
  overlayId: routeParam(context, "overlayId"),
  label,
  expiresAt,
  actor: context.get("actor"),
  pepper: context.env.OVERLAY_TOKEN_PEPPER,
  keyRing: tokenEncryptionKeyRing(context.env),
  publicOrigin: context.env.PUBLIC_ORIGIN,
  createdAt: now,
});

const issueFailure = async (
  context: OverlayAccessContext,
  now: string,
): Promise<Response> => {
  if (!await managementAllowed(context, now)) return denied(context);
  const overlay = await getOverlayForChannel(context.env.DB,
    routeParam(context, "channelId"), routeParam(context, "overlayId"));
  if (overlay === null) return context.json({ error: "overlay_not_found" }, 404);
  const activeCount = await getActiveOverlayAccessCount(context.env.DB,
    routeParam(context, "channelId"), routeParam(context, "overlayId"), now);
  if (activeCount >= OVERLAY_ACCESS_MAXIMUM_COUNT) {
    return context.json({ error: "overlay_access_limit_reached" }, 409);
  }
  return context.json({ error: "overlay_access_changed_concurrently" }, 409);
};

export const overlayAccessRouter = new Hono<OverlayAccessRouteEnvironment>();

overlayAccessRouter.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});
overlayAccessRouter.use(accessPath, requireChannelAuthorization());
overlayAccessRouter.use(`${accessPath}/*`, requireChannelAuthorization());

overlayAccessRouter.get(accessPath, async (context) => {
  const channelId = context.req.param("channelId");
  const overlayId = context.req.param("overlayId");
  const now = nowIso();
  if (!canManage(context.get("channelRole")) || !await managementAllowed(context, now)) return denied(context);
  const overlay = await getOverlayForChannel(context.env.DB, channelId, overlayId);
  if (overlay === null) return context.json({ error: "overlay_not_found" }, 404);
  const accesses = await listOverlayAccessesForOverlay(context.env.DB, channelId, overlayId);
  const activeCount = await getActiveOverlayAccessCount(context.env.DB, channelId, overlayId, now);
  return context.json({ accesses, activeCount, maximum: OVERLAY_ACCESS_MAXIMUM_COUNT });
});

overlayAccessRouter.post(accessPath, async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const body: unknown = await context.req.json<unknown>().catch((): unknown => null);
  const parsed = issueAccessSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "overlay_access_data_invalid" }, 400);
  const now = nowIso();
  if (parsed.data.expiresAt !== null && Date.parse(parsed.data.expiresAt) <= Date.parse(now)) {
    return context.json({ error: "overlay_expiry_invalid" }, 400);
  }
  const overlay = await getOverlayForChannel(context.env.DB,
    context.req.param("channelId"), context.req.param("overlayId"));
  if (overlay === null) return context.json({ error: "overlay_not_found" }, 404);
  const result = await issue(context, parsed.data.label, parsed.data.expiresAt, now);
  if (result.outcome === "rejected") return issueFailure(context, now);
  return context.json(result.access, 201);
});

overlayAccessRouter.post(`${accessPath}/:tokenId/reveal`, async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const now = nowIso();
  const result = await revealOverlayAccess(context.env.DB, {
    channelId: context.req.param("channelId"),
    overlayId: context.req.param("overlayId"),
    tokenId: context.req.param("tokenId"),
    actor: context.get("actor"),
    pepper: context.env.OVERLAY_TOKEN_PEPPER,
    keyRing: tokenEncryptionKeyRing(context.env),
    publicOrigin: context.env.PUBLIC_ORIGIN,
    revealedAt: now,
  });
  if (result.outcome === "revealed") return context.json({ overlayUrl: result.overlayUrl });
  if (result.outcome === "unrecoverable") return context.json({ error: "overlay_access_unrecoverable" }, 409);
  if (result.outcome === "forbidden") return denied(context);
  return context.json({ error: "overlay_access_not_found" }, 404);
});

overlayAccessRouter.post(`${accessPath}/:tokenId/replace`, async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const now = nowIso();
  const body: unknown = await context.req.json<unknown>().catch((): unknown => ({}));
  const parsed = replaceAccessSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "overlay_access_data_invalid" }, 400);
  if (parsed.data.expiresAt !== null && Date.parse(parsed.data.expiresAt) <= Date.parse(now)) {
    return context.json({ error: "overlay_expiry_invalid" }, 400);
  }
  const channelId = context.req.param("channelId");
  const overlayId = context.req.param("overlayId");
  const tokenId = context.req.param("tokenId");
  const existing = await getOverlayAccessForReplacement(
    context.env.DB, channelId, overlayId, tokenId, context.get("actor"), now,
  );
  if (existing === null) {
    if (!await managementAllowed(context, now)) return denied(context);
    return context.json({ error: "overlay_access_not_found" }, 404);
  }
  if (existing.revokedAt !== null) return context.json({ error: "overlay_access_revoked" }, 409);
  const result = await issue(context, replacementLabel(existing.label), parsed.data.expiresAt, now);
  if (result.outcome === "rejected") return issueFailure(context, now);
  return context.json({ ...result.access, replacesTokenId: existing.tokenId }, 201);
});

overlayAccessRouter.post(`${accessPath}/:tokenId/revoke`, async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const now = nowIso();
  const channelId = context.req.param("channelId");
  const overlayId = context.req.param("overlayId");
  const tokenId = context.req.param("tokenId");
  const result = await revokeOverlayAccess(
    context.env.DB, channelId, overlayId, tokenId, context.get("actor"), now,
  );
  if (result === "forbidden") return denied(context);
  if (result === "not_found") return context.json({ error: "overlay_access_not_found" }, 404);
  const closed = await closeRealtimeTokenBeforeResponse(context.env.CHANNEL, channelId, tokenId);
  if (!closed) return context.json({ closingPending: true }, 202);
  return context.body(null, 204);
});
