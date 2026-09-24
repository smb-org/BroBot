import { Hono } from "hono";

import type {
  RealtimeEnvelope,
  RealtimeMessage,
  RealtimeOverlayPrincipal,
  RealtimePrincipal,
} from "../realtime-contract";
import { OVERLAY_TOKEN_SUBPROTOCOL_PREFIX } from "../realtime-contract";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "./auth/guards";
import { authenticateOverlayToken } from "./auth/overlay-token-service";
import { readChannelControls } from "./db/channel-controls";
import {
  listChannelIdsForUser,
} from "./db/channels";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "./realtime-protocol";
import type { ApiErrorCode } from "../contracts/values";

interface RealtimeRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const protocolOffered = (header: string | null): boolean =>
  header?.split(",").some((value) => value.trim() === REALTIME_PROTOCOL) ?? false;

const overlayTokenFromProtocols = (header: string | null): string | null => {
  const offered = header?.split(",").map((value) => value.trim()) ?? [];
  const tokenProtocols = offered.filter((value) => value.startsWith(OVERLAY_TOKEN_SUBPROTOCOL_PREFIX));
  if (tokenProtocols.length !== 1) return null;
  const token = tokenProtocols[0]?.slice(OVERLAY_TOKEN_SUBPROTOCOL_PREFIX.length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
};

const hasExpectedOrigin = (request: Request, publicOrigin: string): boolean => {
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  try {
    return origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
};

const principalForPanel = (
  channelId: string,
  variables: Pick<RealtimeRouteEnvironment["Variables"], "session" | "channelRole">,
): RealtimePrincipal => ({
  v: 1,
  kind: "panel",
  channelId,
  userId: variables.session.userId,
  sessionId: variables.session.sessionId,
  role: variables.channelRole,
  expiresAt: variables.session.expiresAt,
});

const principalForOverlay = (
  record: NonNullable<Awaited<ReturnType<typeof authenticateOverlayToken>>>,
): RealtimeOverlayPrincipal => ({
  v: 1,
  kind: "overlay",
  channelId: record.channelId,
  tokenId: record.tokenId,
  expiresAt: record.expiresAt,
});

/**
 * The worker never passes the client request through to the object. This
 * boundary is deliberately visible here: the client can set a header with
 * the same name as the internal principal, but it never reaches the DO
 * that way.
 */
const internalChannelRequest = (principal: RealtimePrincipal): Request => new Request(
  "https://channel-object.internal/ws",
  {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Protocol": REALTIME_PROTOCOL,
      [REALTIME_PRINCIPAL_HEADER]: JSON.stringify(principal),
    },
  },
);

export const realtimeRouter = new Hono<RealtimeRouteEnvironment>();

realtimeRouter.get(
  "/ws/channels/:channelId",
  requireChannelAuthorization(),
  async (context) => {
    if (!hasExpectedOrigin(context.req.raw, context.env.PUBLIC_ORIGIN)) {
      return context.json({ error: "websocket_origin_invalid" satisfies ApiErrorCode }, 403);
    }
    if (!protocolOffered(context.req.raw.headers.get("Sec-WebSocket-Protocol"))) {
      return context.json({ error: "realtime_protocol_unsupported" satisfies ApiErrorCode }, 426);
    }

    const channelId = context.req.param("channelId");
    const principal = principalForPanel(channelId, {
      session: context.get("session"),
      channelRole: context.get("channelRole"),
    });
    const objectId = context.env.CHANNEL.idFromName(channelId);
    const object = context.env.CHANNEL.get(objectId);
    return object.fetch(internalChannelRequest(principal));
  },
);

realtimeRouter.get("/ws/overlay", async (context) => {
  if (context.req.raw.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required.", { status: 426 });
  }
  const protocols = context.req.raw.headers.get("Sec-WebSocket-Protocol");
  if (!protocolOffered(protocols)) {
    return context.json({ error: "realtime_protocol_unsupported" satisfies ApiErrorCode }, 426);
  }
  const token = overlayTokenFromProtocols(protocols);
  if (token === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const record = await authenticateOverlayToken(context.env.DB, {
    token,
    pepper: context.env.OVERLAY_TOKEN_PEPPER,
    now: new Date().toISOString(),
  });
  if (record === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const principal = principalForOverlay(record);
  const objectId = context.env.CHANNEL.idFromName(principal.channelId);
  const object = context.env.CHANNEL.get(objectId);
  return object.fetch(internalChannelRequest(principal));
});

const channelObject = (namespace: Env["CHANNEL"] | undefined, channelId: string) => {
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(channelId));
};

export const publishRealtimeMessages = async (
  namespace: Env["CHANNEL"] | undefined,
  messages: readonly RealtimeMessage[],
): Promise<void> => {
  if (messages.length === 0) return;
  const channelId = messages[0]?.channelId;
  if (channelId === undefined || messages.some((message) => message.channelId !== channelId)) {
    throw new Error("Realtime messages must belong to one channel.");
  }
  const object = channelObject(namespace, channelId);
  if (object === null) return;
  await object.publish(messages);
};

/** Sends a channel-variable hint best-effort; D1 remains the authoritative state. */
export const publishVariablesChanged = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  set: RealtimeEnvelope<"variables.changed">["payload"]["set"],
  removed: RealtimeEnvelope<"variables.changed">["payload"]["removed"],
  additionalMessages: readonly RealtimeMessage[] = [],
): Promise<void> => {
  if (set.length === 0 && removed.length === 0 && additionalMessages.length === 0) return;
  const messages: RealtimeMessage[] = [...additionalMessages];
  if (set.length > 0 || removed.length > 0) {
    messages.push({
      version: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      channelId,
      type: "variables.changed",
      payload: { set, removed },
    });
  }
  try {
    await publishRealtimeMessages(namespace, messages);
  } catch (error: unknown) {
    console.warn("Realtime channel-variable hint could not be sent.", error);
  }
};

/** Panel-only hint for a refreshed Twitch stream state; D1 remains authoritative. */
export const publishStreamStateChanged = async (
  namespace: Env["CHANNEL"] | undefined,
  database: D1Database,
  channelId: string,
  state: "online" | "offline",
  startedAt: string | null,
  changedAt: string,
  checkedAt: string,
): Promise<void> => {
  try {
    const controls = await readChannelControls(database, channelId, checkedAt);
    await publishRealtimeMessages(namespace, [{
      version: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      channelId,
      type: "stream.state.changed",
      payload: { state, startedAt, changedAt, checkedAt, controls },
    }]);
  } catch (error: unknown) {
    console.warn("Realtime stream state hint could not be sent.", error);
  }
};

export const revokeRealtimeUser = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  userId: string,
): Promise<void> => {
  try {
    const object = channelObject(namespace, channelId);
    if (object !== null) await object.revokeUser(userId);
  } catch (error: unknown) {
    console.warn("Realtime revocation for user failed.", error);
  }
};

export const revokeRealtimeToken = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  tokenId: string,
): Promise<boolean> => {
  try {
    const object = channelObject(namespace, channelId);
    if (object === null) return false;
    return await object.revokeToken(tokenId);
  } catch (error: unknown) {
    console.warn("Realtime revocation for token failed.", error);
    return false;
  }
};

export const revokeRealtimeSessionForUser = async (
  db: D1Database,
  namespace: Env["CHANNEL"] | undefined,
  userId: string,
  sessionId: string,
): Promise<void> => {
  try {
    if (namespace === undefined) return;
    const channelIds = await listChannelIdsForUser(db, userId);
    await Promise.all(channelIds.map(async (channelId) => {
      const object = channelObject(namespace, channelId);
      if (object !== null) await object.revokeSession(sessionId);
    }));
  } catch (error: unknown) {
    console.warn("Realtime revocation for session failed.", error);
  }
};
