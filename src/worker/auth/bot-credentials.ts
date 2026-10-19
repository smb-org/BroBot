import { decryptStoredToken } from "../bot-maintenance";
import { getTokenEncryptionKeys } from "./crypto";
import { getBotIdentity } from "../db/bot-identity";

export const readBotCredentials = async (
  environment: {
    DB: Env["DB"];
    TOKEN_ENCRYPTION_KEYS?: string;
    SESSION_ENCRYPTION_KEYS?: string;
  },
): Promise<{ userId: string; accessToken: string } | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(environment));
  return accessToken === null ? null : { userId: identity.userId, accessToken };
};
