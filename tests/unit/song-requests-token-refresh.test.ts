import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import { SONG_REQUESTS_CREDENTIAL_SECRET, spotifyAccessToken } from "../../src/modules/song_requests/service";
import { createModuleSecretAccess } from "../../src/worker/module-secrets";
import { insertChannel, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-token-refresh";
const ACTOR_ID = "manager-fictional";
const ENCRYPTION_KEYS = JSON.stringify({ active: { id: "spotify-secret-key", key: testKey(44) }, retired: [] });
const databases: TestD1Database[] = [];
const NOW = Date.parse("2026-11-15T20:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

const credentialsFor = async (database: TestD1Database, refreshToken: string): Promise<ModuleAlarmContext> => {
  await insertChannel(database, CHANNEL_ID);
  await insertMember(database, CHANNEL_ID, ACTOR_ID, "manager");
  await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
    .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
  const environment = {
    DB: database as unknown as D1Database,
    APP_ENV: "local",
    SPOTIFY_CLIENT_ID: "fictional-client",
    SPOTIFY_CLIENT_SECRET: "fictional-secret",
    TOKEN_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
  } as unknown as Env;
  const secrets = createModuleSecretAccess(environment, CHANNEL_ID, "song_requests");
  const write = await secrets.prepareWrite(SONG_REQUESTS_CREDENTIAL_SECRET, JSON.stringify({
    accessToken: "expired-access-token",
    refreshToken,
    expiresAt: NOW - 1,
  }), { userId: ACTOR_ID }, new Date(NOW - 60_000).toISOString());
  await database.batch([write]);
  return { DB: database as unknown as D1Database, channelId: CHANNEL_ID, environment, secrets } as unknown as ModuleAlarmContext;
};

describe("Spotify access token refresh", () => {
  it("keeps the previous refresh token when Spotify omits a replacement", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const context = await credentialsFor(database, "refresh-token-original");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-token-refreshed",
      token_type: "Bearer",
      scope: "user-read-currently-playing",
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(spotifyAccessToken(context, NOW)).resolves.toBe("access-token-refreshed");
    const stored = await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored?.value ?? "{}")).toMatchObject({ refreshToken: "refresh-token-original", accessToken: "access-token-refreshed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the latest stored token after a rotation write loses its version claim", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const context = await credentialsFor(database, "refresh-token-original");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      const write = await context.secrets.prepareWrite!(SONG_REQUESTS_CREDENTIAL_SECRET, JSON.stringify({
        accessToken: "access-token-from-other-rotation",
        refreshToken: "refresh-token-from-other-rotation",
        expiresAt: NOW + 3_600_000,
      }), { userId: ACTOR_ID }, new Date(NOW).toISOString());
      await database.batch([write]);
      return new Response(JSON.stringify({
        access_token: "stale-access-token-from-lost-rotation",
        token_type: "Bearer",
        scope: "user-read-currently-playing",
        expires_in: 3600,
        refresh_token: "stale-refresh-token-from-lost-rotation",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(spotifyAccessToken(context, NOW)).resolves.toBe("access-token-from-other-rotation");
    const stored = await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET);
    expect(JSON.parse(stored?.value ?? "{}")).toMatchObject({
      accessToken: "access-token-from-other-rotation",
      refreshToken: "refresh-token-from-other-rotation",
    });
  });

  it("marks the connection as reconnect required when Spotify returns invalid_grant", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const context = await credentialsFor(database, "refresh-token-expired");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "The refresh token expired.",
    }), { status: 400 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(spotifyAccessToken(context, NOW)).resolves.toBeNull();
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "reconnect_required" });
  });
});
