import { Hono } from "hono";

import {
  consumeOAuthTransaction,
  createSession,
  failOAuthTransaction,
  getBotIdentity,
  getLoginIdentity,
  getSession,
  getSessionWithLoginIdentity,
  revokeSession,
  setBotIdentityStatus,
  upsertLoginIdentity,
  upsertBotIdentity,
} from "./repository";
import type { SessionRecord } from "./repository";
import {
  exchangeAuthorizationCode,
  fetchTwitchUser,
  OAuthExchangeError,
  startOAuthAuthorization,
  verifyOAuthState,
} from "./oauth";
import { encryptJson, parseKeyRing } from "./crypto";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSessionCookie,
  readCookieValue,
  readSessionCookie,
  serializeSessionCookie,
} from "./session";

const nowIso = (): string => new Date().toISOString();

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const redirectHome = (origin: string): string => `${origin.replace(/\/+$/, "")}/`;

const oauthError = (
  context: { text: (body: string, status: 400 | 403) => Response },
  message: string,
  status: 400 | 403 = 400,
): Response => context.text(message, status);

export const authRouter = new Hono<{ Bindings: Env }>();

authRouter.get("/auth/login", async (context) => {
  const started = await startOAuthAuthorization(context.env.DB, context.env, "login", nowIso());
  return context.redirect(started.url, 302);
});

authRouter.get("/auth/bot/login", async (context) => {
  const started = await startOAuthAuthorization(context.env.DB, context.env, "bot", nowIso());
  return context.redirect(started.url, 302);
});

authRouter.get("/auth/twitch/callback", async (context) => {
  const serializedState = context.req.query("state");
  if (serializedState === undefined) return oauthError(context, "OAuth-State fehlt.");

  const now = nowIso();
  const state = await verifyOAuthState(serializedState, context.env.SESSION_COOKIE_KEYS, now);
  if (state === null) return oauthError(context, "OAuth-State ist ungültig oder abgelaufen.");

  const transaction = await consumeOAuthTransaction(context.env.DB, state.transactionId, now);
  if (transaction === null || transaction.purpose !== state.purpose) {
    return oauthError(context, "OAuth-Transaktion ist ungültig oder wurde bereits verwendet.");
  }

  const error = context.req.query("error");
  if (error !== undefined) {
    await failOAuthTransaction(context.env.DB, state.transactionId, "authorization_denied");
    return oauthError(context, "Twitch-Autorisierung wurde abgelehnt.");
  }

  const code = context.req.query("code");
  if (code === undefined || code.length === 0) {
    await failOAuthTransaction(context.env.DB, state.transactionId, "authorization_code_missing");
    return oauthError(context, "OAuth-Code fehlt.");
  }

  try {
    const tokens = await exchangeAuthorizationCode(fetch, context.env, code);
    const identity = await fetchTwitchUser(fetch, context.env, tokens.accessToken);

    if (state.purpose === "bot") {
      if (identity.login.toLowerCase() !== context.env.TWITCH_BOT_LOGIN.toLowerCase()) {
        await failOAuthTransaction(context.env.DB, state.transactionId, "bot_identity_mismatch");
        return oauthError(context, "Der Twitch-Login gehört nicht zum konfigurierten Bot.", 403);
      }
      const current = await getBotIdentity(context.env.DB);
      await upsertBotIdentity(context.env.DB, {
        id: 1,
        userId: identity.userId,
        login: identity.login,
        scopesJson: JSON.stringify(tokens.scopes),
        accessTokenCiphertext: await encryptJson(
          { token: tokens.accessToken },
          parseKeyRing(context.env.SESSION_ENCRYPTION_KEYS),
        ),
        refreshTokenCiphertext: await encryptJson(
          { token: tokens.refreshToken },
          parseKeyRing(context.env.SESSION_ENCRYPTION_KEYS),
        ),
        expiresAt: new Date(Date.parse(now) + tokens.expiresIn * 1000).toISOString(),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      await setBotIdentityStatus(context.env.DB, "connected", null, now);
      return context.redirect(redirectHome(context.env.PUBLIC_ORIGIN), 302);
    }

    const expiresAt = new Date(Date.parse(now) + tokens.expiresIn * 1000).toISOString();
    const current = await getLoginIdentity(context.env.DB, identity.userId);
    await upsertLoginIdentity(context.env.DB, {
      userId: identity.userId,
      login: identity.login,
      scopesJson: JSON.stringify(tokens.scopes),
      accessTokenCiphertext: await encryptJson(
        { token: tokens.accessToken },
        parseKeyRing(context.env.SESSION_ENCRYPTION_KEYS),
      ),
      refreshTokenCiphertext: await encryptJson(
        { token: tokens.refreshToken },
        parseKeyRing(context.env.SESSION_ENCRYPTION_KEYS),
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
      context.env.SESSION_ENCRYPTION_KEYS,
    );
    context.header("Set-Cookie", serializeSessionCookie(cookie));
    return context.redirect(redirectHome(context.env.PUBLIC_ORIGIN), 302);
  } catch (error) {
    await failOAuthTransaction(
      context.env.DB,
      state.transactionId,
      error instanceof OAuthExchangeError ? "code_exchange_rejected" : "callback_failed",
    );
    if (error instanceof OAuthExchangeError) return oauthError(context, error.message);
    return context.text("Twitch-Autorisierung konnte nicht abgeschlossen werden.", 502);
  }
});

authRouter.get("/auth/logout", async (context) => {
  const serialized = readCookieValue(context.req.header("Cookie") ?? null, SESSION_COOKIE_NAME);
  if (serialized !== null) {
    const now = nowIso();
    const session = await readSessionCookie(
      serialized,
      context.env.SESSION_COOKIE_KEYS,
      context.env.SESSION_ENCRYPTION_KEYS,
    );
    if (session !== null) {
      const stored = await getSession(context.env.DB, session.sessionId);
      if (stored !== null && stored.revokedAt === null) {
        await revokeSession(context.env.DB, session.sessionId, now, "logout");
      }
    }
  }
  context.header("Set-Cookie", clearSessionCookie());
  return context.body(null, 204);
});

export const getSessionFromRequest = async (
  request: Request,
  env: Env,
): Promise<SessionRecord | null> => {
  const serialized = readCookieValue(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (serialized === null) return null;
  const session = await readSessionCookie(
    serialized,
    env.SESSION_COOKIE_KEYS,
    env.SESSION_ENCRYPTION_KEYS,
  );
  if (session === null) return null;
  const stored = await getSessionWithLoginIdentity(env.DB, session.sessionId);
  if (stored === null || stored.revokedAt !== null || Date.parse(stored.expiresAt) <= Date.now()) return null;
  return stored;
};
