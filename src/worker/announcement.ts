import { truncateTo200Chars } from "../modules/contract";
import type { ChatOutputTarget } from "../modules/contract";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import { forSourceOnlyForChatTarget, truncateChatTextWithAttributions } from "./chat";

const ANNOUNCEMENTS_URL = "https://api.twitch.tv/helix/chat/announcements";

export interface AnnouncementSendResult {
  sent: boolean;
  truncated: boolean;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

interface ModeratorStatusRow {
  is_moderator: number;
}

interface BotUserIdRow {
  user_id: string;
}

export const sendChatAnnouncement = async (
  environment: {
    DB: D1Database;
    TWITCH_CLIENT_ID: string;
    TWITCH_CLIENT_SECRET: string;
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
  channelId: string,
  text: string,
  fetcher: typeof fetch = fetch,
  attributions: readonly string[] = [],
  target: ChatOutputTarget = "source_only",
  sourceBroadcasterUserId?: string | null,
): Promise<AnnouncementSendResult> => {
  const preparedText = truncateChatTextWithAttributions(text, attributions);
  const detail = { text: truncateTo200Chars(preparedText.text) };
  const moderator = await environment.DB.prepare(
    `SELECT is_moderator
       FROM bot_channel_status
      WHERE channel_id = ?`,
  ).bind(channelId).first<ModeratorStatusRow>();
  if (moderator?.is_moderator !== 1) {
    return { sent: false, truncated: preparedText.truncated, reason: "not_moderator", detail };
  }

  const identity = await environment.DB.prepare(
    `SELECT user_id
       FROM bot_identity
      WHERE id = 1`,
  ).first<BotUserIdRow>();
  if (identity === null) {
    return { sent: false, truncated: preparedText.truncated, reason: "bot_identity_missing", detail };
  }

  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(
      environment as unknown as Env,
      new Date().toISOString(),
      fetcher,
    );
  } catch {
    return { sent: false, truncated: preparedText.truncated, reason: "app_token_unavailable", detail };
  }

  const result = await helixRequest({
    method: "POST",
    url: ANNOUNCEMENTS_URL,
    query: {
      broadcaster_id: channelId,
      moderator_id: identity.user_id,
      for_source_only: String(forSourceOnlyForChatTarget(target, channelId, sourceBroadcasterUserId)),
    },
    body: { message: preparedText.text },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) {
    return {
      sent: false,
      truncated: preparedText.truncated,
      reason: result.reason,
      detail: { ...detail, status: result.status, twitchMessage: result.message },
    };
  }
  return { sent: true, truncated: preparedText.truncated, reason: null, detail };
};
