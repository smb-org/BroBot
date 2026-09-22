import {
  getBotIdentity,
} from "./db/bot-identity";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";

const SHOUTOUT_URL = "https://api.twitch.tv/helix/chat/shoutouts";

export interface ShoutoutSendResult {
  sent: boolean;
  /** Machine-readable reason when the attempt was not successful. */
  reason: string | null;
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
    return { sent: false, reason: result.reason, detail: { ...detail, status: result.status, message: result.message } };
  }

  return { sent: true, reason: null, detail: { ...detail, status: result.status } };
};
