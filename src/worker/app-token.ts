import {
  getAppAccessToken as getStoredAppAccessToken,
  rotateAppAccessToken,
} from "./db/app-token";
import {
  decryptJson,
  encryptJson,
  getTokenEncryptionKeys,
  parseKeyRing,
} from "./auth/crypto";
import { logMaintenanceError, TwitchApiError } from "./bot-maintenance";
import { APP_TOKEN_REFRESH_THRESHOLD_MS } from "../maintenance-policy";

export interface AppTokenEnvironment {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

export interface AppAccessToken {
  accessToken: string;
  expiresIn: number;
}

const isFinitePositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const shouldRefreshAppAccessToken = (expiresAt: string, now: string): boolean => {
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) ||
    expiresAtMs <= nowMs + APP_TOKEN_REFRESH_THRESHOLD_MS;
};

export const requestAppAccessToken = async (
  fetcher: typeof fetch,
  environment: AppTokenEnvironment,
): Promise<AppAccessToken> => {
  const response = await fetcher("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: environment.TWITCH_CLIENT_ID,
      client_secret: environment.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const body = await responseJson(response);
  if (!response.ok || typeof body.access_token !== "string" || body.access_token.length === 0 ||
      !isFinitePositiveNumber(body.expires_in)) {
    throw new TwitchApiError(
      "Twitch-App-Token wurde abgelehnt.",
      response.status,
      typeof body.error === "string" ? body.error : null,
    );
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in };
};

const decryptAppAccessToken = async (
  ciphertext: string,
  keys: string,
): Promise<string | null> => {
  const value = await decryptJson<{ token: string }>(ciphertext, parseKeyRing(keys));
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? value.token
    : null;
};

const rotateWithRetry = async (
  db: D1Database,
  expectedCiphertext: string | null,
  ciphertext: string,
  expiresAt: string,
  createdAt: string,
  updatedAt: string,
): Promise<boolean> => {
  try {
    return await rotateAppAccessToken(
      db,
      expectedCiphertext,
      ciphertext,
      expiresAt,
      createdAt,
      updatedAt,
    );
  } catch (firstError: unknown) {
    try {
      return await rotateAppAccessToken(
        db,
        expectedCiphertext,
        ciphertext,
        expiresAt,
        createdAt,
        updatedAt,
      );
    } catch {
      throw firstError;
    }
  }
};

/** Fetches the encrypted app token or renews it via client credentials. */
export const getAppAccessToken = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const encryptionKeys = getTokenEncryptionKeys(env);
  const stored = await getStoredAppAccessToken(env.DB);
  if (stored !== null) {
    const token = await decryptAppAccessToken(stored.accessTokenCiphertext, encryptionKeys);
    if (token !== null && !shouldRefreshAppAccessToken(stored.expiresAt, now)) return token;
  }

  const requested = await requestAppAccessToken(fetcher, env);
  const expiresAt = new Date(Date.parse(now) + requested.expiresIn * 1000).toISOString();
  const ciphertext = await encryptJson(
    { token: requested.accessToken },
    parseKeyRing(encryptionKeys),
  );
  const replaced = await rotateWithRetry(
    env.DB,
    stored?.accessTokenCiphertext ?? null,
    ciphertext,
    expiresAt,
    stored?.createdAt ?? now,
    now,
  );
  if (replaced) return requested.accessToken;

  // Another worker was faster. Read the value that was just stored instead
  // of handing the caller a token that might already be stale.
  const current = await getStoredAppAccessToken(env.DB);
  if (current !== null) {
    const currentToken = await decryptAppAccessToken(current.accessTokenCiphertext, encryptionKeys);
    if (currentToken !== null) return currentToken;
  }
  throw new Error("App-Token konnte nach der Rotation nicht gelesen werden.");
};

export const maintainAppAccessToken = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  try {
    await getAppAccessToken(env, now, fetcher);
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "app-token", variant: "client-credentials" }, error);
    throw error;
  }
};
