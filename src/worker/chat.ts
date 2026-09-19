import { getTokenEncryptionKeys } from "./auth/crypto";
import { getBotIdentity } from "./auth/repository";
import { decryptStoredToken } from "./bot-maintenance";

const CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";

export interface ChatSendResult {
  sent: boolean;
  /** Maschinenlesbarer Grund, wenn nicht gesendet wurde. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Sendet eine Chatnachricht im Namen des Bots.
 *
 * Twitch antwortet auch dann mit HTTP 200, wenn die Nachricht verworfen wurde
 * — etwa durch AutoMod. Der Ausgang steht dann in `data[0].is_sent` samt
 * `drop_reason`. Wer nur den Statuscode auswertet, protokolliert einen
 * Fehlschlag als Erfolg; genau das soll das Ereignisprotokoll verhindern.
 */
export const sendChatMessage = async (
  environment: {
    DB: D1Database;
    TWITCH_CLIENT_ID: string;
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
  channelId: string,
  text: string,
  replyToMessageId: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<ChatSendResult> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) {
    return { sent: false, reason: "bot_identity_missing", detail: {} };
  }
  const accessToken = await decryptStoredToken(
    identity.accessTokenCiphertext,
    getTokenEncryptionKeys(environment),
  );
  if (accessToken === null) {
    return { sent: false, reason: "bot_token_unreadable", detail: {} };
  }

  const payload: Record<string, string> = {
    broadcaster_id: channelId,
    sender_id: identity.userId,
    message: text,
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
    });
  } catch {
    return { sent: false, reason: "network_error", detail: {} };
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
      detail: { status: response.status, message: readText(record.message) },
    };
  }

  const first = asRecord(asRecord(body).data instanceof Array
    ? (asRecord(body).data as unknown[])[0]
    : null);

  // Fehlt `is_sent`, ist der Ausgang unbekannt. Unbekannt gilt hier als nicht
  // gesendet: Ein stiller Fehlschlag wäre schlimmer als eine falsche Warnung.
  if (first.is_sent !== true) {
    const dropReason = asRecord(first.drop_reason);
    return {
      sent: false,
      reason: readText(dropReason.code) ?? "not_sent",
      detail: { message: readText(dropReason.message) },
    };
  }

  return { sent: true, reason: null, detail: { messageId: readText(first.message_id) } };
};
