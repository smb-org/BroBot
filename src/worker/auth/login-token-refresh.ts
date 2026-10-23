import { getLoginIdentity, rotateLoginTokensForUser, type LoginIdentityRecord } from "../db/login-identity";
import { encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./crypto";
import { decryptStoredToken, refreshBotToken, TwitchApiError } from "../bot-maintenance";

export interface LoginTokenRefreshEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

const rotateLoginTokensWithRetry = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string,
  expiresAt: string,
  updatedAt: string,
  tokenScopesJson: string,
): Promise<boolean> => {
  const persist = (): Promise<boolean> => rotateLoginTokensForUser(
    env.DB,
    identity.userId,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    accessTokenCiphertext,
    refreshTokenCiphertext,
    expiresAt,
    updatedAt,
    identity.updatedAt,
    tokenScopesJson,
  );
  try {
    return await persist();
  } catch (firstError: unknown) {
    try {
      return await persist();
    } catch {
      throw firstError;
    }
  }
};

const isReplacementIdentity = (
  current: LoginIdentityRecord | null,
  expected: LoginIdentityRecord,
): current is LoginIdentityRecord => current !== null &&
  current.userId === expected.userId &&
  current.status === "connected" &&
  (current.accessTokenCiphertext !== expected.accessTokenCiphertext ||
    current.refreshTokenCiphertext !== expected.refreshTokenCiphertext);

const rereadReplacement = async (
  env: LoginTokenRefreshEnvironment,
  expected: LoginIdentityRecord,
): Promise<LoginIdentityRecord | null> => {
  const current = await getLoginIdentity(env.DB, expected.userId);
  return isReplacementIdentity(current, expected) ? current : null;
};

export const decryptLoginIdentityAccessToken = async (identity: LoginIdentityRecord, env: LoginTokenRefreshEnvironment): Promise<string | null> =>
  decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(env));

/** Refreshes and persists a login identity's rotated tokens for both maintenance and request paths. */
const refreshLoginIdentityTokensOnce = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<LoginIdentityRecord | null> => {
  const encryptionKeys = getTokenEncryptionKeys(env);
  const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, encryptionKeys);
  if (refreshToken === null) throw new Error("The login identity refresh token could not be decrypted.");

  let refreshed: Awaited<ReturnType<typeof refreshBotToken>>;
  try {
    refreshed = await refreshBotToken(fetcher, env, refreshToken);
  } catch (error: unknown) {
    if (error instanceof TwitchApiError && error.code === "invalid_grant") {
      const replacement = await rereadReplacement(env, identity);
      if (replacement !== null) return replacement;
    }
    throw error;
  }

  const keys = parseKeyRing(encryptionKeys);
  const accessTokenCiphertext = await encryptJson({ token: refreshed.accessToken }, keys);
  const refreshTokenCiphertext = await encryptJson({ token: refreshed.refreshToken }, keys);
  const expiresAt = new Date(Date.parse(now) + refreshed.expiresIn * 1_000).toISOString();
  let replaced: boolean;
  try {
    replaced = await rotateLoginTokensWithRetry(
      env,
      identity,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt,
      now,
      JSON.stringify(refreshed.scopes),
    );
  } catch (error: unknown) {
    const replacement = await rereadReplacement(env, identity);
    if (replacement !== null) return replacement;
    throw error;
  }
  if (!replaced) return rereadReplacement(env, identity);
  return await getLoginIdentity(env.DB, identity.userId);
};

const refreshFlights = new WeakMap<D1Database, Map<string, Promise<LoginIdentityRecord | null>>>();

/** Coalesces token refreshes per database and identity inside the current isolate. */
export const refreshLoginIdentityTokens = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<LoginIdentityRecord | null> => {
  let flights = refreshFlights.get(env.DB);
  if (flights === undefined) {
    flights = new Map();
    refreshFlights.set(env.DB, flights);
  }

  const existingFlight = flights.get(identity.userId);
  if (existingFlight !== undefined) return await existingFlight;

  const flight = refreshLoginIdentityTokensOnce(env, identity, now, fetcher);
  flights.set(identity.userId, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(identity.userId) === flight) flights.delete(identity.userId);
    if (flights.size === 0) refreshFlights.delete(env.DB);
  }
};
