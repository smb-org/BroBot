import { Hono } from "hono";

import type {
  RealtimeEnvelope,
  RealtimePrincipal,
} from "../realtime-contract";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "./auth/guards";
import {
  listChannelIdsForUser,
} from "./db/channels";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "./realtime-protocol";

interface RealtimeRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const protocolOffered = (header: string | null): boolean =>
  header?.split(",").some((value) => value.trim() === REALTIME_PROTOCOL) ?? false;

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

/**
 * Der Worker reicht niemals den Client-Request an das Objekt durch. Diese
 * Grenze ist absichtlich hier sichtbar: Der Client kann den Header mit dem
 * Namen des internen Prinzipals setzen, aber er erreicht damit nie das DO.
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
      return context.text("WebSocket-Herkunft ist ungültig.", 403);
    }
    if (!protocolOffered(context.req.raw.headers.get("Sec-WebSocket-Protocol"))) {
      return context.text("Realtime-Protokoll wird nicht unterstützt.", 426);
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

const channelObject = (namespace: Env["CHANNEL"] | undefined, channelId: string) => {
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(channelId));
};

export const publishRealtimeMessage = async (
  namespace: Env["CHANNEL"] | undefined,
  message: RealtimeEnvelope<"ereignisprotokoll.neu">,
): Promise<void> => {
  const object = channelObject(namespace, message.channelId);
  if (object === null) return;
  await object.publish(message, "panel");
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
    console.warn("Realtime-Widerruf für Nutzer fehlgeschlagen.", error);
  }
};

export const revokeRealtimeToken = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  tokenId: string,
): Promise<void> => {
  try {
    const object = channelObject(namespace, channelId);
    if (object !== null) await object.revokeToken(tokenId);
  } catch (error: unknown) {
    console.warn("Realtime-Widerruf für Token fehlgeschlagen.", error);
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
    console.warn("Realtime-Widerruf für Sitzung fehlgeschlagen.", error);
  }
};
