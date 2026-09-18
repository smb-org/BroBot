import { createMiddleware } from "hono/factory";

import { authorizeChannelAccess, type ChannelMemberRole } from "./authorization";
import { verifyCsrfRequest } from "./csrf";
import { getSessionFromRequest } from "./session-access";
import type { SessionRecord } from "./repository";

export interface ChannelAuthorizationVariables {
  session: SessionRecord;
  channelRole: ChannelMemberRole;
}

interface ChannelAuthorizationEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const csrfExemptMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const nowIso = (): string => new Date().toISOString();

export const requireChannelAuthorization = () => createMiddleware<ChannelAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) return context.text("Session fehlt.", 401);

    if (!csrfExemptMethods.has(context.req.method) && !await verifyCsrfRequest(
      context.req.raw,
      session.sessionId,
      context.env.SESSION_COOKIE_KEYS,
      nowIso(),
    )) {
      return context.text("CSRF-Token fehlt oder ist ungültig.", 403);
    }

    const channelId = context.req.param("channelId");
    if (channelId === undefined || channelId.length === 0) {
      return context.text("Kanal fehlt.", 400);
    }
    const role = await authorizeChannelAccess(context.env.DB, session, channelId);
    if (role === null) return context.text("Kanalzugriff verweigert.", 403);

    context.set("session", session);
    context.set("channelRole", role);
    await next();
  },
);
