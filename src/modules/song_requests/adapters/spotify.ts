import type { SpotifyTrack } from "../domain/track";

declare global {
  interface Env {
    SPOTIFY_API_BASE?: string;
    SPOTIFY_ACCOUNTS_BASE?: string;
  }
}

export type SpotifyEnvironment = Partial<Pick<Env,
  "APP_ENV" | "SPOTIFY_CLIENT_ID" | "SPOTIFY_CLIENT_SECRET" | "SPOTIFY_API_BASE" | "SPOTIFY_ACCOUNTS_BASE"
>>;

export interface SpotifyToken {
  access_token: string;
  token_type: "Bearer";
  scope: string;
  expires_in: 3600;
  refresh_token?: string;
}

export class SpotifyRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly reason: string | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "SpotifyRequestError";
  }
}

const configuredBase = (override: string | undefined, allowOverride: boolean, fallback: string): string => {
  if (!allowOverride || override === undefined || override.length === 0) return fallback;
  const url = new URL(override);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new Error("Spotify endpoint override is invalid.");
  }
  return url.toString().replace(/\/+$/u, "");
};

const SPOTIFY_REQUEST_TIMEOUT_MS = 10_000;

export const spotifyBases = (environment: SpotifyEnvironment) => {
  const allowOverride = environment.APP_ENV === "local";
  return {
    api: configuredBase(environment.SPOTIFY_API_BASE, allowOverride, "https://api.spotify.com/v1"),
    accounts: configuredBase(environment.SPOTIFY_ACCOUNTS_BASE, allowOverride, "https://accounts.spotify.com"),
  };
};

const errorFrom = async (response: Response): Promise<SpotifyRequestError> => {
  let message = "Spotify request failed.";
  let reason: string | null = null;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const details = error as Record<string, unknown>;
        if (typeof details.message === "string") message = details.message.slice(0, 200);
        if (typeof details.reason === "string") reason = details.reason;
      }
    }
  } catch { /* Keep the fixed fallback text. */ }
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfter = retryAfterHeader === null || retryAfterHeader.trim() === "" ? Number.NaN : Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : null;
  return new SpotifyRequestError(message, response.status, reason, retryAfterMs);
};

export const spotifyApiRequest = async (
  environment: SpotifyEnvironment,
  accessToken: string,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> => {
  const { api } = spotifyBases(environment);
  const url = new URL(`${api}/${path.replace(/^\/+/, "")}`);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetcher(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(SPOTIFY_REQUEST_TIMEOUT_MS) });
  if (!response.ok && response.status !== 204) throw await errorFrom(response);
  return response;
};

export const spotifySearchTracks = async (
  environment: SpotifyEnvironment,
  accessToken: string,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpotifyTrack[]> => {
  const url = new URL(`${spotifyBases(environment).api}/search`);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "10");
  url.searchParams.set("q", query.trim());
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(SPOTIFY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await errorFrom(response);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const tracks = (payload as Record<string, unknown>).tracks;
  if (typeof tracks !== "object" || tracks === null || Array.isArray(tracks)) return [];
  const items = (tracks as Record<string, unknown>).items;
  return Array.isArray(items) ? items.filter((item): item is SpotifyTrack =>
    typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string" &&
    typeof (item as Record<string, unknown>).uri === "string") : [];
};

export const spotifySkipCurrentTrack = async (
  environment: SpotifyEnvironment,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  await spotifyApiRequest(environment, accessToken, "me/player/next", { method: "POST" }, fetcher);
};

const formRequest = async (
  environment: SpotifyEnvironment,
  form: URLSearchParams,
  fetcher: typeof fetch,
): Promise<SpotifyToken> => {
  const clientId = environment.SPOTIFY_CLIENT_ID;
  const clientSecret = environment.SPOTIFY_CLIENT_SECRET;
  if (clientId === undefined || clientId.length === 0 || clientSecret === undefined || clientSecret.length === 0) {
    throw new Error("Spotify OAuth is not configured.");
  }
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetcher(`${spotifyBases(environment).accounts}/api/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(SPOTIFY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    let body: unknown = null;
    try { body = await response.json(); } catch { /* Keep the provider response opaque. */ }
    const invalidGrant = typeof body === "object" && body !== null && !Array.isArray(body) &&
      (body as Record<string, unknown>).error === "invalid_grant";
    throw new SpotifyRequestError(invalidGrant ? "Spotify authorization must be renewed." : "Spotify token exchange failed.", response.status, invalidGrant ? "invalid_grant" : null);
  }
  return await response.json<SpotifyToken>();
};

export const spotifyAuthorizationUrl = (
  environment: SpotifyEnvironment,
  redirectUri: string,
  state: string,
): string => {
  const url = new URL(`${spotifyBases(environment).accounts}/authorize`);
  url.searchParams.set("client_id", environment.SPOTIFY_CLIENT_ID ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "user-modify-playback-state user-read-playback-state user-read-currently-playing");
  url.searchParams.set("state", state);
  return url.toString();
};

export const exchangeSpotifyCode = async (
  environment: SpotifyEnvironment,
  redirectUri: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<SpotifyToken> => formRequest(environment, new URLSearchParams({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirectUri,
}), fetcher);

export const refreshSpotifyToken = async (
  environment: SpotifyEnvironment,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<SpotifyToken> => formRequest(environment, new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
}), fetcher);

export const spotifyTrackById = async (
  environment: SpotifyEnvironment,
  accessToken: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpotifyTrack> => {
  const response = await spotifyApiRequest(environment, accessToken, `tracks/${encodeURIComponent(id)}`, {}, fetcher);
  return await response.json<SpotifyTrack>();
};
