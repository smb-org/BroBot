import { getTokenEncryptionKeys } from "./auth/crypto";
import { getBotIdentity } from "./auth/repository";
import { decryptStoredToken } from "./bot-maintenance";

const SHOUTOUT_URL = "https://api.twitch.tv/helix/chat/shoutouts";

export interface ShoutoutSendResult {
  sent: boolean;
  /** Maschinenlesbarer Grund, wenn der Versuch nicht erfolgreich war. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const responseBody = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    return asRecord(await response.json());
  } catch {
    return {};
  }
};

export const sendShoutout = async (
  environment: {
    DB: D1Database;
    TWITCH_CLIENT_ID: string;
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
  channelId: string,
  zielKanalId: string,
  fetcher: typeof fetch = fetch,
): Promise<ShoutoutSendResult> => {
  const detail = { von: channelId, nach: zielKanalId };
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return { sent: false, reason: "bot_identity_missing", detail };

  const accessToken = await decryptStoredToken(
    identity.accessTokenCiphertext,
    getTokenEncryptionKeys(environment),
  );
  if (accessToken === null) return { sent: false, reason: "bot_token_unreadable", detail };

  const url = new URL(SHOUTOUT_URL);
  // Absender ist der eigene Kanal, Empfaenger der Quellkanal des Raids.
  // Vertauscht wuerde Twitch mit 401 antworten: Der Bot ist dort kein Moderator.
  url.searchParams.set("from_broadcaster_id", channelId);
  url.searchParams.set("to_broadcaster_id", zielKanalId);
  url.searchParams.set("moderator_id", identity.userId);

  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      headers: {
        "Client-ID": environment.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return { sent: false, reason: "network_error", detail };
  }

  const body = await responseBody(response);
  if (!response.ok) {
    return {
      sent: false,
      reason: response.status === 429 ? "rate_limited" : `http_${String(response.status)}`,
      detail: { ...detail, status: response.status, message: readText(body.message) },
    };
  }

  return { sent: true, reason: null, detail: { ...detail, status: response.status } };
};
