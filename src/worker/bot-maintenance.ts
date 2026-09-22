import {
  getBotIdentity,
  getBotIdentityStatus,
  setBotIdentityMissingScopesIfCurrent,
  setBotIdentityStatusIfCurrent,
  rotateBotTokens,
} from "./db/bot-identity";
import type { IdentityStatus } from "../contracts/values";
import {
  listChannelIds,
} from "./db/channels";
import {
  purgeExpiredOAuthTransactions,
} from "./db/oauth-transactions";
import {
  setBotChannelStatus,
} from "./db/bot-channel-status";
import { decryptJson, encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import { BOT_TOKEN_REFRESH_THRESHOLD_MS } from "../maintenance-policy";
import { truncateTo200Chars } from "../text";
import { missingBotScopes } from "./auth/oauth";

export interface TwitchClientEnvironment {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
}

export interface RefreshedBotToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

export interface ValidatedBotToken {
  userId: string;
  login: string;
  expiresIn: number;
  scopes: string[];
}

export class TwitchApiError extends Error {
  public readonly status: number;
  public readonly code: string | null;

  public constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "TwitchApiError";
    this.status = status;
    this.code = code;
  }
}

export interface MaintenanceLogContext {
  channelId: string;
  subscriptionType: string;
  variant: string;
}

export interface MaintenanceErrorDetails {
  message: string | null;
  status: number | null;
  code: string;
}

const logPart = (value: string | null | undefined): string => truncateTo200Chars(value ?? "-").replace(/[\r\n]+/g, " ");

export const maintenanceErrorDetails = (
  error: unknown,
  fallbackCode = "maintenance_failed",
): MaintenanceErrorDetails => error instanceof TwitchApiError
  ? {
    message: logPart(error.message),
    status: error.status,
    code: error.code ?? fallbackCode,
  }
  : { message: null, status: null, code: fallbackCode };

/** Writes only structured maintenance data, never request or token contents. */
export const logMaintenanceError = (
  context: MaintenanceLogContext,
  error: unknown,
  fallbackCode = "maintenance_failed",
): void => {
  const details = maintenanceErrorDetails(error, fallbackCode);
  console.error(
    `maintenance_error channel=${logPart(context.channelId)} subscription_type=${logPart(context.subscriptionType)} ` +
    `variant=${logPart(context.variant)} status=${details.status === null ? "-" : String(details.status)} ` +
    `code=${logPart(details.code)} message=${details.message ?? "-"}`,
  );
};

export const MODERATOR_STATUS_REQUEST_TIMEOUT_MS = 5_000;

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TwitchApiError("Die Twitch-Abfrage hat das Zeitlimit überschritten.", 504, "timeout"));
    }, MODERATOR_STATUS_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new TwitchApiError("Die Twitch-Abfrage hat das Zeitlimit überschritten.", 504, "timeout");
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const isFinitePositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const shouldRefreshBotToken = (expiresAt: string, now: string): boolean => {
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) ||
    expiresAtMs <= nowMs + BOT_TOKEN_REFRESH_THRESHOLD_MS;
};

export const refreshBotToken = async (
  fetcher: typeof fetch,
  environment: TwitchClientEnvironment,
  refreshToken: string,
): Promise<RefreshedBotToken> => {
  const response = await fetcher("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: environment.TWITCH_CLIENT_ID,
      client_secret: environment.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = await responseJson(response);
  if (!response.ok || typeof body.access_token !== "string" || body.access_token.length === 0 ||
      typeof body.refresh_token !== "string" || body.refresh_token.length === 0 ||
      !isFinitePositiveNumber(body.expires_in)) {
    throw new TwitchApiError(
      "Twitch-Refresh wurde abgelehnt.",
      response.status,
      typeof body.error === "string" ? body.error : null,
    );
  }
  const scopes = Array.isArray(body.scope)
    ? body.scope.map((scope: unknown) => scope).filter((scope): scope is string => typeof scope === "string")
    : [];
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    scopes,
  };
};

export const validateBotToken = async (
  fetcher: typeof fetch,
  environment: TwitchClientEnvironment,
  accessToken: string,
): Promise<ValidatedBotToken> => {
  const response = await fetcher("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const body = await responseJson(response);
  if (!response.ok || typeof body.user_id !== "string" || typeof body.login !== "string" ||
      !isFinitePositiveNumber(body.expires_in)) {
    throw new TwitchApiError(
      "Twitch-Token ist ungültig.",
      response.status,
      typeof body.error === "string" ? body.error : null,
    );
  }
  if (typeof body.client_id === "string" && body.client_id !== environment.TWITCH_CLIENT_ID) {
    throw new TwitchApiError("Twitch-Token gehört zu einer anderen Anwendung.", 502);
  }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return { userId: body.user_id, login: body.login, expiresIn: body.expires_in, scopes };
};

interface ModeratedChannelsPage {
  channelIds: string[];
  nextCursor: string | null;
}

const fetchModeratedChannelsPage = async (
  fetcher: typeof fetch,
  clientId: string,
  userId: string,
  accessToken: string,
  cursor: string | null,
  broadcasterId?: string,
): Promise<ModeratedChannelsPage> => {
  const url = new URL("https://api.twitch.tv/helix/moderation/channels");
  url.searchParams.set("user_id", userId);
  url.searchParams.set("first", "100");
  if (cursor !== null) url.searchParams.set("after", cursor);
  if (broadcasterId !== undefined) url.searchParams.set("broadcaster_id", broadcasterId);
  const response = await fetchWithTimeout(fetcher, url.toString(), {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await responseJson(response);
  if (!response.ok || !Array.isArray(body.data)) {
    throw new TwitchApiError(
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : "Moderatorstatus konnte nicht gelesen werden.",
      response.status,
      typeof body.error === "string" ? body.error : null,
    );
  }
  const data: unknown[] = body.data.map((entry: unknown): unknown => entry);
  const pagination = body.pagination;
  const nextCursor = pagination !== null && typeof pagination === "object" &&
    "cursor" in pagination && typeof pagination.cursor === "string" && pagination.cursor.length > 0
    ? pagination.cursor
    : null;
  const channelIds: string[] = data.flatMap((entry: unknown) => {
    if (entry !== null && typeof entry === "object" &&
        "broadcaster_id" in entry && typeof entry.broadcaster_id === "string") {
      return [entry.broadcaster_id];
    }
    return [];
  });
  return { channelIds, nextCursor };
};

export const fetchModeratedChannels = async (
  fetcher: typeof fetch,
  clientId: string,
  userId: string,
  accessToken: string,
): Promise<string[]> => {
  const seenCursors = new Set<string>();
  const fetchPage = async (cursor: string | null): Promise<string[]> => {
    const page = await fetchModeratedChannelsPage(fetcher, clientId, userId, accessToken, cursor);
    if (page.nextCursor === null) return page.channelIds;
    if (seenCursors.has(page.nextCursor)) {
      throw new TwitchApiError("Twitch liefert einen wiederholten Pagination-Cursor.", 502);
    }
    seenCursors.add(page.nextCursor);
    return page.channelIds.concat(await fetchPage(page.nextCursor));
  };

  return fetchPage(null);
};

export const fetchChannelStatus = async (
  fetcher: typeof fetch,
  clientId: string,
  userId: string,
  accessToken: string,
  channelId: string,
): Promise<boolean> => {
  const page = await fetchModeratedChannelsPage(
    fetcher,
    clientId,
    userId,
    accessToken,
    null,
    channelId,
  );
  return page.channelIds.includes(channelId);
};

export const decryptStoredToken = async (ciphertext: string, keys: string): Promise<string | null> => {
  const value = await decryptJson<{ token: string }>(ciphertext, parseKeyRing(keys));
  return value !== null && typeof value.token === "string" && value.token.length > 0 ? value.token : null;
};

const rotateBotTokensWithRetry = async (
  db: D1Database,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string,
  expiresAt: string,
  updatedAt: string,
): Promise<boolean> => {
  try {
    return await rotateBotTokens(
      db,
      expectedAccessTokenCiphertext,
      expectedRefreshTokenCiphertext,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt,
      updatedAt,
    );
  } catch (firstError: unknown) {
    try {
      return await rotateBotTokens(
        db,
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

export interface IdentityAuthorizationRecord {
  userId: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  updatedAt: string;
  status?: IdentityStatus;
}

/** Shared flow for confirming a revoked identity token. */
export const confirmIdentityAuthorization = async (
  env: Env,
  expectedUserId: string,
  now: string,
  getIdentity: () => Promise<IdentityAuthorizationRecord | null>,
  readRevokedStatus: (identity: IdentityAuthorizationRecord) => Promise<boolean> | boolean,
  recordTokenRotation: (
    db: D1Database,
    identity: IdentityAuthorizationRecord,
    accessTokenCiphertext: string,
    refreshTokenCiphertext: string,
    expiresAt: string,
    updatedAt: string,
    scopes: readonly string[],
  ) => Promise<boolean>,
  fetcher: typeof fetch = fetch,
): Promise<boolean> => {
  const identity = await getIdentity();
  if (identity === null || identity.userId !== expectedUserId) return false;
  if (await readRevokedStatus(identity)) return true;

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
      await recordTokenRotation(
        env.DB,
        identity,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        new Date(Date.parse(now) + refreshed.expiresIn * 1000).toISOString(),
        now,
        refreshed.scopes,
      );
      return false;
    } catch (refreshError: unknown) {
      return isInvalidGrant(refreshError);
    }
  }
};

/** Confirms a bot revocation without writing the revocation state itself. */
export const confirmBotIdentityAuthorization = async (
  env: Env,
  expectedUserId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> => {
  return confirmIdentityAuthorization(
    env,
    expectedUserId,
    now,
    () => getBotIdentity(env.DB),
    async () => (await getBotIdentityStatus(env.DB))?.status === "revoked",
    (db, identity, accessTokenCiphertext, refreshTokenCiphertext, expiresAt, updatedAt) =>
      rotateBotTokensWithRetry(
        db,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        updatedAt,
      ),
    fetcher,
  );
};

const refreshFailureReason = (error: unknown): string =>
  error instanceof TwitchApiError && error.code !== null ? error.code : "refresh_failed";

const maintainBotIdentityInternal = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  await purgeExpiredOAuthTransactions(env.DB, now);
  const status = await getBotIdentityStatus(env.DB);
  const identity = await getBotIdentity(env.DB);
  if (identity === null) return;

  let storedScopes: unknown;
  try {
    storedScopes = JSON.parse(identity.scopesJson);
  } catch {
    storedScopes = [];
  }
  const grantedScopes = Array.isArray(storedScopes)
    ? storedScopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  await setBotIdentityMissingScopesIfCurrent(
    env.DB,
    missingBotScopes(grantedScopes),
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
  );
  if (status?.status === "revoked") return;

  const encryptionKeys = getTokenEncryptionKeys(env);
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, encryptionKeys);
  const refreshToken = await decryptStoredToken(identity.refreshTokenCiphertext, encryptionKeys);
  if (accessToken === null || refreshToken === null) {
    logMaintenanceError({ channelId: "global", subscriptionType: "bot-identity", variant: "token" }, new Error(), "token_ciphertext_unreadable");
    await setBotIdentityStatusIfCurrent(
      env.DB,
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
  let currentStatus: ValidatedBotToken;
  try {
    currentStatus = await validateBotToken(fetcher, env, accessToken);
  } catch (error: unknown) {
    if (error instanceof TwitchApiError && error.status === 401) {
      currentStatus = { userId: identity.userId, login: identity.login, expiresIn: 0, scopes: [] };
      validateReturned401 = true;
    } else {
      logMaintenanceError({ channelId: "global", subscriptionType: "bot-identity", variant: "validation" }, error, "validate_failed");
      await setBotIdentityStatusIfCurrent(
        env.DB,
        "error",
        "validate_failed",
        now,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
      );
      return;
    }
  }

  let currentAccessToken = accessToken;
  let statusExpectedAccessTokenCiphertext = identity.accessTokenCiphertext;
  let statusExpectedRefreshTokenCiphertext = identity.refreshTokenCiphertext;
  if (tokenIsExpiring || validateReturned401) {
    try {
      const refreshed = await refreshBotToken(fetcher, env, refreshToken);
      const expiresAt = new Date(Date.parse(now) + refreshed.expiresIn * 1000).toISOString();
      const accessTokenCiphertext = await encryptJson(
        { token: refreshed.accessToken },
        parseKeyRing(encryptionKeys),
      );
      const refreshTokenCiphertext = await encryptJson(
        { token: refreshed.refreshToken },
        parseKeyRing(encryptionKeys),
      );
      const replaced = await rotateBotTokensWithRetry(
        env.DB,
        identity.accessTokenCiphertext,
        identity.refreshTokenCiphertext,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        now,
      );
      if (!replaced) return;
      currentAccessToken = refreshed.accessToken;
      statusExpectedAccessTokenCiphertext = accessTokenCiphertext;
      statusExpectedRefreshTokenCiphertext = refreshTokenCiphertext;
    } catch (error: unknown) {
      logMaintenanceError({ channelId: "global", subscriptionType: "bot-identity", variant: "refresh" }, error, refreshFailureReason(error));
      if (isInvalidGrant(error)) {
        await setBotIdentityStatusIfCurrent(
          env.DB,
          "revoked",
          "authorization_revoked",
          now,
          identity.accessTokenCiphertext,
          identity.refreshTokenCiphertext,
        );
      } else {
        await setBotIdentityStatusIfCurrent(
          env.DB,
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

  const channelIds = await listChannelIds(env.DB);
  try {
    const moderatedChannels = new Set(await fetchModeratedChannels(
      fetcher,
      env.TWITCH_CLIENT_ID,
      currentStatus.userId,
      currentAccessToken,
    ));
    await Promise.all(channelIds.map((channelId) =>
      setBotChannelStatus(env.DB, channelId, moderatedChannels.has(channelId), now, null)));
    await setBotIdentityStatusIfCurrent(
      env.DB,
      "connected",
      null,
      now,
      statusExpectedAccessTokenCiphertext,
      statusExpectedRefreshTokenCiphertext,
    );
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "bot-identity", variant: "moderated-channels" }, error, "moderator_status_failed");
    const reason = error instanceof TwitchApiError ? "moderator_status_failed" : "maintenance_failed";
    await setBotIdentityStatusIfCurrent(
      env.DB,
      "error",
      reason,
      now,
      statusExpectedAccessTokenCiphertext,
      statusExpectedRefreshTokenCiphertext,
    );
  }
};

export const maintainBotIdentity = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  try {
    await maintainBotIdentityInternal(env, now, fetcher);
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "bot-identity", variant: "run" }, error);
    throw error;
  }
};
