import { signJson, verifyJson, parseKeyRing } from "./crypto";
import { spotifyAuthorizationUrl, type SpotifyEnvironment } from "../../modules/song_requests/adapters/spotify";

export const SPOTIFY_OAUTH_STATE_COOKIE = "__Host-brobot_spotify_oauth_state";
const STATE_TTL_MS = 10 * 60_000;

export interface SpotifyOAuthState {
  stateId: string;
  channelId: string;
  memberUserId: string;
  nonce: string;
  expiresAt: string;
}

export interface SpotifyOAuthTransaction {
  stateId: string;
  channelId: string;
  memberUserId: string;
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

export const beginSpotifyOAuth = async (
  db: D1Database,
  environment: SpotifyEnvironment & { SESSION_COOKIE_KEYS: string },
  channelId: string,
  memberUserId: string,
  redirectUri: string,
  now: string,
): Promise<{ authorizationUrl: string; stateNonce: string; expiresAt: string }> => {
  if (!environment.SPOTIFY_CLIENT_ID || !environment.SPOTIFY_CLIENT_SECRET) {
    throw new Error("Spotify OAuth is not configured.");
  }
  const stateId = randomString(24);
  const nonce = randomString(24);
  const expiresAt = new Date(Date.parse(now) + STATE_TTL_MS).toISOString();
  const state = await signJson({ stateId, channelId, memberUserId, nonce, expiresAt }, parseKeyRing(environment.SESSION_COOKIE_KEYS));
  await db.prepare(
    `INSERT INTO spotify_oauth_transactions
      (state_id, channel_id, member_user_id, nonce_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(stateId, channelId, memberUserId, await sha256(nonce), expiresAt).run();
  return {
    authorizationUrl: spotifyAuthorizationUrl(environment, redirectUri, state),
    stateNonce: nonce,
    expiresAt,
  };
};

export const spotifyOAuthStateCookie = (value: string): string =>
  `${SPOTIFY_OAUTH_STATE_COOKIE}=${value}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearSpotifyOAuthStateCookie = (): string => spotifyOAuthStateCookie("").replace("Max-Age=600", "Max-Age=0");

export const verifySpotifyOAuthState = async (
  serialized: string,
  cookieNonce: string | null,
  cookieKeys: string,
  now: string,
): Promise<SpotifyOAuthState | null> => {
  const value = await verifyJson<unknown>(serialized, parseKeyRing(cookieKeys));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.stateId !== "string" || typeof state.channelId !== "string" ||
      typeof state.memberUserId !== "string" || typeof state.nonce !== "string" ||
      typeof state.expiresAt !== "string" || !Number.isFinite(Date.parse(state.expiresAt)) ||
      Date.parse(state.expiresAt) <= Date.parse(now) || cookieNonce === null ||
      !equalsConstantTime(state.nonce, cookieNonce)) return null;
  return {
    stateId: state.stateId,
    channelId: state.channelId,
    memberUserId: state.memberUserId,
    nonce: state.nonce,
    expiresAt: state.expiresAt,
  };
};

export const consumeSpotifyOAuthTransaction = async (
  db: D1Database,
  state: SpotifyOAuthState,
  now: string,
): Promise<SpotifyOAuthTransaction | null> => {
  const row = await db.prepare(
    `UPDATE spotify_oauth_transactions SET used_at = ?
      WHERE state_id = ? AND channel_id = ? AND member_user_id = ? AND nonce_hash = ?
        AND used_at IS NULL AND julianday(expires_at) > julianday(?)
      RETURNING state_id, channel_id, member_user_id`,
  ).bind(now, state.stateId, state.channelId, state.memberUserId, await sha256(state.nonce), now)
    .first<{ state_id: string; channel_id: string; member_user_id: string }>();
  return row === null ? null : {
    stateId: row.state_id,
    channelId: row.channel_id,
    memberUserId: row.member_user_id,
  };
};
