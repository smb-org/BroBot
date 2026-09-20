import { createOAuthTransaction } from "./repository";
import { parseKeyRing, signJson, verifyJson } from "./crypto";

export const LOGIN_SCOPES = ["user:read:moderated_channels", "channel:bot"] as const;
export const BOT_SCOPES = [
  "user:bot",
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:shoutouts",
  "moderator:manage:announcements",
  "clips:edit",
  "moderator:read:chatters",
  "moderator:read:followers",
  "moderator:read:shoutouts",
  "moderator:manage:chat_messages",
  "user:read:moderated_channels",
  "moderator:manage:blocked_terms",
  "moderator:manage:chat_settings",
  "moderator:manage:unban_requests",
  "moderator:manage:banned_users",
  "moderator:manage:warnings",
  "moderator:read:moderators",
  "moderator:read:vips",
] as const;

export type OAuthPurpose = "login" | "bot";

export interface OAuthEnvironment {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  PUBLIC_ORIGIN: string;
  SESSION_COOKIE_KEYS: string;
}

export interface OAuthState {
  transactionId: string;
  purpose: OAuthPurpose;
  expiresAt: string;
}

export interface OAuthStart {
  url: string;
  state: string;
  transactionId: string;
  /** Gehoert in ein kurzlebiges Cookie; siehe OAUTH_STATE_COOKIE_NAME. */
  stateNonce: string;
}

/**
 * Der signierte `state` allein schuetzt nur gegen Wiederholung, nicht gegen
 * Unterschieben: Ein Angreifer kann seinen eigenen Login starten, die noch
 * unverbrauchte Callback-URL abfangen und das Opfer darauf schicken — das Opfer
 * ist danach als Angreifer angemeldet. Laut Spezifikation leistet der `state`
 * seinen CSRF-Schutz nur mit Bindung an den Browser.
 *
 * Deshalb traegt der `state` einen Nonce, dessen Gegenstueck nur im Browser des
 * Startenden liegt. Der Callback verlangt beides.
 */
export const OAUTH_STATE_COOKIE_NAME = "__Host-brobot_oauth_state";
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export const serializeOAuthStateCookie = (
  value: string,
  maxAge: number = OAUTH_STATE_MAX_AGE_SECONDS,
): string =>
  `${OAUTH_STATE_COOKIE_NAME}=${value}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearOAuthStateCookie = (): string => serializeOAuthStateCookie("", 0);

export interface TwitchTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

export interface TwitchUserIdentity {
  userId: string;
  login: string;
}

export class OAuthExchangeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

const encodeBase64url = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const randomToken = (size: number): string => encodeBase64url(crypto.getRandomValues(new Uint8Array(size)));

const redirectUri = (origin: string): string => `${origin.replace(/\/+$/, "")}/auth/twitch/callback`;

const stateExpiresAt = (now: string): string => new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();

interface SignedOAuthState extends OAuthState {
  nonce: string;
}

const isSignedOAuthState = (value: unknown): value is SignedOAuthState => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.transactionId === "string" && state.transactionId.length > 0 &&
    (state.purpose === "login" || state.purpose === "bot") &&
    typeof state.expiresAt === "string" && Number.isFinite(Date.parse(state.expiresAt)) &&
    typeof state.nonce === "string" && state.nonce.length > 0;
};

/**
 * Vergleich in konstanter Zeit, damit der Nonce nicht ueber die Laufzeit
 * erraten werden kann.
 */
const equalsConstantTime = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
};

export const startOAuthAuthorization = async (
  db: D1Database,
  environment: OAuthEnvironment,
  purpose: OAuthPurpose,
  now: string,
): Promise<OAuthStart> => {
  const transactionId = randomToken(24);
  const stateNonce = randomToken(24);
  const expiresAt = stateExpiresAt(now);
  const state = await signJson(
    { transactionId, purpose, expiresAt, nonce: stateNonce },
    parseKeyRing(environment.SESSION_COOKIE_KEYS),
  );

  await createOAuthTransaction(db, {
    transactionId,
    purpose,
    expiresAt,
    createdAt: now,
  });

  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", environment.TWITCH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(environment.PUBLIC_ORIGIN));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (purpose === "login" ? LOGIN_SCOPES : BOT_SCOPES).join(" "));
  url.searchParams.set("state", state);
  return { url: url.toString(), state, transactionId, stateNonce };
};

/**
 * `cookieNonce` stammt aus OAUTH_STATE_COOKIE_NAME. Fehlt er oder passt er
 * nicht, stammt der Aufruf nicht aus dem Browser, der den Login gestartet hat.
 */
export const verifyOAuthState = async (
  serialized: string,
  cookieKeysSerialized: string,
  now: string,
  cookieNonce: string | null,
): Promise<OAuthState | null> => {
  const state = await verifyJson<SignedOAuthState>(serialized, parseKeyRing(cookieKeysSerialized));
  const expiresAtMs = isSignedOAuthState(state) ? Date.parse(state.expiresAt) : Number.NaN;
  const nowMs = Date.parse(now);
  if (!isSignedOAuthState(state) || !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) return null;
  if (cookieNonce === null || !equalsConstantTime(state.nonce, cookieNonce)) return null;
  return { transactionId: state.transactionId, purpose: state.purpose, expiresAt: state.expiresAt };
};

interface TwitchTokenApiResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

const isTwitchTokenResponse = (value: unknown): value is TwitchTokenApiResponse => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return typeof token.access_token === "string" && token.access_token.length > 0 &&
    typeof token.refresh_token === "string" && token.refresh_token.length > 0 &&
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in) && token.expires_in > 0 &&
    Array.isArray(token.scope) && token.scope.every((scope: unknown): scope is string => typeof scope === "string");
};

export const exchangeAuthorizationCode = async (
  fetcher: typeof fetch,
  environment: OAuthEnvironment,
  code: string,
): Promise<TwitchTokenResponse> => {
  const response = await fetcher("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: environment.TWITCH_CLIENT_ID,
      client_secret: environment.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(environment.PUBLIC_ORIGIN),
    }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthExchangeError("Twitch-Code-Tausch wurde abgelehnt.");
  }
  if (!response.ok || !isTwitchTokenResponse(body)) {
    throw new OAuthExchangeError("Twitch-Code-Tausch wurde abgelehnt.");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    scopes: body.scope,
  };
};

interface TwitchUserApiResponse {
  data?: unknown;
}

export const fetchTwitchUser = async (
  fetcher: typeof fetch,
  environment: OAuthEnvironment,
  accessToken: string,
): Promise<TwitchUserIdentity> => {
  const response = await fetcher("https://api.twitch.tv/helix/users", {
    headers: {
      "Client-ID": environment.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  let body: TwitchUserApiResponse;
  try {
    const rawBody: unknown = await response.json();
    if (rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)) {
      body = { data: "data" in rawBody ? rawBody.data : undefined };
    } else {
      body = {};
    }
  } catch {
    throw new Error("Twitch-Identität konnte nicht gelesen werden.");
  }
  const data: unknown[] = Array.isArray(body.data)
    ? body.data.map((entry: unknown): unknown => entry)
    : [];
  const first = data[0] ?? null;
  if (first === null || typeof first !== "object") {
    throw new Error("Twitch-Identität konnte nicht gelesen werden.");
  }
  const user = first as Record<string, unknown>;
  if (!response.ok || typeof user.id !== "string" || typeof user.login !== "string") {
    throw new Error("Twitch-Identität konnte nicht gelesen werden.");
  }
  return { userId: user.id, login: user.login };
};
