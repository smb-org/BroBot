import { Hono } from "hono";

import {
  requireChannelAuthorization,
  requireSessionAuthorization,
  type ChannelAuthorizationVariables,
} from "./guards";
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
  hatVollzustimmungFürKanalId,
  hatVollzustimmungFürKanalLogin,
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
  issueOverlayToken,
  revokeOverlayToken,
} from "./overlay-token-service";
import { maintainBotIdentity } from "../bot-maintenance";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { revokeRealtimeSessionForUser, revokeRealtimeToken } from "../realtime";
import { MODULES } from "../../modules/registry";
import {
  listeAlleBroadcasterScopes,
  listRequiredBroadcasterScopesForUserAndModule,
} from "../module-scopes";

const nowIso = (): string => new Date().toISOString();

const canManageOverlayTokens = (role: ChannelAuthorizationVariables["channelRole"]): boolean =>
  role === "broadcaster" || role === "verwalter";

const overlayTokenManageDenied = (context: { text: (body: string, status: 403) => Response }): Response =>
  context.text("Nur Broadcaster und Verwalter dürfen Overlay-Token verwalten.", 403);

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

const isSafeModuleRedirectPath = (path: string | null | undefined): path is string => {
  if (path === undefined || path === null || path.startsWith("//") || !path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.length === 5 && segments[1] === "channels" && segments[3] === "modules" &&
    isEncodedPathSegment(segments[2] ?? "") && isEncodedPathSegment(segments[4] ?? "");
};

const redirectAfterLogin = (origin: string, path: string | null | undefined): string =>
  isSafeModuleRedirectPath(path) ? `${origin.replace(/\/+$/, "")}${path}` : redirectHome(origin);

const maintainAfterBotAuthorization = async (env: Env, now: string): Promise<void> => {
  try {
    await maintainBotIdentity(env, now);
  } catch {
    // Die Autorisierung ist bereits gespeichert; der Stundenlauf bleibt das Sicherheitsnetz.
  }
  try {
    await maintainEventSubSubscriptions(env, now);
  } catch {
    // Fehler werden vom Wartungslauf protokolliert und duerfen den Callback nicht kippen.
  }
};

const maintainAfterBroadcasterAuthorization = async (env: Env, now: string): Promise<void> => {
  try {
    await maintainEventSubSubscriptions(env, now);
  } catch {
    // Der Abgleich wird im Stundenlauf erneut versucht; die Zustimmung bleibt gespeichert.
  }
};

const oauthError = (
  context: { text: (body: string, status: 400 | 403) => Response },
  message: string,
  status: 400 | 403 = 400,
): Response => context.text(message, status);

export const authRouter = new Hono<{ Bindings: Env; Variables: ChannelAuthorizationVariables }>();

export { getSessionFromRequest } from "./session-access";

interface JsonRecord {
  [key: string]: unknown;
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface OverlayTokenExpiry {
  valid: boolean;
  expiresAt: string | null;
  checkedAt: string;
}

const readOverlayTokenExpiry = async (
  request: Request,
): Promise<OverlayTokenExpiry> => {
  const body = await request.text();
  const checkedAt = nowIso();
  if (body.trim().length === 0) return { valid: true, expiresAt: null, checkedAt };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { valid: false, expiresAt: null, checkedAt };
  }
  if (!isJsonRecord(parsed) || parsed.expiresAt === undefined || parsed.expiresAt === null) {
    return isJsonRecord(parsed)
      ? { valid: true, expiresAt: null, checkedAt }
      : { valid: false, expiresAt: null, checkedAt };
  }
  if (typeof parsed.expiresAt !== "string") return { valid: false, expiresAt: null, checkedAt };
  const expiresTimestamp = Date.parse(parsed.expiresAt);
  const nowTimestamp = Date.parse(checkedAt);
  if (!Number.isFinite(expiresTimestamp) || !Number.isFinite(nowTimestamp) || expiresTimestamp <= nowTimestamp) {
    return { valid: false, expiresAt: null, checkedAt };
  }
  return { valid: true, expiresAt: new Date(expiresTimestamp).toISOString(), checkedAt };
};

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
 * Gibt ein bereits gueltiges Token unveraendert zurueck, statt bei jedem Aufruf
 * ein neues auszustellen. Cookie und Header muessen uebereinstimmen; holen zwei
 * Tabs zeitversetzt je ein eigenes Token, ueberschreibt der zweite Aufruf das
 * gemeinsame Cookie und der erste Tab scheitert danach mit 403 — unter anderem
 * beim Logout, der dann nichts widerruft, obwohl die Oberflaeche es meldet.
 */
authRouter.get("/api/csrf", async (context) => {
  const session = await getSessionFromRequest(context.req.raw, context.env);
  if (session === null) return context.text("Session fehlt.", 401);

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

authRouter.post(
  "/api/channels/:channelId/overlay-tokens",
  requireChannelAuthorization(),
  async (context) => {
    if (!canManageOverlayTokens(context.get("channelRole"))) return overlayTokenManageDenied(context);
    const channelId = context.req.param("channelId");

    const expiry = await readOverlayTokenExpiry(context.req.raw);
    if (!expiry.valid) return context.json({ error: "Ablaufzeit ist ungültig." }, 400);
    const now = expiry.checkedAt;

    const issued = await issueOverlayToken(context.env.DB, {
      channelId,
      actor: {
        userId: context.get("session").userId,
        sessionId: context.get("session").sessionId,
      },
      pepper: context.env.OVERLAY_TOKEN_PEPPER,
      publicOrigin: context.env.PUBLIC_ORIGIN,
      expiresAt: expiry.expiresAt,
      createdAt: now,
    });
    if (issued === null) return context.text("Kanalzugriff verweigert.", 403);
    context.header("Cache-Control", "no-store");
    return context.json(issued, 201);
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
    if (reason === null) return context.json({ error: "Widerrufsgrund fehlt oder ist ungültig." }, 400);

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
    if (!revoked) return context.text("Overlay-Token nicht gefunden.", 404);
    void revokeRealtimeToken(context.env.CHANNEL, channelId, tokenId);
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  },
);

authRouter.get("/api/overlay/status", async (context) => {
  const token = readBearerToken(context.req.header("Authorization"));
  if (token === null) return context.json({ error: "Overlay-Zugang ungültig." }, 401);

  const record = await authenticateOverlayToken(context.env.DB, {
    token,
    pepper: context.env.OVERLAY_TOKEN_PEPPER,
    now: nowIso(),
  });
  if (record === null) return context.json({ error: "Overlay-Zugang ungültig." }, 401);

  context.header("Cache-Control", "no-store");
  return context.json({ version: context.env.CF_VERSION_METADATA.id, language: record.language });
});

authRouter.get("/auth/login", async (context) => {
  const kanalLogin = context.req.query("kanal");
  const vollzustimmung = kanalLogin !== undefined && kanalLogin.length > 0 &&
    await hatVollzustimmungFürKanalLogin(context.env.DB, kanalLogin);
  const scopes = vollzustimmung ? listeAlleBroadcasterScopes() : [];
  const started = await startOAuthAuthorization(
    context.env.DB,
    context.env,
    "login",
    nowIso(),
    scopes,
  );
  context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
  return context.redirect(started.url, 302);
});

/**
 * Die fehlende channel:bot-Zustimmung kann nur der Kanalinhaber nachfordern.
 * Die Mitgliedsrolle reicht dafür nicht: Ein Broadcaster darf weiterhin einen
 * Vertreter benennen, aber Twitch bindet die Zustimmung an die Identität.
 */
authRouter.get(
  "/auth/channels/:channelId/channel-bot",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    if (context.get("session").userId !== channelId) {
      return context.text("Nur der Kanalinhaber darf diese Zustimmung nachfordern.", 403);
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
 * Holt die Scopes des angeforderten Registry-Moduls sowie die Zusatz-Scopes
 * aus den aktivierten Modulen der eigenen Broadcaster-Kanäle. Der Request darf
 * keine Scope-Liste vorgeben.
 */
authRouter.get(
  "/auth/channels/:channelId/broadcaster-scopes/:moduleId",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    if (context.get("session").userId !== channelId) {
      return context.text("Nur der Kanalinhaber darf diese Zustimmung erteilen.", 403);
    }
    const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
    if (module === undefined) return context.text("Modul nicht gefunden.", 404);

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
 * Verlangt eine Session: Ohne diese Pruefung kann jeder den Bot-Verbindungsfluss
 * starten und damit bestimmen, welches Twitch-Konto der Bot benutzt.
 */
authRouter.get("/auth/bot/login", requireSessionAuthorization(), async (context) => {
  const started = await startOAuthAuthorization(context.env.DB, context.env, "bot", nowIso());
  context.header("Set-Cookie", serializeOAuthStateCookie(started.stateNonce));
  return context.redirect(started.url, 302);
});

authRouter.get("/auth/twitch/callback", async (context) => {
  const serializedState = context.req.query("state");
  if (serializedState === undefined) return oauthError(context, "OAuth-State fehlt.");

  const now = nowIso();
  const stateNonce = readCookieValue(context.req.raw.headers.get("Cookie"), OAUTH_STATE_COOKIE_NAME);
  const state = await verifyOAuthState(
    serializedState,
    context.env.SESSION_COOKIE_KEYS,
    now,
    stateNonce,
  );
  // Das Cookie ist in jedem Fall verbraucht — auch wenn die Pruefung scheitert,
  // damit ein abgefangener Callback nicht spaeter erneut versucht werden kann.
  context.header("Set-Cookie", clearOAuthStateCookie());
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

    if (transaction.expectedUserId !== undefined && transaction.expectedUserId !== null &&
        identity.userId !== transaction.expectedUserId) {
      await failOAuthTransaction(context.env.DB, state.transactionId, "login_identity_user_mismatch");
      return oauthError(context, "Die Twitch-Identität gehört nicht zum Kanalinhaber.", 403);
    }

    if (state.purpose === "bot") {
      if (identity.login.toLowerCase() !== context.env.TWITCH_BOT_LOGIN.toLowerCase()) {
        await failOAuthTransaction(context.env.DB, state.transactionId, "bot_identity_mismatch");
        return oauthError(context, "Der Twitch-Login gehört nicht zum konfigurierten Bot.", 403);
      }
      const current = await getBotIdentity(context.env.DB);
      // Der Login ist aenderbar und wird nach einer Umbenennung neu vergeben.
      // Steht bereits eine Bot-Identitaet, ist ihre User-ID massgeblich: sonst
      // koennte sich jemand den frei gewordenen Namen sichern und den Bot in
      // allen Kanaelen aus seinem Konto posten lassen.
      if (current !== null && current.userId !== identity.userId) {
        await failOAuthTransaction(context.env.DB, state.transactionId, "bot_identity_user_mismatch");
        return oauthError(
          context,
          "Der Twitch-Login gehört nicht zur hinterlegten Bot-Identität.",
          403,
        );
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
        // In Tests oder anderen runtimes ohne ExecutionContext laeuft die Arbeit weiter.
        void maintenance;
      }
      return context.redirect(redirectHome(context.env.PUBLIC_ORIGIN), 302);
    }

    const vollumfang = listeAlleBroadcasterScopes();
    const istVollzustimmenderKanal = await hatVollzustimmungFürKanalId(
      context.env.DB,
      identity.userId,
    );
    const fehlen = vollumfang.some((scope) => !tokens.scopes.includes(scope));
    if (istVollzustimmenderKanal && fehlen) {
      if (state.vollzustimmungZweiterVersuch) {
        await failOAuthTransaction(
          context.env.DB,
          state.transactionId,
          "vollzustimmung_zweiter_versuch_unvollständig",
        );
        return oauthError(
          context,
          "Die vollständige Zustimmung für diesen Kanal wurde nicht erteilt.",
          403,
        );
      }

      await failOAuthTransaction(
        context.env.DB,
        state.transactionId,
        "vollzustimmung_unvollständig",
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
    if (error instanceof OAuthExchangeError) return oauthError(context, error.message);
    return context.text("Twitch-Autorisierung konnte nicht abgeschlossen werden.", 502);
  }
});

authRouter.post("/auth/logout", async (context) => {
  const session = await getSessionFromRequest(context.req.raw, context.env);
  if (session === null) return context.text("Session fehlt.", 401);
  if (!await verifyCsrfRequest(
    context.req.raw,
    session.sessionId,
    context.env.SESSION_COOKIE_KEYS,
    nowIso(),
  )) {
    return context.text("CSRF-Token fehlt oder ist ungültig.", 403);
  }
  const now = nowIso();
  await revokeSession(context.env.DB, session.sessionId, now, "logout");
  void revokeRealtimeSessionForUser(context.env.DB, context.env.CHANNEL, session.userId, session.sessionId);
  context.header("Set-Cookie", clearSessionCookie());
  context.header("Set-Cookie", serializeCsrfCookie("", 0), { append: true });
  return context.body(null, 204);
});
