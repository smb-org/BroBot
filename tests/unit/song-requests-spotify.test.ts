import { describe, expect, it, vi } from "vitest";

import {
  refreshSpotifyToken,
  exchangeSpotifyCode,
  spotifyApiRequest,
  spotifyAuthorizationUrl,
  spotifyBases,
  spotifySearchTracks,
} from "../../src/modules/song_requests/adapters/spotify";
import { spotifyTrackIdFromInput } from "../../src/modules/song_requests/domain/track";

const textOf = (value: unknown): string => typeof value === "string" ? value : value instanceof URL ? value.href : value instanceof URLSearchParams ? value.toString() : "";

const track = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover", width: 640, height: 640 }] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};

describe("Spotify adapter", () => {
  it("uses development endpoint overrides and ignores them in production", () => {
    expect(spotifyBases({ APP_ENV: "local", SPOTIFY_API_BASE: "http://127.0.0.1:8791/v1", SPOTIFY_ACCOUNTS_BASE: "http://127.0.0.1:8791" }))
      .toEqual({ api: "http://127.0.0.1:8791/v1", accounts: "http://127.0.0.1:8791" });
    expect(spotifyBases({ APP_ENV: "production", SPOTIFY_API_BASE: "http://127.0.0.1:8791/v1", SPOTIFY_ACCOUNTS_BASE: "http://127.0.0.1:8791" }))
      .toEqual({ api: "https://api.spotify.com/v1", accounts: "https://accounts.spotify.com" });
    expect(spotifyBases({ APP_ENV: "staging", SPOTIFY_API_BASE: "http://127.0.0.1:8791/v1", SPOTIFY_ACCOUNTS_BASE: "http://127.0.0.1:8791" }))
      .toEqual({ api: "https://api.spotify.com/v1", accounts: "https://accounts.spotify.com" });
  });

  it("builds the authorization-code request without PKCE parameters", () => {
    const url = new URL(spotifyAuthorizationUrl({ SPOTIFY_CLIENT_ID: "fictional-client" }, "https://brobot.example/auth/spotify/callback", "signed-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://brobot.example/auth/spotify/callback");
    expect(url.searchParams.get("scope")).toBe("user-modify-playback-state user-read-playback-state user-read-currently-playing");
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("searches with Spotify's ten-track shape and preserves its returned tracks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ tracks: { items: [track], total: 1, limit: 10, offset: 0 } }), { status: 200 }));
    const result = await spotifySearchTracks({ SPOTIFY_API_BASE: "https://spotify.example/v1" }, "access-token", "Glass Harbor", fetcher);
    const calledUrl = new URL(textOf(fetcher.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe("/v1/search");
    expect(calledUrl.searchParams.get("type")).toBe("track");
    expect(calledUrl.searchParams.get("limit")).toBe("10");
    expect(calledUrl.searchParams.get("q")).toBe("Glass Harbor");
    expect(result).toEqual([track]);
  });

  it("sends a refresh grant and accepts a response without a replacement refresh token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: "refreshed-access", token_type: "Bearer", scope: "user-read-currently-playing", expires_in: 3600,
    }), { status: 200 }));
    const result = await refreshSpotifyToken({ SPOTIFY_CLIENT_ID: "fictional-client", SPOTIFY_CLIENT_SECRET: "fictional-secret" }, "existing-refresh", fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://accounts.spotify.com/api/token", expect.objectContaining({ method: "POST" }));
    expect(textOf((fetcher.mock.calls[0]?.[1] as RequestInit).body)).toContain("refresh_token=existing-refresh");
    expect(result.refresh_token).toBeUndefined();
  });

  it("exchanges an authorization code with Basic auth and no verifier", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-token", token_type: "Bearer", scope: "user-read-playback-state", expires_in: 3600,
      refresh_token: "refresh-token",
    }), { status: 200 }));
    await exchangeSpotifyCode({ SPOTIFY_CLIENT_ID: "fictional-client", SPOTIFY_CLIENT_SECRET: "fictional-secret" },
      "https://brobot.example/auth/spotify/callback", "authorization-code", fetcher);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("fictional-client:fictional-secret")}`);
    expect(textOf(init.body)).toContain("grant_type=authorization_code");
    expect(textOf(init.body)).not.toContain("code_verifier");
  });

  it("maps Spotify's no-device, Premium, forbidden-scope, retry, and invalid-grant errors", async () => {
    const cases = [
      { status: 404, body: { error: { status: 404, message: "No device", reason: "NO_ACTIVE_DEVICE" } }, retry: null },
      { status: 403, body: { error: { status: 403, message: "Premium required", reason: "PREMIUM_REQUIRED" } }, retry: null },
      { status: 403, body: { error: { status: 403, message: "User not registered" } }, retry: null },
      { status: 429, body: { error: { status: 429, message: "Rate limited" } }, retry: "3" },
    ];
    for (const entry of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(entry.body), {
        status: entry.status,
        headers: entry.retry === null ? {} : { "Retry-After": entry.retry },
      }));
      await expect(spotifyApiRequest({ SPOTIFY_API_BASE: "https://spotify.example/v1" }, "token", "me/player/queue?uri=spotify%3Atrack%3Aglassharbor01", { method: "POST" }, fetcher))
        .rejects.toMatchObject({ status: entry.status, reason: (entry.body.error as { reason?: string }).reason ?? null,
          retryAfterMs: entry.retry === null ? null : Number(entry.retry) * 1000 });
    }
    const invalidGrantFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant", error_description: "Expired" }), { status: 400 }));
    await expect(refreshSpotifyToken({ SPOTIFY_CLIENT_ID: "client", SPOTIFY_CLIENT_SECRET: "secret" }, "old-refresh", invalidGrantFetch))
      .rejects.toMatchObject({ status: 400, reason: "invalid_grant" });
  });

  it("accepts only HTTPS Spotify track links and base62 Spotify track URIs", () => {
    expect(spotifyTrackIdFromInput("https://open.spotify.com/track/glassharbor01?si=fictional")).toBe("glassharbor01");
    expect(spotifyTrackIdFromInput("spotify:track:glassharbor01")).toBe("glassharbor01");
    expect(spotifyTrackIdFromInput("http://open.spotify.com/track/glassharbor01")).toBeNull();
    expect(spotifyTrackIdFromInput("https://open.spotify.com/track/glass_harbor")).toBeNull();
  });
});
