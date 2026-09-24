import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "../auth/crypto";
import { getBotIdentity } from "../db/bot-identity";
import { helixRequest } from "./helix";
import type { TwitchUser } from "../shoutout";

interface JsonRecord {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is JsonRecord =>
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

/** Resolve display names in one Helix request per 100 users, if the bot identity is available. */
export const fetchTwitchUsersById = async (
  fetcher: typeof fetch,
  environment: Env,
  userIds: string[],
): Promise<Map<string, TwitchUser>> => {
  const resolved = new Map<string, TwitchUser>();
  if (userIds.length === 0) return resolved;

  try {
    const accessToken = await readStoredBotAccessToken(environment);
    if (accessToken === null) return resolved;
    for (let offset = 0; offset < userIds.length; offset += 100) {
      const url = new URL("https://api.twitch.tv/helix/users");
      for (const userId of userIds.slice(offset, offset + 100)) url.searchParams.append("id", userId);
      const result = await helixRequest<JsonRecord>({
        url: url.toString(),
        accessToken,
        clientId: environment.TWITCH_CLIENT_ID,
        fetcher,
      });
      if (!result.ok || !Array.isArray(result.data.data)) break;
      for (const entry of result.data.data as unknown[]) {
        if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.login !== "string" ||
            typeof entry.display_name !== "string") continue;
        resolved.set(entry.id, {
          userId: entry.id,
          login: entry.login,
          displayName: entry.display_name,
          profileImageUrl: typeof entry.profile_image_url === "string" && entry.profile_image_url.length > 0
            ? entry.profile_image_url
            : null,
        });
      }
    }
  } catch {
    return resolved;
  }
  return resolved;
};
