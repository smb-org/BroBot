import { parseKeyRing, signJson, verifyJson } from "./crypto";
import type { ModuleMutationAuthorization } from "../../modules/contract";
import {
  discordServerAuthorizationUrl,
  type DiscordEnvironment,
} from "../../modules/discord/adapters/discord";

export const DISCORD_SERVER_OAUTH_STATE_COOKIE = "__Host-brobot_discord_server_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;
const STATE_TTL_MS = STATE_TTL_SECONDS * 1000;

export interface DiscordServerOAuthState {
  stateId: string;
  channelId: string;
  memberUserId: string;
  nonce: string;
  expiresAt: string;
}

export interface DiscordServerOAuthTransaction {
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
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const beginDiscordServerOAuth = async (
  environment: DiscordEnvironment & Pick<Env, "DB" | "SESSION_COOKIE_KEYS">,
  channelId: string,
  memberUserId: string,
  redirectUri: string,
  now: string,
  authorization: ModuleMutationAuthorization,
): Promise<{ authorizationUrl: string; state: string; stateNonce: string; expiresAt: string }> => {
  if (!environment.DISCORD_CLIENT_ID || !environment.DISCORD_CLIENT_SECRET) {
    throw new Error("Discord server OAuth is not configured.");
  }
  const stateId = randomString(24);
  const nonce = randomString(24);
  const expiresAt = new Date(Date.parse(now) + STATE_TTL_MS).toISOString();
  const state = await signJson({ stateId, channelId, memberUserId, nonce, expiresAt }, parseKeyRing(environment.SESSION_COOKIE_KEYS));
  const results = await environment.DB.batch([
    environment.DB.prepare(`SELECT 1 AS authorized WHERE 1 = 1 ${authorization.sql}`).bind(...authorization.values),
    environment.DB.prepare(`DELETE FROM discord_server_oauth_transactions WHERE expires_at <= ? ${authorization.sql}`)
      .bind(now, ...authorization.values),
    environment.DB.prepare(
      `INSERT INTO discord_server_oauth_transactions
        (state_id, channel_id, member_user_id, nonce_hash, expires_at)
       SELECT ?, ?, ?, ?, ? WHERE 1 = 1 ${authorization.sql}
       RETURNING state_id`,
    ).bind(stateId, channelId, memberUserId, await sha256(nonce), expiresAt, ...authorization.values),
  ]);
  if ((results[0]?.results.length ?? 0) === 0 || (results[2]?.results.length ?? 0) === 0) {
    throw new Error("Discord server OAuth requires current channel management access.");
  }
  return {
    authorizationUrl: discordServerAuthorizationUrl(environment, redirectUri, state),
    state,
    stateNonce: nonce,
    expiresAt,
  };
};

export const verifyDiscordServerOAuthState = async (
  serialized: string,
  cookieNonce: string | null,
  cookieKeys: string,
  now: string,
): Promise<DiscordServerOAuthState | null> => {
  const value = await verifyJson<unknown>(serialized, parseKeyRing(cookieKeys));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.stateId !== "string" || state.stateId.length === 0 || typeof state.channelId !== "string" ||
      state.channelId.length === 0 || typeof state.memberUserId !== "string" || state.memberUserId.length === 0 ||
      typeof state.nonce !== "string" || typeof state.expiresAt !== "string" || !Number.isFinite(Date.parse(state.expiresAt)) ||
      Date.parse(state.expiresAt) <= Date.parse(now) || cookieNonce === null || !equalsConstantTime(state.nonce, cookieNonce)) {
    return null;
  }
  return {
    stateId: state.stateId,
    channelId: state.channelId,
    memberUserId: state.memberUserId,
    nonce: state.nonce,
    expiresAt: state.expiresAt,
  };
};

export const consumeDiscordServerOAuthTransaction = async (
  db: D1Database,
  state: DiscordServerOAuthState,
  now: string,
): Promise<DiscordServerOAuthTransaction | null> => {
  const row = await db.prepare(
    `UPDATE discord_server_oauth_transactions SET used_at = ?
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

export const discordServerOAuthStateCookie = (value: string): string =>
  `${DISCORD_SERVER_OAUTH_STATE_COOKIE}=${value}; Max-Age=${String(STATE_TTL_SECONDS)}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearDiscordServerOAuthStateCookie = (): string =>
  discordServerOAuthStateCookie("").replace(`Max-Age=${String(STATE_TTL_SECONDS)}`, "Max-Age=0");
