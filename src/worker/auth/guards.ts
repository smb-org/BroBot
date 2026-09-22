import { createMiddleware } from "hono/factory";

import { getPlatformUserIds } from "../config";
import { getBotIdentity } from "../db/bot-identity";
import { canConnectBot } from "./bot-authorization";
import { oauthError } from "./oauth-error-texts";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../module-authorization";
import type { AuthorizeModuleMutation, PrepareModuleAudit, WriteModuleAudit } from "../../modules/contract";
import { prepareModuleAudit, writeModuleAudit } from "../module-audit";
import { authorizeChannelAccess } from "./authorization";
import type { ChannelRole } from "../../contracts/values";
import { verifyCsrfRequest } from "./csrf";
import { getSessionFromRequest } from "./session-access";
import type {
  ActorContext,
} from "../db/guards";
import type {
  SessionRecord,
} from "../db/sessions";

export interface ChannelAuthorizationVariables {
  session: SessionRecord;
  channelRole: ChannelRole;
  actor: ActorContext;
  authorizeMutation: AuthorizeModuleMutation;
  authorizeManagementMutation: AuthorizeModuleMutation;
  prepareModuleAudit: PrepareModuleAudit;
  writeModuleAudit: WriteModuleAudit;
}

export interface SessionAuthorizationVariables {
  session: SessionRecord;
}

export interface PlatformAuthorizationVariables {
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

interface PlatformAuthorizationEnvironment {
  Bindings: Env;
  Variables: PlatformAuthorizationVariables;
}

const csrfExemptMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const nowIso = (): string => new Date().toISOString();

const loginRedirectForRequest = (request: Request): string => {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
};

const requireChannelAuthorizationFor = (browserEntry: boolean) => createMiddleware<ChannelAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) {
      return browserEntry
        ? context.redirect(loginRedirectForRequest(context.req.raw), 302)
        : context.json({ error: "session_missing" }, 401);
    }

    if (!csrfExemptMethods.has(context.req.method) && !await verifyCsrfRequest(
      context.req.raw,
      session.sessionId,
      context.env.SESSION_COOKIE_KEYS,
      nowIso(),
    )) {
      return context.json({ error: "csrf_invalid" }, 403);
    }

    const channelId = context.req.param("channelId");
    if (channelId === undefined || channelId.length === 0) {
      return context.json({ error: "channel_missing" }, 400);
    }
    const role = await authorizeChannelAccess(context.env.DB, session, channelId);
    if (role === null) {
      return browserEntry
        ? oauthError(context, "channel_access_denied", 403)
        : context.json({ error: "channel_access_denied" }, 403);
    }

    context.set("session", session);
    context.set("channelRole", role);
    context.set("actor", { userId: session.userId, sessionId: session.sessionId });
    context.set("authorizeMutation", authorizeModuleMutation);
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(context.env.DB, session.userId, changedAt, entry));
    context.set("writeModuleAudit", (entry, changedAt) =>
      writeModuleAudit(context.env.DB, session.userId, changedAt, entry));
    await next();
  },
);

const requirePlatformAuthorizationFor = (browserEntry: boolean) => createMiddleware<PlatformAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) {
      return browserEntry
        ? context.redirect(loginRedirectForRequest(context.req.raw), 302)
        : context.json({ error: "session_missing" }, 401);
    }

    if (!csrfExemptMethods.has(context.req.method) && !await verifyCsrfRequest(
      context.req.raw,
      session.sessionId,
      context.env.SESSION_COOKIE_KEYS,
      nowIso(),
    )) {
      return context.json({ error: "csrf_invalid" }, 403);
    }

    if (!getPlatformUserIds(context.env).has(session.userId)) {
      return browserEntry
        ? oauthError(context, "platform_access_denied", 403)
        : context.json({ error: "platform_access_denied" }, 403);
    }

    context.set("session", session);
    context.set("actor", { userId: session.userId, sessionId: session.sessionId });
    await next();
  },
);

export const requireChannelAuthorization = () => requireChannelAuthorizationFor(false);
export const requireBrowserChannelAuthorization = () => requireChannelAuthorizationFor(true);

export const requirePlatform = () => requirePlatformAuthorizationFor(false);
export const requireBrowserPlatformAuthorization = () => requirePlatformAuthorizationFor(true);

export const requireBrowserBotAuthorization = () => createMiddleware<SessionAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) {
      return context.redirect(loginRedirectForRequest(context.req.raw), 302);
    }

    const botIdentity = await getBotIdentity(context.env.DB);
    if (!canConnectBot(session, context.env, botIdentity)) {
      return oauthError(context, "bot_account_only_connects_itself", 403);
    }

    context.set("session", session);
    await next();
  },
);

export const requireSessionAuthorization = () => createMiddleware<SessionAuthorizationEnvironment>(
  async (context, next) => {
    const session = await getSessionFromRequest(context.req.raw, context.env);
    if (session === null) return context.json({ error: "session_missing" }, 401);
    context.set("session", session);
    await next();
  },
);
