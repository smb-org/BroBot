import {
  getBotIdentity,
} from "./db/bot-identity";
import { getAppAccessToken } from "./app-token";
import { kuerzeAuf200Zeichen } from "../modules/contract";

const CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";

/**
 * Twitch expects a response to the EventSub webhook within ten seconds, and
 * this call is awaited there (`dispatch.ts`). Without a timeout, a hanging
 * Helix call costs the subscription. Goes away once the Helix wrapper lands.
 */
const HELIX_REQUEST_TIMEOUT_MS = 5_000;


export interface ChatSendResult {
  sent: boolean;
  /** Machine-readable reason when the message was not sent. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

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
): Promise<ChatSendResult> => {
  const textDetail = { text: kuerzeAuf200Zeichen(text) };
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) {
    return { sent: false, reason: "bot_identity_missing", detail: textDetail };
  }
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(
      environment as unknown as Env,
      new Date().toISOString(),
      fetcher,
    );
  } catch {
    return { sent: false, reason: "app_token_unavailable", detail: textDetail };
  }

  const payload: Record<string, string | boolean> = {
    broadcaster_id: channelId,
    sender_id: identity.userId,
    message: text,
    for_source_only: false,
  };
  if (replyToMessageId !== undefined) payload.reply_parent_message_id = replyToMessageId;

  let response: Response;
  try {
    response = await fetcher(CHAT_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Client-ID": environment.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HELIX_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { sent: false, reason: timedOut ? "timeout" : "network_error", detail: textDetail };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const record = asRecord(body);
    return {
      sent: false,
      reason: response.status === 429 ? "rate_limited" : `http_${String(response.status)}`,
      detail: { ...textDetail, status: response.status, message: readText(record.message) },
    };
  }

  const first = asRecord(asRecord(body).data instanceof Array
    ? (asRecord(body).data as unknown[])[0]
    : null);

  // If `is_sent` is missing, the outcome is unknown. Unknown counts as not
  // sent here: a silent failure would be worse than a false warning.
  if (first.is_sent !== true) {
    const dropReason = asRecord(first.drop_reason);
    return {
      sent: false,
      reason: readText(dropReason.code) ?? "not_sent",
      detail: { ...textDetail, message: readText(dropReason.message) },
    };
  }

  return { sent: true, reason: null, detail: { messageId: readText(first.message_id), ...textDetail } };
};
