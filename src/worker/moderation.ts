import type { ModerationFailureReason } from "../contracts/values";
import type { ModerationResult, ModerationTimeoutExpectation } from "../modules/contracts/moderation";
import { MODERATION_TIMEOUT_MAX_SECONDS } from "../modules/contracts/moderation";
import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import { getBotIdentity } from "./db/bot-identity";
import { readChannelControls } from "./db/channel-controls";
import { getLoginIdentity } from "./db/login-identity";
import { helixRequest } from "./twitch/helix";
import { TWITCH_RATE_LIMIT_COOLDOWN_MS } from "./twitch/rate-limit";

const MODERATION_BANS_URL = "https://api.twitch.tv/helix/moderation/bans";

interface ModerationBanRequest {
  userId: string;
  durationSeconds: number | null;
  reason: string;
}

interface ModerationEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  CHANNEL?: Env["CHANNEL"];
}

interface ModeratorStatusRow {
  is_moderator: number;
}

interface TwitchModerationBanRow {
  user_id?: unknown;
  moderator_id?: unknown;
  reason?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
}

const isTwitchModerationBanRows = (value: unknown): value is TwitchModerationBanRow[] =>
  Array.isArray(value) && value.every((row: unknown): row is TwitchModerationBanRow =>
    typeof row === "object" && row !== null && !Array.isArray(row) &&
    typeof Reflect.get(row, "user_id") === "string" && typeof Reflect.get(row, "moderator_id") === "string" &&
    typeof Reflect.get(row, "reason") === "string" && typeof Reflect.get(row, "created_at") === "string" &&
    typeof Reflect.get(row, "expires_at") === "string");

type ModerationSuppressionReason = "channel_muted" | "channel_paused";

interface SuppressedModerationResult {
  outcome: "suppressed";
  reason: ModerationSuppressionReason;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

type ModerationExecutionResult = ModerationResult | SuppressedModerationResult;

const truncateReason = (reason: string): string => Array.from(reason).slice(0, 500).join("");

const failure = (
  reason: ModerationFailureReason,
  detail: Readonly<Record<string, string | number | boolean | null>>,
  outcome: "rejected" | "ambiguous" = "rejected",
): ModerationResult => ({ outcome, reason, detail });

const failureReasonFrom400Message = (message: string | null): ModerationFailureReason => {
  const normalized = message?.toLocaleLowerCase("en-US") ?? "";
  if (normalized.includes("may not be banned") || normalized.includes("cannot be timed out") ||
      normalized.includes("may not be put in a timeout")) {
    return "protected_target";
  }
  if (normalized.includes("already banned")) return "already_banned";
  return "invalid_request";
};

const failureReasonFromStatus = (status: number): ModerationFailureReason => {
  if (status === 400) return "invalid_request";
  if (status === 401) return "token_invalid";
  if (status === 403) return "not_moderator";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "twitch_error";
};

function executeModeration(
  environment: ModerationEnvironment,
  channelId: string,
  request: ModerationBanRequest,
  method: "POST",
  fetcher: typeof fetch,
): Promise<ModerationExecutionResult>;
function executeModeration(
  environment: ModerationEnvironment,
  channelId: string,
  request: ModerationBanRequest,
  method: "DELETE",
  fetcher: typeof fetch,
): Promise<ModerationResult>;
async function executeModeration(
  environment: ModerationEnvironment,
  channelId: string,
  request: ModerationBanRequest,
  method: "POST" | "DELETE",
  fetcher: typeof fetch,
): Promise<ModerationExecutionResult> {
  const reason = truncateReason(request.reason);
  const baseDetail = {
    target: request.userId,
    ...(request.durationSeconds === null ? {} : { seconds: request.durationSeconds }),
    ...(request.reason.length === 0 ? {} : { reason }),
  };
  const readSuppressionReason = async (): Promise<ModerationSuppressionReason | null> => {
    const controls = await readChannelControls(environment.DB, channelId, new Date().toISOString());
    if (controls.mute.active) return "channel_muted";
    if (controls.pause.active) return "channel_paused";
    return null;
  };
  if (method === "POST") {
    const suppressionReason = await readSuppressionReason();
    if (suppressionReason !== null) {
      return { outcome: "suppressed", reason: suppressionReason, detail: baseDetail };
    }
  }
  if (request.durationSeconds !== null &&
      (!Number.isSafeInteger(request.durationSeconds) || request.durationSeconds < 1 || request.durationSeconds > MODERATION_TIMEOUT_MAX_SECONDS)) {
    return failure("invalid_request", baseDetail);
  }

  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return failure("bot_identity_missing", baseDetail);
  if (request.userId === channelId || request.userId === identity.userId) {
    return failure("protected_target", baseDetail);
  }

  const status = await environment.DB.prepare(
    `SELECT is_moderator
       FROM bot_channel_status
      WHERE channel_id = ?`,
  ).bind(channelId).first<ModeratorStatusRow>();
  if (status?.is_moderator !== 1) return failure("not_moderator", baseDetail);

  if (environment.CHANNEL !== undefined) {
    const channelObject = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
    if (await channelObject.getTwitchRateLimitRetryAfter() !== null) {
      return failure("rate_limited", baseDetail);
    }
  }

  let accessToken: string;
  try {
    const tokenData = await decryptJson<{ token?: unknown }>(
      identity.accessTokenCiphertext,
      parseKeyRing(getTokenEncryptionKeys(environment)),
    );
    if (tokenData === null || typeof tokenData.token !== "string" || tokenData.token.length === 0) {
      return failure("token_invalid", baseDetail);
    }
    accessToken = tokenData.token;
  } catch {
    return failure("token_invalid", baseDetail);
  }

  if (method === "POST") {
    const suppressionReason = await readSuppressionReason();
    if (suppressionReason !== null) {
      return { outcome: "suppressed", reason: suppressionReason, detail: baseDetail };
    }
  }

  const result = await helixRequest({
    method,
    url: MODERATION_BANS_URL,
    query: {
      broadcaster_id: channelId,
      moderator_id: identity.userId,
      ...(method === "DELETE" ? { user_id: request.userId } : {}),
    },
    ...(method === "POST" ? {
      body: {
        data: {
          user_id: request.userId,
          ...(request.durationSeconds === null ? {} : { duration: request.durationSeconds }),
          reason,
        },
      },
    } : {}),
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });

  if (result.ok) {
    return { outcome: "applied", reason: null, detail: { ...baseDetail, status: result.status } };
  }

  const detail = { ...baseDetail, status: result.status, twitchMessage: result.message };
  if (result.reason === "timeout" || result.reason === "network_error") {
    return failure(result.reason, detail, "ambiguous");
  }
  if (result.status === 429) {
    if (environment.CHANNEL !== undefined) {
      try {
        const channelObject = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
        await channelObject.setTwitchRateLimitRetryAfter(Date.now() + TWITCH_RATE_LIMIT_COOLDOWN_MS);
      } catch {
        // Twitch has already rejected this request; a failed pause write must not trigger a retry.
      }
    }
    return failure("rate_limited", detail);
  }
  return failure(
    result.status === 400 ? failureReasonFrom400Message(result.message) : failureReasonFromStatus(result.status ?? 0),
    detail,
  );
}

export const sendModerationBan = (
  environment: ModerationEnvironment,
  channelId: string,
  request: ModerationBanRequest,
  fetcher: typeof fetch = fetch,
): Promise<ModerationExecutionResult> => executeModeration(environment, channelId, request, "POST", fetcher);

const broadcasterModerationToken = async (
  environment: ModerationEnvironment,
  channelId: string,
): Promise<string | null> => {
  const identity = await getLoginIdentity(environment.DB, channelId);
  if (identity === null || identity.status !== "connected") return null;
  try {
    const scopes: unknown = JSON.parse(identity.tokenScopesJson);
    if (!Array.isArray(scopes) || !scopes.includes("moderation:read")) return null;
    const tokenData = await decryptJson<{ token?: unknown }>(
      identity.accessTokenCiphertext,
      parseKeyRing(getTokenEncryptionKeys(environment)),
    );
    return tokenData !== null && typeof tokenData.token === "string" && tokenData.token.length > 0
      ? tokenData.token
      : null;
  } catch {
    return null;
  }
};

const isCurrentExpectedTimeout = async (
  environment: ModerationEnvironment,
  channelId: string,
  userId: string,
  expected: ModerationTimeoutExpectation,
  fetcher: typeof fetch,
): Promise<boolean | null> => {
  if (!Number.isSafeInteger(expected.durationSeconds) || expected.durationSeconds < 1 || expected.durationSeconds > MODERATION_TIMEOUT_MAX_SECONDS) return null;
  const expectedStart = Date.parse(expected.startedAt);
  if (!Number.isFinite(expectedStart)) return null;
  const token = await broadcasterModerationToken(environment, channelId);
  const bot = await getBotIdentity(environment.DB);
  if (token === null || bot === null) return null;
  const result = await helixRequest<{ data?: TwitchModerationBanRow[] }>({
    url: "https://api.twitch.tv/helix/moderation/banned",
    query: { broadcaster_id: channelId, user_id: userId },
    accessToken: token,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok || !isTwitchModerationBanRows(result.data.data)) return null;
  const current = result.data.data.find((row) => row.user_id === userId);
  if (current === undefined || current.moderator_id !== bot.userId || current.reason !== expected.reason) return false;
  const createdAt = Date.parse(current.created_at as string);
  const expiresAt = Date.parse(current.expires_at as string);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      Math.abs(createdAt - expectedStart) > 60_000 ||
      Math.abs(expiresAt - createdAt - expected.durationSeconds * 1000) > 1_000) return false;
  return true;
};

// Twitch's delete endpoint has no sanction ID or conditional version, so the
// matched active timeout is checked immediately before the target-based delete.
export const liftModerationBan = (
  environment: ModerationEnvironment,
  channelId: string,
  userId: string,
  expected: ModerationTimeoutExpectation,
  fetcher: typeof fetch = fetch,
): Promise<ModerationResult> => isCurrentExpectedTimeout(environment, channelId, userId, expected, fetcher)
  .then((matches): Promise<ModerationResult> => matches === true
    ? executeModeration(environment, channelId, { userId, durationSeconds: null, reason: "" }, "DELETE", fetcher)
    : Promise.resolve(failure(matches === null ? "twitch_error" : "conflict", { target: userId })));

/** Checks one user against Twitch's channel moderator list; null means lookup failure. */
export const isTwitchChannelModerator = async (
  environment: ModerationEnvironment,
  channelId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean | null> => {
  const accessToken = await broadcasterModerationToken(environment, channelId);
  if (accessToken === null) return null;
  const result = await helixRequest<{ data?: unknown }>({
    url: "https://api.twitch.tv/helix/moderation/moderators",
    query: { broadcaster_id: channelId, user_id: userId },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok || !Array.isArray(result.data.data)) return null;
  if (!result.data.data.every((row) => typeof row === "object" && row !== null && !Array.isArray(row) &&
      typeof Reflect.get(row, "user_id") === "string")) return null;
  return result.data.data.some((row) => Reflect.get(row, "user_id") === userId);
};
