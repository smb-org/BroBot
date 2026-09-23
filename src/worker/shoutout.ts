import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import { getBotIdentity } from "./db/bot-identity";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import type { ShoutoutFailureReason } from "../contracts/values";

export interface TwitchUser {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStoredBotAccessToken = async (environment: Env): Promise<string | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const value = await decryptJson<{ token?: unknown }>(
    identity.accessTokenCiphertext,
    parseKeyRing(getTokenEncryptionKeys(environment)),
  );
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? value.token
    : null;
};

export const fetchTwitchUserByLogin = async (
  fetcher: typeof fetch,
  environment: Env,
  login: string,
  credentialSource: "bot" | "app" = "bot",
): Promise<TwitchUser | null> => {
  const accessToken = credentialSource === "app"
    ? await getAppAccessToken(environment, new Date().toISOString(), fetcher)
    : await readStoredBotAccessToken(environment);
  if (accessToken === null) throw new Error("A Twitch access token for user search is missing.");
  const result = await helixRequest<Record<string, unknown>>({
    url: "https://api.twitch.tv/helix/users",
    query: { login },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) throw new Error("Twitch user search failed.");
  const userData: unknown = result.data.data;
  if (!Array.isArray(userData)) throw new Error("Twitch user search returned an invalid response.");
  if (userData.length === 0) return null;
  const first: unknown = userData[0];
  if (!isRecord(first) || typeof first.id !== "string" || typeof first.login !== "string" ||
      typeof first.display_name !== "string") throw new Error("Twitch user search returned an invalid user.");
  return {
    userId: first.id,
    login: first.login,
    displayName: first.display_name,
    profileImageUrl: typeof first.profile_image_url === "string" && first.profile_image_url.length > 0
      ? first.profile_image_url
      : null,
  };
};

const SHOUTOUT_URL = "https://api.twitch.tv/helix/chat/shoutouts";

export interface ShoutoutSendResult {
  sent: boolean;
  /** Machine-readable reason when the attempt was not successful. */
  reason: ShoutoutFailureReason | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

export const sendShoutout = async (
  environment: {
    DB: D1Database;
    TWITCH_CLIENT_ID: string;
    TWITCH_CLIENT_SECRET: string;
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
  channelId: string,
  targetChannelId: string,
  fetcher: typeof fetch = fetch,
): Promise<ShoutoutSendResult> => {
  const detail = { from: channelId, to: targetChannelId };
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return { sent: false, reason: "bot_identity_missing", detail };

  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(
      environment as unknown as Env,
      new Date().toISOString(),
      fetcher,
    );
  } catch {
    return { sent: false, reason: "app_token_unavailable", detail };
  }

  const result = await helixRequest({
    method: "POST",
    url: SHOUTOUT_URL,
    // Sender is the bot's own channel, recipient is the raid's source channel.
    // Swapped, Twitch would respond with 401: the bot isn't a moderator there.
    query: {
      from_broadcaster_id: channelId,
      to_broadcaster_id: targetChannelId,
      moderator_id: identity.userId,
    },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });

  if (!result.ok) {
    const reason: ShoutoutFailureReason = result.reason === "rate_limited" ? "rate_limited"
      : result.reason === "timeout" ? "timeout"
        : result.reason === "network_error" ? "network_error"
          : result.status === 401 ? "not_moderator"
            : result.status === 403 ? "scope_missing"
              : result.status === 404 ? "twitch_user_not_found"
                : "twitch_error";
    return { sent: false, reason, detail: { ...detail, status: result.status, message: result.message } };
  }

  return { sent: true, reason: null, detail: { ...detail, status: result.status } };
};
