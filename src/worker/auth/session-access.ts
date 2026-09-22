import {
  getSessionWithLoginIdentity,
  type SessionRecord,
} from "../db/sessions";
import {
  SESSION_COOKIE_NAME,
  readCookieValue,
  readSessionCookie,
} from "./session";
import { getTokenEncryptionKeys } from "./crypto";

export const getSessionFromRequest = async (
  request: Request,
  env: Env,
): Promise<SessionRecord | null> => {
  const serialized = readCookieValue(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (serialized === null) return null;
  const session = await readSessionCookie(
    serialized,
    env.SESSION_COOKIE_KEYS,
    getTokenEncryptionKeys(env),
  );
  if (session === null) return null;
  const stored = await getSessionWithLoginIdentity(env.DB, session.sessionId);
  const expiresAt = stored === null ? Number.NaN : Date.parse(stored.expiresAt);
  if (stored === null || stored.revokedAt !== null || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return stored;
};
