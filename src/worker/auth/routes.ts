import { Hono } from "hono";

import {
  requireBrowserChannelAuthorization,
  requireBrowserBotAuthorization,
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "./guards";
import { oauthError } from "./oauth-error-texts";
import {
  consumeOAuthTransaction,
  failOAuthTransaction,
} from "../db/oauth-transactions";
import {
  createSession,
  revokeSession,
} from "../db/sessions";
import {
  getBotIdentity,
  upsertBotIdentityAndStatus,
} from "../db/bot-identity";
import {
  getLoginIdentity,
  hasFullConsentForChannelId,
  hasFullConsentForChannelLogin,
  upsertLoginIdentity,
} from "../db/login-identity";
import {
  exchangeAuthorizationCode,
  fetchTwitchUser,
  OAuthExchangeError,
  OAUTH_STATE_COOKIE_NAME,
  clearOAuthStateCookie,
  serializeOAuthStateCookie,
  startOAuthAuthorization,
  verifyOAuthState,
} from "./oauth";
import { encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./crypto";
import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  serializeCsrfCookie,
  verifyCsrfRequest,
  verifyCsrfToken,
} from "./csrf";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  clearSessionCookie,
  createSessionCookie,
  readCookieValue,
  serializeSessionCookie,
} from "./session";
import { getSessionFromRequest } from "./session-access";
import {
  authenticateOverlayToken,
  getActiveOverlayTokens,
  revokeOverlayToken,
} from "./overlay-token-service";
import { fetchTwitchUsersById } from "../twitch/user-resolution";
import { maintainBotIdentity } from "../bot-maintenance";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { revokeRealtimeSessionForUser } from "../realtime";
import { closeRealtimeTokenBeforeResponse } from "../realtime-revocation";
import { MODULES } from "../../modules/registry";
import {
  listAllBroadcasterScopes,
  listRequiredBroadcasterScopesForUserAndModule,
} from "../module-scopes";
import { canManage, type ApiErrorCode } from "../../contracts/values";
import { findChannelVariable } from "../db/channel-variables";
import { getOverlayBindingForToken } from "./overlay-token-repository";
import { getOverlayForChannel, getOverlayVariableValues } from "../db/overlays";
import { hydrateModuleOverlayElements } from "../overlays/module-state";
import { hydrateCachedAdsCountdownSnapshot } from "../overlays/ads-countdown-cache";
import { ADS_COUNTDOWN_ELEMENT_KIND } from "../../modules/ads/overlay/kinds";

const nowIso = (): string => new Date().toISOString();
const OVERLAY_VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

const canManageOverlayTokens = canManage;

const overlayTokenManageDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "overlay_token_manage_denied" }, 403);

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const redirectHome = (origin: string): string => `${origin.replace(/\/+$/, "")}/`;

const moduleDashboardPath = (channelId: string, moduleId: string): string =>
  `/channels/${encodeURIComponent(channelId)}/modules/${encodeURIComponent(moduleId)}`;

const isEncodedPathSegment = (segment: string): boolean => {
  if (segment.length === 0) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\") &&
      encodeURIComponent(decoded) === segment;
  } catch {
    return false;
  }
};

const isSafeLoginRedirectPath = (path: string | null | undefined): path is string => {
  if (path === undefined || path === null || path.startsWith("//") || !path.startsWith("/")) return false;
  const pathOnly = path.split(/[?#]/, 1)[0] ?? path;
  const segments = pathOnly.split("/");
  const safeModulePath = segments.length === 5 && segments[1] === "channels" && segments[3] === "modules" &&
    isEncodedPathSegment(segments[2] ?? "") && isEncodedPathSegment(segments[4] ?? "");
  const safeBotLoginPath = segments.length === 4 && segments[1] === "auth" && segments[2] === "bot" && segments[3] === "login";
  const safeChannelBotPath = segments.length === 5 && segments[1] === "auth" && segments[2] === "channels" &&
    isEncodedPathSegment(segments[3] ?? "") && segments[4] === "channel-bot";
  const safeBroadcasterScopePath = segments.length === 6 && segments[1] === "auth" && segments[2] === "channels" &&
    isEncodedPathSegment(segments[3] ?? "") && segments[4] === "broadcaster-scopes" &&
    isEncodedPathSegment(segments[5] ?? "");
  return path === "/" || safeModulePath || safeBotLoginPath || safeChannelBotPath || safeBroadcasterScopePath;
};

const redirectAfterLogin = (origin: string, path: string | null | undefined): string =>
  isSafeLoginRedirectPath(path) ? `${origin.replace(/\/+$/, "")}${path}` : redirectHome(origin);

const maintainAfterBotAuthorization = async (env: Env, now: string): Promise<void> => {
  try {
    await maintainBotIdentity(env, now);
  } catch {
    // The authorization is already stored; the hourly run remains the safety net.
  }
  try {
    await maintainEventSubSubscriptions(env, now);
  } catch {
    // Errors are logged by the maintenance run and must not break the callback.
  }
};

const maintainAfterBroadcasterAuthorization = async (env: Env, now: string): Promise<void> => {
  try {
    await maintainEventSubSubscriptions(env, now);
  } catch {
    // The reconciliation is retried in the hourly run; the consent remains stored.
  }
};

export const authRouter = new Hono<{ Bindings: Env; Variables: ChannelAuthorizationVariables }>();

export { getSessionFromRequest } from "./session-access";

interface JsonRecord {
  [key: string]: unknown;
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRevocationReason = async (request: Request): Promise<string | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text()) as unknown;
  } catch {
    return null;
  }
  if (!isJsonRecord(parsed) || typeof parsed.reason !== "string") return null;
  const reason = parsed.reason.trim();
  return reason.length > 0 && reason.length <= 200 ? reason : null;
};

const readBearerToken = (authorization: string | undefined): string | null => {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  return match?.[1] ?? null;
};

/**
 * Returns an already-valid token unchanged instead of issuing a new one on
 * every call. Cookie and header must match; if two tabs each fetch their own
 * token at different times, the second call overwrites the shared cookie
 * and the first tab then fails with 403 — among other things during logout,
 * which then revokes nothing even though the UI reports success.
 */
authRouter.get("/api/csrf", async (context) => {
  const session = await getSessionFromRequest(context.req.raw, context.env);
  if (session === null) return context.json({ error: "session_missing" }, 401);

  const now = nowIso();
  const existing = readCookieValue(context.req.raw.headers.get("Cookie"), CSRF_COOKIE_NAME);
  if (existing !== null && await verifyCsrfToken(
    existing,
    session.sessionId,
    context.env.SESSION_COOKIE_KEYS,
    now,
  )) {
    return context.json({ token: existing });
  }

  const token = await createCsrfToken(session.sessionId, context.env.SESSION_COOKIE_KEYS, now);
  context.header("Set-Cookie", serializeCsrfCookie(token));
  return context.json({ token });
});

authRouter.get(
  "/api/channels/:channelId/overlay-tokens",
  requireChannelAuthorization(),
  async (context) => {
    const offsetValue = context.req.query("offset");
    const offset = offsetValue === undefined ? 0 : Number(offsetValue);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
      return context.json({ error: "overlay_list_offset_invalid" }, 400);
    }
    const tokens = await getActiveOverlayTokens(context.env.DB, {
      channelId: context.req.param("channelId"),
      now: nowIso(),
      offset,
    });
    const creators = await fetchTwitchUsersById(
      fetch,
      context.env,
      [...new Set(tokens.tokens.flatMap((token) => token.createdByUserId === null ? [] : [token.createdByUserId]))],
    );
    context.header("Cache-Control", "no-store");
    return context.json({
      tokens: tokens.tokens.map((token) => ({
        id: token.tokenId,
        name: token.name,
        createdAt: token.createdAt,
        createdBy: token.createdByUserId === null ? null : creators.get(token.createdByUserId)?.displayName ?? null,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
      })),
      nextOffset: tokens.nextOffset,
    });
  },
);

authRouter.post(
  "/api/channels/:channelId/overlay-tokens/:tokenId/revoke",
  requireChannelAuthorization(),
  async (context) => {
    if (!canManageOverlayTokens(context.get("channelRole"))) return overlayTokenManageDenied(context);
    const channelId = context.req.param("channelId");
    const tokenId = context.req.param("tokenId");
    const reason = await readRevocationReason(context.req.raw);
    if (reason === null) return context.json({ error: "overlay_revocation_reason_invalid" }, 400);

    const revoked = await revokeOverlayToken(context.env.DB, {
      channelId,
      actor: {
        userId: context.get("session").userId,
        sessionId: context.get("session").sessionId,
      },
      tokenId,
      reason,
      revokedAt: nowIso(),
    });
    if (!revoked) return context.json({ error: "overlay_token_not_found" }, 404);
    const closed = await closeRealtimeTokenBeforeResponse(context.env.CHANNEL, channelId, tokenId);
    context.header("Cache-Control", "no-store");
    if (!closed) return context.json({ closingPending: true }, 202);
    return context.body(null, 204);
  },
);

authRouter.get("/api/overlay/bootstrap", async (context) => {
  context.header("Cache-Control", "no-store");
  const token = readBearerToken(context.req.header("Authorization"));
  if (token === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const record = await authenticateOverlayToken(context.env.DB, {
    token,
    pepper: context.env.OVERLAY_TOKEN_PEPPER,
    now: nowIso(),
  });
  if (record === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const overlayId = await getOverlayBindingForToken(context.env.DB, record.channelId, record.tokenId);
  if (overlayId === null) {
    return context.json({ language: record.language, overlay: null, variables: {} });
  }
  const overlay = await getOverlayForChannel(context.env.DB, record.channelId, overlayId);
  if (overlay === null) {
    return context.json({ language: record.language, overlay: null, variables: {} });
  }
  if (overlay.elements.some((element) => element.kind === ADS_COUNTDOWN_ELEMENT_KIND)) {
    await hydrateCachedAdsCountdownSnapshot(context.env, record.channelId);
  }
  const variables = await getOverlayVariableValues(context.env.DB, record.channelId, overlayId);
  const elements = await hydrateModuleOverlayElements(context.env.DB, record.channelId, overlay.elements);
  const responseNow = new Date().toISOString();
  return context.json({
    language: record.language,
    overlay: {
      id: overlay.id,
      revision: overlay.revision,
      width: overlay.width,
      height: overlay.height,
      css: overlay.css,
      elements: elements.map((element) => {
        const state = element.kind === ADS_COUNTDOWN_ELEMENT_KIND && element.state !== undefined && element.state !== null
          ? { ...element.state, serverNow: responseNow }
          : element.state;
        return {
          id: element.id,
          kind: element.kind,
          label: element.label,
          variableName: element.variableName,
          text: element.text,
          config: element.config,
          ...(element.moduleEnabled === undefined ? {} : { moduleEnabled: element.moduleEnabled }),
          ...(state === undefined ? {} : { state }),
          x: element.x,
          y: element.y,
          scalePercent: element.scalePercent,
          z: element.z,
          inComposition: element.inComposition,
        };
      }),
    },
    variables,
  });
});

authRouter.get("/api/overlay/variables/:name", async (context) => {
  context.header("Cache-Control", "no-store");
  const token = readBearerToken(context.req.header("Authorization"));
  if (token === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const record = await authenticateOverlayToken(context.env.DB, {
    token,
    pepper: context.env.OVERLAY_TOKEN_PEPPER,
    now: nowIso(),
  });
  if (record === null) return context.json({ error: "overlay_token_invalid" satisfies ApiErrorCode }, 401);

  const name = context.req.param("name");
  if (!OVERLAY_VARIABLE_NAME_PATTERN.test(name)) {
    return context.json({ error: "variable_data_invalid" satisfies ApiErrorCode }, 400);
  }
  const overlayId = await getOverlayBindingForToken(context.env.DB, record.channelId, record.tokenId);
  const variable = overlayId === null
    ? await findChannelVariable(context.env.DB, record.channelId, name)
    : await context.env.DB.prepare(
      `SELECT variable.name, variable.value
         FROM channel_variables AS variable
         JOIN overlay_elements AS element
           ON element.channel_id = variable.channel_id
          AND element.variable_name = variable.name
        WHERE variable.channel_id = ?
          AND element.overlay_id = ?
          AND variable.name = ?
        LIMIT 1`,
    ).bind(record.channelId, overlayId, name).first<{ name: string; value: number }>();
  if (variable === null) {
    return context.json({ error: "overlay_variable_not_found" satisfies ApiErrorCode }, 404);
  }

  context.header("Content-Language", record.language);
  return context.json({ name: variable.name, value: variable.value });
});

authRouter.get("/auth/login", async (context) => {
  const channelLogin = context.req.query("channel");
  const returnTo = context.req.query("returnTo");
  const fullConsent = channelLogin !== undefined && channelLogin.length > 0 &&
    await hasFullConsentForChannelLogin(context.env.DB, channelLogin);
  const scopes = fullConsent ? listAllBroadcasterScopes() : [];
  const started = await startOAuthAuthorization(
    context.env.DB,
    context.env,
    "login",
    nowIso(),
    scopes,
    false,
    isSafeLoginRedirectPath(returnTo) ? returnTo : null,
    false,
    null,
    context.req.query("switch") === "1",
  );
  context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
  return context.redirect(started.url, 302);
});

/**
 * Only the channel owner can re-request the missing channel:bot consent.
 * The member role is not enough for this: a broadcaster may still appoint a
 * delegate, but Twitch ties the consent to the identity.
 */
authRouter.get(
  "/auth/channels/:channelId/channel-bot",
  requireBrowserChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    if (context.get("session").userId !== channelId) {
      return oauthError(context, "channel_owner_only_consent_request", 403);
    }
    const started = await startOAuthAuthorization(
      context.env.DB,
      context.env,
      "login",
      nowIso(),
      [],
      false,
      null,
      false,
      channelId,
    );
    context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
    return context.redirect(started.url, 302);
  },
);

/**
 * Fetches the scopes of the requested registry module plus the additional
 * scopes from the enabled modules of the user's own broadcaster channels.
 * The request must not specify a scope list itself.
 */
authRouter.get(
  "/auth/channels/:channelId/broadcaster-scopes/:moduleId",
  requireBrowserChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    if (context.get("session").userId !== channelId) {
      return oauthError(context, "channel_owner_only_scope_grant", 403);
    }
    const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
    if (module === undefined) return oauthError(context, "module_not_found", 404);

    const scopes = await listRequiredBroadcasterScopesForUserAndModule(
      context.env.DB,
      context.get("session").userId,
      module,
    );
    const started = await startOAuthAuthorization(
      context.env.DB,
      context.env,
      "login",
      nowIso(),
      scopes,
      true,
      moduleDashboardPath(channelId, module.id),
      false,
      channelId,
    );
    context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
    return context.redirect(started.url, 302);
  },
);

/**
 * Only the bot account itself can start the installation-wide bot consent.
 * This prevents other signed-in Twitch accounts from ever reaching the consent
 * screen for bot scopes.
 */
authRouter.get("/auth/bot/login", requireBrowserBotAuthorization(), async (context) => {
  const started = await startOAuthAuthorization(context.env.DB, context.env, "bot", nowIso());
  context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
  return context.redirect(started.url, 302);
});

authRouter.get("/auth/twitch/callback", async (context) => {
  const serializedState = context.req.query("state");
  if (serializedState === undefined) return oauthError(context, "oauth_state_missing");

  const now = nowIso();
  const stateNonce = readCookieValue(context.req.raw.headers.get("Cookie"), OAUTH_STATE_COOKIE_NAME);
  const state = await verifyOAuthState(
    serializedState,
    context.env.SESSION_COOKIE_KEYS,
    now,
    stateNonce,
  );
  // The cookie is consumed in any case — even if the check fails — so that
  // an intercepted callback cannot be retried later.
  context.header("Set-Cookie", clearOAuthStateCookie());
  if (state === null) return oauthError(context, "oauth_state_invalid");

  const transaction = await consumeOAuthTransaction(context.env.DB, state.transactionId, now);
  if (transaction === null || transaction.purpose !== state.purpose) {
    return oauthError(context, "oauth_transaction_invalid");
  }

  const error = context.req.query("error");
  if (error !== undefined) {
    await failOAuthTransaction(context.env.DB, state.transactionId, "authorization_denied");
    return oauthError(context, "authorization_denied");
  }

  const code = context.req.query("code");
  if (code === undefined || code.length === 0) {
    await failOAuthTransaction(context.env.DB, state.transactionId, "authorization_code_missing");
    return oauthError(context, "oauth_code_missing");
  }

  try {
    const tokens = await exchangeAuthorizationCode(fetch, context.env, code);
    const identity = await fetchTwitchUser(fetch, context.env, tokens.accessToken);

    if (transaction.expectedUserId !== undefined && transaction.expectedUserId !== null &&
        identity.userId !== transaction.expectedUserId) {
      await failOAuthTransaction(context.env.DB, state.transactionId, "login_identity_user_mismatch");
      return oauthError(context, "identity_user_mismatch", 403);
    }

    if (state.purpose === "bot") {
      if (identity.login.toLowerCase() !== context.env.TWITCH_BOT_LOGIN.toLowerCase()) {
        await failOAuthTransaction(context.env.DB, state.transactionId, "bot_identity_mismatch");
        return oauthError(context, "bot_login_mismatch", 403);
      }
      const current = await getBotIdentity(context.env.DB);
      // The login is changeable and gets reassigned after a rename. If a
      // bot identity already exists, its user ID is authoritative: otherwise
      // someone could claim the freed-up name and have the bot post from
      // their account in every channel.
      if (current !== null && current.userId !== identity.userId) {
        await failOAuthTransaction(context.env.DB, state.transactionId, "bot_identity_user_mismatch");
        return oauthError(context, "bot_identity_mismatch", 403);
      }
      const encryptionKeys = getTokenEncryptionKeys(context.env);
      await upsertBotIdentityAndStatus(context.env.DB, {
        id: 1,
        userId: identity.userId,
        login: identity.login,
        scopesJson: JSON.stringify(tokens.scopes),
        accessTokenCiphertext: await encryptJson(
          { token: tokens.accessToken },
          parseKeyRing(encryptionKeys),
        ),
        refreshTokenCiphertext: await encryptJson(
          { token: tokens.refreshToken },
          parseKeyRing(encryptionKeys),
        ),
        expiresAt: new Date(Date.parse(now) + tokens.expiresIn * 1000).toISOString(),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      }, "connected", null, now);
      const maintenance = maintainAfterBotAuthorization(context.env, now);
      try {
        context.executionCtx.waitUntil(maintenance);
      } catch {
        // In tests or other runtimes without an ExecutionContext, the work continues running anyway.
        void maintenance;
      }
      return context.redirect(redirectHome(context.env.PUBLIC_ORIGIN), 302);
    }

    const vollumfang = listAllBroadcasterScopes();
    const isFullyConsentingChannel = await hasFullConsentForChannelId(
      context.env.DB,
      identity.userId,
    );
    const fehlen = vollumfang.some((scope) => !tokens.scopes.includes(scope));
    if (isFullyConsentingChannel && fehlen) {
      if (state.fullConsentSecondAttempt) {
        await failOAuthTransaction(
          context.env.DB,
          state.transactionId,
          "full_consent_second_attempt_incomplete",
        );
        return oauthError(context, "full_consent_second_attempt_incomplete", 403);
      }

      await failOAuthTransaction(
        context.env.DB,
        state.transactionId,
        "full_consent_incomplete",
      );
      const started = await startOAuthAuthorization(
        context.env.DB,
        context.env,
        "login",
        now,
        vollumfang,
        state.reconcileEventSub === true,
        transaction.redirectPath ?? null,
        true,
        transaction.expectedUserId ?? null,
      );
      context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
      return context.redirect(started.url, 302);
    }

    const expiresAt = new Date(Date.parse(now) + tokens.expiresIn * 1000).toISOString();
    const current = await getLoginIdentity(context.env.DB, identity.userId);
    const encryptionKeys = getTokenEncryptionKeys(context.env);
    await upsertLoginIdentity(context.env.DB, {
      userId: identity.userId,
      login: identity.login,
      scopesJson: JSON.stringify(tokens.scopes),
      tokenScopesJson: JSON.stringify(tokens.scopes),
      accessTokenCiphertext: await encryptJson(
        { token: tokens.accessToken },
        parseKeyRing(encryptionKeys),
      ),
      refreshTokenCiphertext: await encryptJson(
        { token: tokens.refreshToken },
        parseKeyRing(encryptionKeys),
      ),
      expiresAt,
      status: "connected",
      reason: null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });

    const sessionExpiresAt = new Date(Date.parse(now) + SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toISOString();
    const sessionId = randomId();
    await createSession(context.env.DB, {
      sessionId,
      userId: identity.userId,
      login: identity.login,
      expiresAt: sessionExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const cookie = await createSessionCookie(
      { sessionId },
      context.env.SESSION_COOKIE_KEYS,
      encryptionKeys,
    );
    context.header("Set-Cookie", serializeSessionCookie(cookie));
    if (state.reconcileEventSub) {
      const maintenance = maintainAfterBroadcasterAuthorization(context.env, now);
      try {
        context.executionCtx.waitUntil(maintenance);
      } catch {
        void maintenance;
      }
    }
    return context.redirect(redirectAfterLogin(context.env.PUBLIC_ORIGIN, transaction.redirectPath), 302);
  } catch (error) {
    await failOAuthTransaction(
      context.env.DB,
      state.transactionId,
      error instanceof OAuthExchangeError ? "code_exchange_rejected" : "callback_failed",
    );
    return error instanceof OAuthExchangeError
      ? oauthError(context, "code_exchange_rejected")
      : oauthError(context, "callback_failed", 502);
  }
});

authRouter.post("/auth/logout", async (context) => {
  const session = await getSessionFromRequest(context.req.raw, context.env);
  if (session === null) return context.json({ error: "session_missing" }, 401);
  if (!await verifyCsrfRequest(
    context.req.raw,
    session.sessionId,
    context.env.SESSION_COOKIE_KEYS,
    nowIso(),
  )) {
    return context.json({ error: "csrf_invalid" }, 403);
  }
  const now = nowIso();
  await revokeSession(context.env.DB, session.sessionId, now, "logout");
  void revokeRealtimeSessionForUser(context.env.DB, context.env.CHANNEL, session.userId, session.sessionId);
  context.header("Set-Cookie", clearSessionCookie());
  context.header("Set-Cookie", serializeCsrfCookie("", 0), { append: true });
  return context.body(null, 204);
});
