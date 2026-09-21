import {
  getLoginIdentity,
  listLoginIdentities,
  revokeLoginIdentityAndSessionsForUser,
  rotateLoginTokensForUser,
  setLoginIdentityStatusIfCurrent,
} from "./auth/repository";
import { encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import {
  decryptStoredToken,
  refreshBotToken,
  shouldRefreshBotToken,
  TwitchApiError,
  validateBotToken,
  logMaintenanceError,
} from "./bot-maintenance";

const markLoginRevoked = async (
  env: Env,
  identity: Awaited<ReturnType<typeof listLoginIdentities>>[number],
  now: string,
  reason: string,
): Promise<void> => {
  await revokeLoginIdentityAndSessionsForUser(
    env.DB,
    identity.userId,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    reason,
    now,
  );
};

const rotateLoginTokensWithRetry = async (
  db: D1Database,
  userId: string,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string,
  expiresAt: string,
  updatedAt: string,
  expectedUpdatedAt: string,
): Promise<boolean> => {
  try {
    return await rotateLoginTokensForUser(
      db,
      userId,
      expectedAccessTokenCiphertext,
      expectedRefreshTokenCiphertext,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt,
      updatedAt,
      expectedUpdatedAt,
    );
  } catch (firstError: unknown) {
    try {
      return await rotateLoginTokensForUser(
        db,
        userId,
        expectedAccessTokenCiphertext,
        expectedRefreshTokenCiphertext,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        updatedAt,
        expectedUpdatedAt,
      );
    } catch {
      throw firstError;
    }
  }
};

const isInvalidGrant = (error: unknown): boolean =>
  error instanceof TwitchApiError && error.code === "invalid_grant";

/** Bestätigt einen Login-Widerruf, ohne den Widerrufszustand selbst zu schreiben. */
export const confirmLoginIdentityAuthorization = async (
  env: Env,
  userId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> => {
  const identity = await getLoginIdentity(env.DB, userId);
  if (identity === null || identity.status === "revoked") return identity?.status === "revoked";

  const encryptionKeys = getTokenEncryptionKeys(env);
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, encryptionKeys);
  const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, encryptionKeys);
  if (accessToken === null || refreshToken === null) return false;

  try {
    await validateBotToken(fetcher, env, accessToken);
    return false;
  } catch (error: unknown) {
    if (!(error instanceof TwitchApiError) || error.status !== 401) return false;
    try {
      const refreshed = await refreshBotToken(fetcher, env, refreshToken);
      const accessTokenCiphertext = await encryptJson(
        { token: refreshed.accessToken },
        parseKeyRing(encryptionKeys),
      );
      const refreshTokenCiphertext = await encryptJson(
        { token: refreshed.refreshToken },
        parseKeyRing(encryptionKeys),
      );
      await rotateLoginTokensWithRetry(
        env.DB,
        identity.userId,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        new Date(Date.parse(now) + refreshed.expiresIn * 1000).toISOString(),
        now,
        identity.updatedAt,
      );
      return false;
    } catch (refreshError: unknown) {
      return isInvalidGrant(refreshError);
    }
  }
};

const refreshFailureReason = (error: unknown): string =>
  error instanceof TwitchApiError && error.code !== null ? error.code : "refresh_failed";

const maintainLoginIdentity = async (env: Env, identity: Awaited<ReturnType<typeof listLoginIdentities>>[number], now: string): Promise<void> => {
  const encryptionKeys = getTokenEncryptionKeys(env);
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, encryptionKeys);
  const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, encryptionKeys);
  if (accessToken === null || refreshToken === null) {
    logMaintenanceError({ channelId: identity.userId, subscriptionType: "login-identity", variant: "token" }, new Error(), "token_ciphertext_unreadable");
    await setLoginIdentityStatusIfCurrent(
      env.DB,
      identity.userId,
      "error",
      "Token-Ciphertext konnte nicht gelesen werden.",
      now,
      identity.accessTokenCiphertext,
      identity.refreshTokenCiphertext,
    );
    return;
  }

  const tokenIsExpiring = shouldRefreshBotToken(identity.expiresAt, now);
  let validateReturned401 = false;
  let statusExpectedAccessTokenCiphertext = identity.accessTokenCiphertext;
  let statusExpectedRefreshTokenCiphertext = identity.refreshTokenCiphertext;
  try {
    await validateBotToken(fetch, env, accessToken);
  } catch (error: unknown) {
    if (error instanceof TwitchApiError && error.status === 401) {
      validateReturned401 = true;
    } else {
      logMaintenanceError({ channelId: identity.userId, subscriptionType: "login-identity", variant: "validation" }, error, "validate_failed");
      await setLoginIdentityStatusIfCurrent(
        env.DB,
        identity.userId,
        "error",
        "validate_failed",
        now,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
      );
      return;
    }
  }

  if (tokenIsExpiring || validateReturned401) {
    try {
      const refreshed = await refreshBotToken(fetch, env, refreshToken);
      const accessTokenCiphertext = await encryptJson(
        { token: refreshed.accessToken },
        parseKeyRing(encryptionKeys),
      );
      const refreshTokenCiphertext = await encryptJson(
        { token: refreshed.refreshToken },
        parseKeyRing(encryptionKeys),
      );
      const replaced = await rotateLoginTokensWithRetry(
        env.DB,
        identity.userId,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        new Date(Date.parse(now) + refreshed.expiresIn * 1000).toISOString(),
        now,
        identity.updatedAt,
      );
      if (!replaced) return;
      statusExpectedAccessTokenCiphertext = accessTokenCiphertext;
      statusExpectedRefreshTokenCiphertext = refreshTokenCiphertext;
    } catch (error: unknown) {
      logMaintenanceError({ channelId: identity.userId, subscriptionType: "login-identity", variant: "refresh" }, error, refreshFailureReason(error));
      if (isInvalidGrant(error)) {
        await markLoginRevoked(env, identity, now, "authorization_revoked");
      } else {
        await setLoginIdentityStatusIfCurrent(
          env.DB,
          identity.userId,
          "error",
          refreshFailureReason(error),
          now,
          identity.accessTokenCiphertext,
          identity.refreshTokenCiphertext,
        );
      }
      return;
    }
  }

  await setLoginIdentityStatusIfCurrent(
    env.DB,
    identity.userId,
    "connected",
    null,
    now,
    statusExpectedAccessTokenCiphertext,
    statusExpectedRefreshTokenCiphertext,
  );
};

export const maintainLoginIdentities = async (env: Env, now: string): Promise<void> => {
  try {
    const identities = await listLoginIdentities(env.DB, now);
    const concurrency = 4;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < identities.length) {
        const index = nextIndex;
        nextIndex += 1;
        const listedIdentity = identities[index];
        if (listedIdentity === undefined) return;
        await maintainLoginIdentity(env, listedIdentity, now);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, identities.length) },
      () => worker(),
    ));
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "login-identities", variant: "run" }, error);
    throw error;
  }
};
