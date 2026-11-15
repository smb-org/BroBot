import { afterEach, describe, expect, it, vi } from "vitest";

import { beginSpotifyOAuth } from "../../src/modules/song_requests/adapters/oauth-transactions";
import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-oauth-role";
const USER_ID = "manager-fictional";
const SESSION_KEYS = JSON.stringify({ active: { id: "oauth-cookie", key: testKey(31) }, retired: [] });
const ENCRYPTION_KEYS = JSON.stringify({ active: { id: "oauth-encryption", key: testKey(32) }, retired: [] });
const databases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Spotify callback authorization", () => {
  it.each([
    { name: "a channel member without management rights", role: "operator" as const, insertMember: true },
    { name: "a user who is not a channel member", role: null, insertMember: false },
  ])("rejects $name", async ({ role, insertMember: shouldInsertMember }) => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, USER_ID);
    if (shouldInsertMember && role !== null) await insertMember(database, CHANNEL_ID, USER_ID, role);
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, USER_ID, "2026-11-15T19:00:00.000Z").run();

    const environment = {
      DB: database as unknown as D1Database,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({}) },
      PUBLIC_ORIGIN: "https://brobot.example",
      APP_ENV: "local",
      SESSION_COOKIE_KEYS: SESSION_KEYS,
      TOKEN_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
      SPOTIFY_CLIENT_ID: "fictional-spotify-client",
      SPOTIFY_CLIENT_SECRET: "fictional-spotify-secret",
    } as unknown as Env;
    const started = await beginSpotifyOAuth(database as unknown as D1Database, environment, CHANNEL_ID, USER_ID,
      "https://brobot.example/auth/spotify/callback", new Date().toISOString());
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const sessionCookie = await createSessionCookie({ sessionId: `session-${USER_ID}` }, SESSION_KEYS, ENCRYPTION_KEYS);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await authRouter.fetch(new Request(
      `https://brobot.example/auth/spotify/callback?state=${encodeURIComponent(state ?? "")}&code=fictional-code`,
      { headers: { Cookie: `__Host-brobot_spotify_oauth_state=${started.stateNonce}; __Host-brobot_session=${sessionCookie}` } },
    ), environment);

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("schedules playback polling when Spotify connects during a live stream", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, USER_ID);
    await insertMember(database, CHANNEL_ID, USER_ID, "manager");
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, USER_ID, "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", "stream-fictional-live", "2026-11-15T19:00:00.000Z").run();

    const scheduleModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ scheduleModuleAlarm }) },
      PUBLIC_ORIGIN: "https://brobot.example",
      APP_ENV: "local",
      SESSION_COOKIE_KEYS: SESSION_KEYS,
      TOKEN_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
      SPOTIFY_CLIENT_ID: "fictional-spotify-client",
      SPOTIFY_CLIENT_SECRET: "fictional-spotify-secret",
    } as unknown as Env;
    const started = await beginSpotifyOAuth(database as unknown as D1Database, environment, CHANNEL_ID, USER_ID,
      "https://brobot.example/auth/spotify/callback", new Date().toISOString());
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const sessionCookie = await createSessionCookie({ sessionId: `session-${USER_ID}` }, SESSION_KEYS, ENCRYPTION_KEYS);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: "fictional-spotify-access",
      token_type: "Bearer",
      scope: "user-modify-playback-state user-read-playback-state user-read-currently-playing",
      expires_in: 3600,
      refresh_token: "fictional-spotify-refresh",
    }), { status: 200 })));

    const response = await authRouter.fetch(new Request(
      `https://brobot.example/auth/spotify/callback?state=${encodeURIComponent(state ?? "")}&code=fictional-code`,
      { headers: { Cookie: `__Host-brobot_spotify_oauth_state=${started.stateNonce}; __Host-brobot_session=${sessionCookie}` } },
    ), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/channels/song-requests-oauth-role/modules/song_requests?spotify=connected");
    expect(scheduleModuleAlarm).toHaveBeenCalledWith("song_requests", "poll", "poll", expect.any(Number));
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "connected" });
  });

  it("rejects the callback when its manager loses management rights before returning", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, USER_ID);
    await insertMember(database, CHANNEL_ID, USER_ID, "manager");
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, USER_ID, "2026-11-15T19:00:00.000Z").run();
    const environment = {
      DB: database as unknown as D1Database,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({}) },
      PUBLIC_ORIGIN: "https://brobot.example",
      APP_ENV: "local",
      SESSION_COOKIE_KEYS: SESSION_KEYS,
      TOKEN_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
      SPOTIFY_CLIENT_ID: "fictional-spotify-client",
      SPOTIFY_CLIENT_SECRET: "fictional-spotify-secret",
    } as unknown as Env;
    const started = await beginSpotifyOAuth(database as unknown as D1Database, environment, CHANNEL_ID, USER_ID,
      "https://brobot.example/auth/spotify/callback", new Date().toISOString());
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = ? AND user_id = ?")
      .bind(CHANNEL_ID, USER_ID).run();
    const sessionCookie = await createSessionCookie({ sessionId: `session-${USER_ID}` }, SESSION_KEYS, ENCRYPTION_KEYS);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await authRouter.fetch(new Request(
      `https://brobot.example/auth/spotify/callback?state=${encodeURIComponent(state ?? "")}&code=fictional-code`,
      { headers: { Cookie: `__Host-brobot_spotify_oauth_state=${started.stateNonce}; __Host-brobot_session=${sessionCookie}` } },
    ), environment);

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT count(*) AS count FROM module_secrets WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).first()).toEqual({ count: 0 });
  });
});
