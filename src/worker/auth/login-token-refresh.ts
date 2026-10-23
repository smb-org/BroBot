import {
  acquireLoginIdentityRefreshLease,
  getLoginIdentity,
  getLoginIdentityRefreshState,
  releaseLoginIdentityRefreshLease,
  rotateLoginTokensForUser,
  type LoginIdentityRecord,
} from "../db/login-identity";
import { markLoginRevoked } from "../login-revocation";
import { encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./crypto";
import { decryptStoredToken, refreshBotToken, TwitchApiError } from "../bot-maintenance";

export interface LoginTokenRefreshEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  CHANNEL?: Env["CHANNEL"] | undefined;
}

export interface LoginTokenRefreshLeaseOptions {
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const LOGIN_TOKEN_REFRESH_LEASE_MS = 30_000;
const LOGIN_TOKEN_REFRESH_WAIT_MS = 3_000;
const LOGIN_TOKEN_REFRESH_POLL_MS = 100;

const rotateLoginTokensWithRetry = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  owner: string,
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
    owner,
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
): boolean => current !== null &&
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

export const decryptLoginIdentityAccessToken = async (
  identity: LoginIdentityRecord,
  env: LoginTokenRefreshEnvironment,
): Promise<string | null> => decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(env));

const leaseOwnerMatches = (
  state: Awaited<ReturnType<typeof getLoginIdentityRefreshState>>,
  identity: LoginIdentityRecord,
  owner: string,
  now: number,
): boolean => state !== null &&
  state.refreshLeaseOwner === owner &&
  state.refreshLeaseUntil !== null &&
  state.refreshLeaseUntil >= now &&
  state.identity.accessTokenCiphertext === identity.accessTokenCiphertext &&
  state.identity.refreshTokenCiphertext === identity.refreshTokenCiphertext;

const waitForReplacementOrLease = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  owner: string,
  options: LoginTokenRefreshLeaseOptions,
): Promise<{ acquired: boolean; identity: LoginIdentityRecord | null; retriedExpiredLease: boolean }> => {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = clock() + LOGIN_TOKEN_REFRESH_WAIT_MS;
  let retriedExpiredLease = false;

  while (clock() <= deadline) {
    const state = await getLoginIdentityRefreshState(env.DB, identity.userId);
    if (state === null) return { acquired: false, identity: null, retriedExpiredLease };
    if (isReplacementIdentity(state.identity, identity) || state.identity.status === "revoked") {
      return { acquired: false, identity: state.identity, retriedExpiredLease };
    }

    const now = clock();
    if (!retriedExpiredLease && (state.refreshLeaseUntil === null || state.refreshLeaseUntil < now)) {
      retriedExpiredLease = true;
      const acquired = await acquireLoginIdentityRefreshLease(
        env.DB,
        identity.userId,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
        owner,
        now + LOGIN_TOKEN_REFRESH_LEASE_MS,
        now,
      );
      if (acquired) return { acquired: true, identity: state.identity, retriedExpiredLease };
    }

    const remaining = deadline - clock();
    if (remaining <= 0) return { acquired: false, identity: state.identity, retriedExpiredLease };
    await sleep(Math.min(LOGIN_TOKEN_REFRESH_POLL_MS, remaining));
  }
  return { acquired: false, identity: null, retriedExpiredLease };
};

const refreshLoginIdentityTokensOnce = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  now: string,
  fetcher: typeof fetch,
  leaseOptions: LoginTokenRefreshLeaseOptions,
): Promise<LoginIdentityRecord | null> => {
  const clock = leaseOptions.clock ?? Date.now;
  const owner = crypto.randomUUID();
  const acquiredAt = clock();
  let acquired = await acquireLoginIdentityRefreshLease(
    env.DB,
    identity.userId,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    owner,
    acquiredAt + LOGIN_TOKEN_REFRESH_LEASE_MS,
    acquiredAt,
  );

  if (!acquired) {
    const waiting = await waitForReplacementOrLease(env, identity, owner, leaseOptions);
    if (!waiting.acquired) {
      if (waiting.identity !== null && (
        isReplacementIdentity(waiting.identity, identity) || waiting.identity.status === "revoked"
      )) return waiting.identity;

      const finalState = await getLoginIdentityRefreshState(env.DB, identity.userId);
      if (finalState === null) return null;
      if (isReplacementIdentity(finalState.identity, identity) || finalState.identity.status === "revoked") {
        return finalState.identity;
      }

      const currentTime = clock();
      if (!waiting.retriedExpiredLease &&
          (finalState.refreshLeaseUntil === null || finalState.refreshLeaseUntil < currentTime)) {
        acquired = await acquireLoginIdentityRefreshLease(
          env.DB,
          identity.userId,
          identity.accessTokenCiphertext,
          identity.refreshTokenCiphertext,
          owner,
          currentTime + LOGIN_TOKEN_REFRESH_LEASE_MS,
          currentTime,
        );
      }
      if (!acquired) throw new Error("The login token refresh lease is currently held by another isolate.");
    }
  }

  try {
    const state = await getLoginIdentityRefreshState(env.DB, identity.userId);
    if (state === null) return null;
    if (isReplacementIdentity(state.identity, identity) || state.identity.status === "revoked") return state.identity;
    if (!leaseOwnerMatches(state, identity, owner, clock())) {
      throw new Error("The login token refresh lease changed before the token endpoint call.");
    }

    const encryptionKeys = getTokenEncryptionKeys(env);
    const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, encryptionKeys);
    if (refreshToken === null) throw new Error("The login identity refresh token could not be decrypted.");

    const beforeRequest = await getLoginIdentityRefreshState(env.DB, identity.userId);
    if (beforeRequest === null) return null;
    if (isReplacementIdentity(beforeRequest.identity, identity) || beforeRequest.identity.status === "revoked") {
      return beforeRequest.identity;
    }
    if (!leaseOwnerMatches(beforeRequest, identity, owner, clock())) {
      throw new Error("The login token refresh lease expired before the token endpoint call.");
    }

    let refreshed: Awaited<ReturnType<typeof refreshBotToken>>;
    try {
      refreshed = await refreshBotToken(fetcher, env, refreshToken);
    } catch (error: unknown) {
      if (error instanceof TwitchApiError && error.code === "invalid_grant") {
        const current = await getLoginIdentityRefreshState(env.DB, identity.userId);
        const leaseNow = clock();
        if (leaseOwnerMatches(current, identity, owner, leaseNow) && current !== null) {
          let notificationError: unknown;
          try {
            await markLoginRevoked(env, current.identity, now, "authorization_revoked", { owner, now: leaseNow });
          } catch (error: unknown) {
            notificationError = error;
          }
          const latest = await getLoginIdentityRefreshState(env.DB, identity.userId);
          if (latest === null) return null;
          if (latest.identity.status === "revoked") {
            if (notificationError !== undefined) {
              if (notificationError instanceof Error) throw notificationError;
              throw error;
            }
            return latest.identity;
          }
          if (isReplacementIdentity(latest.identity, identity)) return latest.identity;
          throw new Error("The login token refresh lease changed during invalid_grant handling.", { cause: error });
        }
        if (current !== null && isReplacementIdentity(current.identity, identity)) return current.identity;
        if (current !== null && current.identity.status !== "connected") return current.identity;
        throw new Error("The login token refresh lease changed after invalid_grant.", { cause: error });
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
        owner,
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
    if (!replaced) return await rereadReplacement(env, identity);
    return await getLoginIdentity(env.DB, identity.userId);
  } finally {
    await releaseLoginIdentityRefreshLease(env.DB, identity.userId, owner);
  }
};

const refreshFlights = new WeakMap<D1Database, Map<string, Promise<LoginIdentityRecord | null>>>();

/** Coalesces refreshes in this isolate before they contend for the D1 lease. */
export const refreshLoginIdentityTokens = async (
  env: LoginTokenRefreshEnvironment,
  identity: LoginIdentityRecord,
  now: string,
  fetcher: typeof fetch = fetch,
  leaseOptions: LoginTokenRefreshLeaseOptions = {},
): Promise<LoginIdentityRecord | null> => {
  let flights = refreshFlights.get(env.DB);
  if (flights === undefined) {
    flights = new Map();
    refreshFlights.set(env.DB, flights);
  }

  const existingFlight = flights.get(identity.userId);
  if (existingFlight !== undefined) return await existingFlight;

  const flight = refreshLoginIdentityTokensOnce(env, identity, now, fetcher, leaseOptions);
  flights.set(identity.userId, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(identity.userId) === flight) flights.delete(identity.userId);
    if (flights.size === 0) refreshFlights.delete(env.DB);
  }
};
