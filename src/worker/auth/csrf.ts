import { parseKeyRing, signJson, verifyJson } from "./crypto";
import { readCookieValue } from "./session";

export const CSRF_COOKIE_NAME = "__Host-brobot_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";
export const CSRF_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

interface CsrfPayload {
  sessionId: string;
  expiresAt: string;
}

const expiresAt = (now: string): string =>
  new Date(Date.parse(now) + CSRF_TOKEN_MAX_AGE_SECONDS * 1000).toISOString();

const isCsrfPayload = (value: unknown): value is CsrfPayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.sessionId === "string" && payload.sessionId.length > 0 &&
    typeof payload.expiresAt === "string" && Number.isFinite(Date.parse(payload.expiresAt));
};

export const createCsrfToken = async (
  sessionId: string,
  cookieKeysSerialized: string,
  now: string,
): Promise<string> => signJson(
  { sessionId, expiresAt: expiresAt(now) },
  parseKeyRing(cookieKeysSerialized),
);

export const verifyCsrfToken = async (
  serialized: string,
  sessionId: string,
  cookieKeysSerialized: string,
  now: string,
): Promise<boolean> => {
  const payload = await verifyJson<CsrfPayload>(serialized, parseKeyRing(cookieKeysSerialized));
  const expiresAtMs = isCsrfPayload(payload) ? Date.parse(payload.expiresAt) : Number.NaN;
  const nowMs = Date.parse(now);
  return isCsrfPayload(payload) && payload.sessionId === sessionId &&
    Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
};

export const serializeCsrfCookie = (
  value: string,
  maxAge: number = CSRF_TOKEN_MAX_AGE_SECONDS,
): string =>
  `${CSRF_COOKIE_NAME}=${value}; Max-Age=${String(maxAge)}; Path=/; Secure; SameSite=Lax`;

export const verifyCsrfRequest = async (
  request: Request,
  sessionId: string,
  cookieKeysSerialized: string,
  now: string,
): Promise<boolean> => {
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  const cookieToken = readCookieValue(request.headers.get("Cookie"), CSRF_COOKIE_NAME);
  if (headerToken === null || cookieToken === null || headerToken !== cookieToken) return false;
  return verifyCsrfToken(headerToken, sessionId, cookieKeysSerialized, now);
};
