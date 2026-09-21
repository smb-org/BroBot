import { createMiddleware } from "hono/factory";

import { getBetreiberUserIds } from "../config";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../module-authorization";
import type { AuthorizeModuleMutation, PrepareModuleAudit } from "../../modules/contract";
import { prepareModuleAudit } from "../module-audit";
import { authorizeChannelAccess, type ChannelMemberRole } from "./authorization";
import { verifyCsrfRequest } from "./csrf";
import { getSessionFromRequest } from "./session-access";
import type { ActorContext, SessionRecord } from "./repository";

export interface ChannelAuthorizationVariables {
  session: SessionRecord;
  channelRole: ChannelMemberRole;
  actor: ActorContext;
  authorizeMutation: AuthorizeModuleMutation;
  authorizeManagementMutation: AuthorizeModuleMutation;
  prepareModuleAudit: PrepareModuleAudit;
}

export interface SessionAuthorizationVariables {
  session: SessionRecord;
}

export interface BetreiberAuthorizationVariables {
  session: SessionRecord;
  actor: ActorContext;
}

interface ChannelAuthorizationEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

interface SessionAuthorizationEnvironment {
  Bindings: Env;
  Variables: SessionAuthorizationVariables;
}

interface BetreiberAuthorizationEnvironment {
  Bindings: Env;
  Variables: BetreiberAuthorizationVariables;
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
    context.set("actor", { userId: session.userId, sessionId: session.sessionId });
    context.set("authorizeMutation", authorizeModuleMutation);
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(context.env.DB, session.userId, changedAt, entry));
    await next();
  },
);

export const requireBetreiber = () => createMiddleware<BetreiberAuthorizationEnvironment>(
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

    if (!getBetreiberUserIds(context.env).has(session.userId)) {
      return context.text("Kein Betreiberzugang.", 403);
    }

    context.set("session", session);
    context.set("actor", { userId: session.userId, sessionId: session.sessionId });
    await next();
  },
);

export const requireSessionAuthorization = () => createMiddleware<SessionAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) return context.text("Session fehlt.", 401);
    context.set("session", session);
    await next();
  },
);
