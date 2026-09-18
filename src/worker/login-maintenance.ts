import {
  listLoginIdentities,
  revokeLoginIdentityAndSessionsForUser,
  rotateLoginTokensForUser,
  setLoginIdentityStatusIfCurrent,
} from "./auth/repository";
import { encryptJson, parseKeyRing } from "./auth/crypto";
import {
  decryptStoredToken,
  refreshBotToken,
  shouldRefreshBotToken,
  TwitchApiError,
  validateBotToken,
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
      );
    } catch {
      throw firstError;
    }
  }
};

const isInvalidGrant = (error: unknown): boolean =>
  error instanceof TwitchApiError && error.code === "invalid_grant";

const refreshFailureReason = (error: unknown): string =>
  error instanceof TwitchApiError && error.code !== null ? error.code : "refresh_failed";

const maintainLoginIdentity = async (env: Env, identity: Awaited<ReturnType<typeof listLoginIdentities>>[number], now: string): Promise<void> => {
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, env.SESSION_ENCRYPTION_KEYS);
  const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, env.SESSION_ENCRYPTION_KEYS);
  if (accessToken === null || refreshToken === null) {
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
        parseKeyRing(env.SESSION_ENCRYPTION_KEYS),
      );
      const refreshTokenCiphertext = await encryptJson(
        { token: refreshed.refreshToken },
        parseKeyRing(env.SESSION_ENCRYPTION_KEYS),
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
      );
      if (!replaced) return;
      statusExpectedAccessTokenCiphertext = accessTokenCiphertext;
      statusExpectedRefreshTokenCiphertext = refreshTokenCiphertext;
    } catch (error: unknown) {
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
  const identities = await listLoginIdentities(env.DB);
  await Promise.all(identities.map((identity) => maintainLoginIdentity(env, identity, now)));
};
