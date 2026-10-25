import { decryptJson, getTokenEncryptionKeys, parseKeyRing, type TokenEncryptionEnvironment } from "../auth/crypto";
import { getBotIdentity } from "../db/bot-identity";

export interface BotAccessEnvironment extends TokenEncryptionEnvironment {
  DB: D1Database;
}

const parseScopes = (serialized: string): string[] => {
  try {
    const value: unknown = JSON.parse(serialized);
    return Array.isArray(value)
      ? value.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
};

export const botAccessTokenFor = async (
  environment: BotAccessEnvironment,
): Promise<{ userId: string; accessToken: string; scopes: string[] } | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const value = await decryptJson<{ token?: unknown }>(
    identity.accessTokenCiphertext,
    parseKeyRing(getTokenEncryptionKeys(environment)),
  );
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? { userId: identity.userId, accessToken: value.token, scopes: parseScopes(identity.scopesJson) }
    : null;
};
