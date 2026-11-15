import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleChatVoteStartRequest, ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { beginSpotifyOAuth, spotifyOAuthStateCookie } from "../../src/worker/auth/spotify-oauth";
import { insertChannel, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-open-vote";
const TRACK_IDS = ["glassharbor01", "quietatlas02"];
const databases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("song request routes", () => {
  it("starts reconnect OAuth without deleting the current Spotify credentials", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();

    const readCredential = vi.fn(() => Promise.resolve(JSON.stringify({ accessToken: "current-token", refreshToken: "current-refresh-token", expiresAt: 4_102_444_800_000 })));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "broadcaster");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-oauth" });
      context.set("beginSpotifyOAuth", async (channelId, memberUserId) => {
        const started = await beginSpotifyOAuth(context.env.DB, context.env, channelId, memberUserId, "https://brobot.example/auth/spotify/callback", new Date().toISOString());
        return { authorizationUrl: started.authorizationUrl, stateCookie: spotifyOAuthStateCookie(started.stateNonce) };
      });
      context.set("secrets", () => ({
        status: () => Promise.resolve({ configured: true, updatedAt: "2026-11-15T19:00:00.000Z" }),
        read: readCredential,
        readWithVersion: () => Promise.resolve(null),
        prepareWrite: () => Promise.resolve({} as D1PreparedStatement),
        prepareDelete: () => ({} as D1PreparedStatement),
      }));
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/oauth/start`, { method: "POST" }), {
      DB: database as unknown as D1Database,
      APP_ENV: "local",
      PUBLIC_ORIGIN: "https://brobot.example",
      SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "test-cookie", key: testKey(21) }, retired: [] }),
      SPOTIFY_CLIENT_ID: "fictional-client",
      SPOTIFY_CLIENT_SECRET: "fictional-secret",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
      },
    });

    expect(response.status).toBe(200);
    expect(readCredential).not.toHaveBeenCalled();
    const transactions = await database.prepare("SELECT state_id FROM spotify_oauth_transactions WHERE channel_id = ?").bind(CHANNEL_ID).all<{ state_id: string }>();
    expect(transactions.results).toHaveLength(1);
  });

  it("returns a clear conflict after truncating Spotify candidate labels", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", "stream-fictional-current", "2026-11-15T19:00:00.000Z").run();

    const spotifyTrack = (id: string) => ({
      id,
      uri: `spotify:track:${id}`,
      name: id === TRACK_IDS[0] ? "Glass Harbor candidate name longer than thirty-two characters" : "Quiet Atlas candidate name longer than thirty-two characters",
      duration_ms: 201_000,
      explicit: false,
      artists: [{ id: "miravale01", name: "Mira Vale" }],
      album: { name: "North Window", images: [] },
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const id = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1) ?? "glassharbor01";
      return Promise.resolve(new Response(JSON.stringify(spotifyTrack(id)), { status: 200 }));
    }));

    const startChatVote = vi.fn<(channelId: string, request: ModuleChatVoteStartRequest) => Promise<{ status: "busy" }>>(() => Promise.resolve({ status: "busy" }));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-vote" });
      context.set("secrets", () => ({
        status: () => Promise.resolve({ configured: true, updatedAt: null }),
        read: () => Promise.resolve(null),
        readWithVersion: () => Promise.resolve({
          value: JSON.stringify({ accessToken: "spotify-access-fictional", refreshToken: "spotify-refresh-fictional", expiresAt: Date.parse("2099-01-01T00:00:00.000Z") }),
          version: "encrypted-envelope-version",
        }),
        prepareWrite: () => Promise.resolve({} as D1PreparedStatement),
        prepareDelete: () => ({} as D1PreparedStatement),
      }));
      context.set("startChatVote", startChatVote);
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: TRACK_IDS }),
    }), {
      DB: database as unknown as D1Database,
      APP_ENV: "local",
      SPOTIFY_API_BASE: "https://spotify.example/v1",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "chat_vote_already_open" });
    expect(startChatVote).toHaveBeenCalledTimes(1);
    const labels = startChatVote.mock.calls[0]?.[1]?.labels ?? [];
    expect(labels).toHaveLength(2);
    expect(labels.every((label) => Array.from(label).length <= 32)).toBe(true);
    expect(await database.prepare("SELECT ballot_id FROM song_requests_votes").all()).toMatchObject({ results: [] });

    startChatVote.mockRejectedValueOnce(new RangeError("The candidate labels are invalid."));
    const invalidResponse = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: TRACK_IDS }),
    }), {
      DB: database as unknown as D1Database,
      APP_ENV: "local",
      SPOTIFY_API_BASE: "https://spotify.example/v1",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
      },
    });

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({ error: "song_vote_candidates_invalid" });
  });

  it("returns 400 for invalid candidate counts instead of starting a vote", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", "stream-fictional-current", "2026-11-15T19:00:00.000Z").run();
    const startChatVote = vi.fn();
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-vote-invalid" });
      context.set("startChatVote", startChatVote);
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: [...TRACK_IDS, ...TRACK_IDS, "silvercurrent03"] }),
    }), { DB: database as unknown as D1Database });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "song_vote_candidates_invalid" });
    expect(startChatVote).not.toHaveBeenCalled();
  });

  it("reads connection credentials through the ChannelObject token RPC", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    const getSpotifyAccessToken = vi.fn(() => Promise.resolve("spotify-access-fictional"));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("secrets", () => ({
        status: () => Promise.resolve({ configured: true, updatedAt: null }),
        read: () => Promise.resolve(null),
        readWithVersion: () => Promise.resolve(null),
        prepareWrite: () => Promise.resolve({} as D1PreparedStatement),
        prepareDelete: () => ({} as D1PreparedStatement),
      }));
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/connection`), {
      DB: database as unknown as D1Database,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ getSpotifyAccessToken }) },
    });

    expect(response.status).toBe(200);
    expect(getSpotifyAccessToken).toHaveBeenCalledOnce();
  });
});
