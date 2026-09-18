import { decryptJson, encryptJson, parseKeyRing, signJson, verifyJson } from "./crypto";

export const SESSION_COOKIE_NAME = "__Host-brobot_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface SessionCookiePayload {
  sessionId: string;
}

const isSessionCookiePayload = (value: unknown): value is SessionCookiePayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.sessionId === "string" && payload.sessionId.length > 0;
};

export const createSessionCookie = async (
  payload: SessionCookiePayload,
  cookieKeysSerialized: string,
  encryptionKeysSerialized: string,
): Promise<string> => {
  const encrypted = await encryptJson(payload, parseKeyRing(encryptionKeysSerialized));
  return signJson(encrypted, parseKeyRing(cookieKeysSerialized));
};

export const readSessionCookie = async (
  serialized: string,
  cookieKeysSerialized: string,
  encryptionKeysSerialized: string,
): Promise<SessionCookiePayload | null> => {
  const encrypted = await verifyJson<string>(serialized, parseKeyRing(cookieKeysSerialized));
  if (encrypted === null) return null;
  const payload = await decryptJson<SessionCookiePayload>(encrypted, parseKeyRing(encryptionKeysSerialized));
  if (!isSessionCookiePayload(payload)) return null;
  return payload;
};

export const serializeSessionCookie = (
  value: string,
  maxAge: number = SESSION_COOKIE_MAX_AGE_SECONDS,
): string =>
  `${SESSION_COOKIE_NAME}=${value}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearSessionCookie = (): string => serializeSessionCookie("", 0);

export const readCookieValue = (cookieHeader: string | null, name: string): string | null => {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
};
