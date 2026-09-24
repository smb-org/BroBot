import {
  getBotIdentity,
} from "./db/bot-identity";
import { getAppAccessToken } from "./app-token";
import { truncateTo200Chars } from "../modules/contract";
import { helixRequest } from "./twitch/helix";

const CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";
const CHAT_MESSAGE_MAXIMUM_LENGTH = 500;

export const truncateChatText = (text: string): { text: string; truncated: boolean } => text.length <= CHAT_MESSAGE_MAXIMUM_LENGTH
  ? { text, truncated: false }
  : { text: `${text.slice(0, CHAT_MESSAGE_MAXIMUM_LENGTH - 1)}…`, truncated: true };

export interface ChatSendResult {
  sent: boolean;
  truncated: boolean;
  /** Machine-readable reason when the message was not sent. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Sends a chat message on the bot's behalf.
 *
 * Twitch responds with HTTP 200 even when the message was dropped — for
 * example by AutoMod. The actual outcome is then in `data[0].is_sent` along
 * with `drop_reason`. Anyone who only checks the status code logs a failure
 * as a success; that is exactly what the event log is meant to prevent.
 */
export const sendChatMessage = async (
  environment: {
    DB: D1Database;
    TWITCH_CLIENT_ID: string;
    TWITCH_CLIENT_SECRET: string;
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
  channelId: string,
  text: string,
  replyToMessageId: string | undefined,
  fetcher: typeof fetch = fetch,
  /**
   * Re-checked immediately before the Helix POST, after the identity and
   * token awaits above -- the only two awaits between a caller's own
   * decision and the actual network call. Lets a caller like the ad
   * prewarning (whose text can go stale while this function is still
   * awaiting bot identity/token) bail out right before sending instead of
   * announcing an outcome it already knows is wrong.
   * ponytail: the one window this can't close is the POST's own network
   * latency below -- inherent, and acceptable for an informational chat
   * warning.
   */
  stillValid?: () => Promise<boolean>,
): Promise<ChatSendResult> => {
  const preparedText = truncateChatText(text);
  const textDetail = { text: truncateTo200Chars(preparedText.text) };
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) {
    return { sent: false, truncated: preparedText.truncated, reason: "bot_identity_missing", detail: textDetail };
  }
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(
      environment as unknown as Env,
      new Date().toISOString(),
      fetcher,
    );
  } catch {
    return { sent: false, truncated: preparedText.truncated, reason: "app_token_unavailable", detail: textDetail };
  }

  if (stillValid !== undefined && !(await stillValid())) {
    return { sent: false, truncated: preparedText.truncated, reason: "stale_before_send", detail: textDetail };
  }

  const payload: Record<string, string | boolean> = {
    broadcaster_id: channelId,
    sender_id: identity.userId,
    message: preparedText.text,
    for_source_only: false,
  };
  if (replyToMessageId !== undefined) payload.reply_parent_message_id = replyToMessageId;

  const result = await helixRequest<Record<string, unknown>>({
    method: "POST",
    url: CHAT_MESSAGES_URL,
    body: payload,
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });

  if (!result.ok) {
    return { sent: false, truncated: preparedText.truncated, reason: result.reason, detail: { ...textDetail, status: result.status, twitchMessage: result.message } };
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};

  // If `is_sent` is missing, the outcome is unknown. Unknown counts as not
  // sent here: a silent failure would be worse than a false warning.
  if (first.is_sent !== true) {
    const dropReason = isRecord(first.drop_reason) ? first.drop_reason : {};
    return {
      sent: false,
      truncated: preparedText.truncated,
      reason: readText(dropReason.code) ?? "not_sent",
      detail: { ...textDetail, twitchMessage: readText(dropReason.message) },
    };
  }

  return { sent: true, truncated: preparedText.truncated, reason: null, detail: { messageId: readText(first.message_id), ...textDetail } };
};
