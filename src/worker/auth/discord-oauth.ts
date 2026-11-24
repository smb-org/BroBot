import { parseKeyRing, signJson, verifyJson } from "./crypto";
import { discordAuthorizationUrl, type DiscordEnvironment } from "../../modules/discord/adapters/discord";

export const DISCORD_OAUTH_STATE_COOKIE = "__Host-brobot_discord_oauth_state";
export const DISCORD_VIEWER_COOKIE = "__Host-brobot_discord_viewer";
export const DISCORD_CSRF_COOKIE = "__Host-brobot_discord_csrf";
const DISCORD_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const DISCORD_VIEWER_TTL_SECONDS = 30 * 60;
const DISCORD_OAUTH_STATE_TTL_MS = DISCORD_OAUTH_STATE_TTL_SECONDS * 1000;

interface DiscordOAuthState {
  stateId: string;
  nonce: string;
  expiresAt: string;
}

interface DiscordViewerSession {
  sessionId: string;
  discordUserId: string;
  expiresAt: string;
}

const encodeBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const randomString = (size: number): string => encodeBase64url(crypto.getRandomValues(new Uint8Array(size)));
const sha256 = async (value: string): Promise<string> =>
  encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

const equalsConstantTime = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

export const beginDiscordOAuth = async (
  db: D1Database,
  environment: DiscordEnvironment & { SESSION_COOKIE_KEYS: string },
  redirectUri: string,
  now: string,
): Promise<{ authorizationUrl: string; stateNonce: string }> => {
  if (!environment.DISCORD_CLIENT_ID || !environment.DISCORD_CLIENT_SECRET) {
    throw new Error("Discord OAuth is not configured.");
  }
  const stateId = randomString(24);
  const nonce = randomString(24);
  const expiresAt = new Date(Date.parse(now) + DISCORD_OAUTH_STATE_TTL_MS).toISOString();
  const state = await signJson({ stateId, nonce, expiresAt }, parseKeyRing(environment.SESSION_COOKIE_KEYS));
  await db.batch([
    db.prepare("DELETE FROM discord_oauth_transactions WHERE expires_at <= ?").bind(now),
    db.prepare(
      `INSERT INTO discord_oauth_transactions (state_id, nonce_hash, expires_at)
       VALUES (?, ?, ?)`,
    ).bind(stateId, await sha256(nonce), expiresAt),
  ]);
  return { authorizationUrl: discordAuthorizationUrl(environment, redirectUri, state), stateNonce: nonce };
};

export const verifyDiscordOAuthState = async (
  serialized: string,
  cookieNonce: string | null,
  cookieKeys: string,
  now: string,
): Promise<DiscordOAuthState | null> => {
  const value = await verifyJson<unknown>(serialized, parseKeyRing(cookieKeys));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.stateId !== "string" || state.stateId.length === 0 || typeof state.nonce !== "string" ||
      typeof state.expiresAt !== "string" || !Number.isFinite(Date.parse(state.expiresAt)) ||
      Date.parse(state.expiresAt) <= Date.parse(now) || cookieNonce === null || !equalsConstantTime(state.nonce, cookieNonce)) {
    return null;
  }
  return { stateId: state.stateId, nonce: state.nonce, expiresAt: state.expiresAt };
};

export const consumeDiscordOAuthTransaction = async (
  db: D1Database,
  state: DiscordOAuthState,
  now: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `UPDATE discord_oauth_transactions SET used_at = ?
      WHERE state_id = ? AND nonce_hash = ? AND used_at IS NULL
        AND julianday(expires_at) > julianday(?)
      RETURNING state_id`,
  ).bind(now, state.stateId, await sha256(state.nonce), now).first<{ state_id: string }>();
  return row !== null;
};

export const discordOAuthStateCookie = (value: string): string =>
  `${DISCORD_OAUTH_STATE_COOKIE}=${value}; Max-Age=${String(DISCORD_OAUTH_STATE_TTL_SECONDS)}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearDiscordOAuthStateCookie = (): string =>
  discordOAuthStateCookie("").replace(`Max-Age=${String(DISCORD_OAUTH_STATE_TTL_SECONDS)}`, "Max-Age=0");

export const createDiscordViewerSession = (
  discordUserId: string,
  now: string,
): DiscordViewerSession => ({
  sessionId: randomString(24),
  discordUserId,
  expiresAt: new Date(Date.parse(now) + DISCORD_VIEWER_TTL_SECONDS * 1000).toISOString(),
});

export const serializeDiscordViewerSession = async (
  session: DiscordViewerSession,
  cookieKeys: string,
): Promise<string> =>
  `${DISCORD_VIEWER_COOKIE}=${await signJson(session, parseKeyRing(cookieKeys))}; Max-Age=${String(DISCORD_VIEWER_TTL_SECONDS)}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearDiscordViewerSessionCookie = (): string =>
  `${DISCORD_VIEWER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const readDiscordViewerSession = async (
  serialized: string | null,
  cookieKeys: string,
  now: string,
): Promise<DiscordViewerSession | null> => {
  if (serialized === null) return null;
  const value = await verifyJson<unknown>(serialized, parseKeyRing(cookieKeys));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const session = value as Record<string, unknown>;
  const expiry = typeof session.expiresAt === "string" ? Date.parse(session.expiresAt) : Number.NaN;
  if (typeof session.sessionId !== "string" || session.sessionId.length === 0 ||
      typeof session.discordUserId !== "string" || session.discordUserId.length === 0 ||
      !Number.isFinite(expiry) || expiry <= Date.parse(now)) return null;
  return {
    sessionId: session.sessionId,
    discordUserId: session.discordUserId,
    expiresAt: new Date(expiry).toISOString(),
  };
};

export const discordCsrfCookie = (value: string, maxAge = DISCORD_VIEWER_TTL_SECONDS): string =>
  `${DISCORD_CSRF_COOKIE}=${value}; Max-Age=${String(maxAge)}; Path=/; Secure; SameSite=Lax`;

export const clearDiscordCsrfCookie = (): string => discordCsrfCookie("", 0);
