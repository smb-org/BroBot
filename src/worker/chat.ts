import {
  getBotIdentity,
} from "./db/bot-identity";
import { getAppAccessToken } from "./app-token";
import { truncateTo200Chars } from "../modules/contract";
import type { ChatOutputTarget } from "../modules/contract";
import { helixRequest } from "./twitch/helix";

const CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";
const CHAT_MESSAGE_MAXIMUM_LENGTH = 500;
const CHAT_MENTION_PREFIX = /^@[a-zA-Z0-9_]{1,25} /u;

export const truncateChatText = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= CHAT_MESSAGE_MAXIMUM_LENGTH) return { text, truncated: false };
  const prefix = CHAT_MENTION_PREFIX.exec(text)?.[0] ?? "";
  const body = text.slice(prefix.length);
  const availableBodyLength = CHAT_MESSAGE_MAXIMUM_LENGTH - prefix.length;
  return {
    text: `${prefix}${body.slice(0, Math.max(0, availableBodyLength - 1))}…`,
    truncated: true,
  };
};

export const truncateChatTextWithAttributions = (
  text: string,
  attributions: readonly string[] = [],
): { text: string; truncated: boolean } => {
  const labels = [...new Set(attributions.map((value) => {
    let safe = "";
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      safe += codePoint < 32 || codePoint === 127 ? " " : character;
    }
    return safe.trim();
  }).filter(Boolean))];
  if (labels.length === 0) return truncateChatText(text);
  const suffix = labels.map((label) => ` · ${label}`).join("");
  if (suffix.length >= CHAT_MESSAGE_MAXIMUM_LENGTH) return { text: suffix, truncated: text.length > 0 };
  const prefix = CHAT_MENTION_PREFIX.exec(text)?.[0] ?? "";
  const body = text.slice(prefix.length);
  const availableBodyLength = CHAT_MESSAGE_MAXIMUM_LENGTH - prefix.length - suffix.length;
  const preparedBody = body.length <= availableBodyLength
    ? body
    : `${body.slice(0, Math.max(0, availableBodyLength - 1))}…`;
  return {
    text: `${prefix}${preparedBody}${suffix}`,
    truncated: body.length > availableBodyLength,
  };
};

export interface ChatSendResult {
  sent: boolean;
  truncated: boolean;
  delivery: "sent" | "rejected" | "ambiguous" | "not_attempted";
  /** Machine-readable reason when the message was not sent. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** Resolves the configured policy to Twitch's app-token `for_source_only` flag. */
export const forSourceOnlyForChatTarget = (
  target: ChatOutputTarget,
  channelId: string,
  sourceBroadcasterUserId?: string | null,
): boolean => target === "source_only" || (
  target === "where_asked" &&
  (sourceBroadcasterUserId === undefined || sourceBroadcasterUserId === null || sourceBroadcasterUserId === channelId)
);

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
  /** Persist an idempotency claim immediately before the external POST. */
  claimBeforePost?: () => Promise<boolean | "rate_limited">,
  /** Host-appended source labels, reserved before truncation. */
  attributions: readonly string[] = [],
  afterPost?: (delivery: ChatSendResult["delivery"], reason: string | null) => Promise<void>,
  target: ChatOutputTarget = "source_only",
  sourceBroadcasterUserId?: string | null,
): Promise<ChatSendResult> => {
  const preparedText = truncateChatTextWithAttributions(text, attributions);
  const textDetail = { text: truncateTo200Chars(preparedText.text) };
  // Caught rather than left to propagate: an outage here (e.g. D1 unavailable)
  // is the same known, pre-POST outcome as identity simply being absent, and
  // callers decide retryability off `reason`, not off whether this threw.
  let identity: Awaited<ReturnType<typeof getBotIdentity>>;
  try {
    identity = await getBotIdentity(environment.DB);
  } catch {
    identity = null;
  }
  if (identity === null) {
    return { sent: false, truncated: preparedText.truncated, delivery: "not_attempted", reason: "bot_identity_missing", detail: textDetail };
  }
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(
      environment as unknown as Env,
      new Date().toISOString(),
      fetcher,
    );
  } catch {
    return { sent: false, truncated: preparedText.truncated, delivery: "not_attempted", reason: "app_token_unavailable", detail: textDetail };
  }

  if (stillValid !== undefined && !(await stillValid())) {
    return { sent: false, truncated: preparedText.truncated, delivery: "not_attempted", reason: "stale_before_send", detail: textDetail };
  }

  if (claimBeforePost !== undefined) {
    const claim = await claimBeforePost();
    if (claim !== true) {
      return {
        sent: false,
        truncated: preparedText.truncated,
        delivery: "not_attempted",
        reason: claim === "rate_limited" ? "rate_limited" : "already_attempted",
        detail: textDetail,
      };
    }
  }

  const payload: Record<string, string | boolean> = {
    broadcaster_id: channelId,
    sender_id: identity.userId,
    message: preparedText.text,
    for_source_only: forSourceOnlyForChatTarget(target, channelId, sourceBroadcasterUserId),
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
    // A definite rejection is a response Twitch actually returned (a status
    // code, however unwelcome). A timeout or network error can happen after
    // Twitch already accepted the POST -- the response just never arrived --
    // so both stay "ambiguous" and keep the occurrence claim instead of
    // clearing it and risking a duplicate post.
    const delivery = result.reason === "timeout" || result.reason === "network_error" ? "ambiguous" : "rejected";
    await afterPost?.(delivery, result.reason);
    return { sent: false, truncated: preparedText.truncated, delivery, reason: result.reason, detail: { ...textDetail, status: result.status, twitchMessage: result.message } };
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};

  // If `is_sent` is missing, the outcome is unknown. Unknown counts as not
  // sent here: a silent failure would be worse than a false warning.
  if (first.is_sent !== true) {
    const dropReason = isRecord(first.drop_reason) ? first.drop_reason : {};
    const reason = readText(dropReason.code) ?? "not_sent";
    const delivery = first.is_sent === false ? "rejected" : "ambiguous";
    await afterPost?.(delivery, reason);
    return {
      sent: false,
      truncated: preparedText.truncated,
      delivery,
      reason,
      detail: { ...textDetail, twitchMessage: readText(dropReason.message) },
    };
  }

  await afterPost?.("sent", null);
  return { sent: true, truncated: preparedText.truncated, delivery: "sent", reason: null, detail: { messageId: readText(first.message_id), ...textDetail } };
};
