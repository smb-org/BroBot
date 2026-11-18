import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleChatVoteStartRequest, ModuleRouteEnvironment } from "../../src/modules/contract";
import { transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { handleSongRequestDurableAction, spotifyAccessToken } from "../../src/modules/song_requests/service";
import { beginSpotifyOAuth, spotifyOAuthStateCookie } from "../../src/worker/auth/spotify-oauth";
import { insertChannel, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-open-vote";
const TRACK_IDS = ["glassharbor01", "quietatlas02"];
const textOf = (value: unknown): string => typeof value === "string" ? value : value instanceof URL ? value.href : value instanceof URLSearchParams ? value.toString() : "";
const spotifyTrack = (id: string) => ({
  id,
  uri: `spotify:track:${id}`,
  name: id === TRACK_IDS[0] ? "Glass Harbor" : "Quiet Atlas",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "North Window", images: [] },
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
});
const databases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("song request routes", () => {
  it("returns the channel's now-playing request id and null for a snapshot without a request", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const otherChannelId = "song-requests-now-playing-other";
    await insertChannel(database, CHANNEL_ID);
    await insertChannel(database, otherChannelId);
    await database.prepare(
      "INSERT INTO song_requests_now_playing (channel_id, revision, request_id) VALUES (?, 1, ?)",
    ).bind(CHANNEL_ID, "request-current-fictional").run();
    await database.prepare(
      "INSERT INTO song_requests_now_playing (channel_id, revision, request_id) VALUES (?, 1, NULL)",
    ).bind(otherChannelId).run();

    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);
    const env = { DB: database as unknown as D1Database } as ModuleRouteEnvironment["Bindings"];

    const currentResponse = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests`), env);
    expect(currentResponse.status).toBe(200);
    await expect(currentResponse.json()).resolves.toEqual({
      requests: [], voteOutcomes: [], nowPlayingRequestId: "request-current-fictional",
    });

    const otherResponse = await app.fetch(new Request(`https://brobot.example/channels/${otherChannelId}/requests`), env);
    expect(otherResponse.status).toBe(200);
    await expect(otherResponse.json()).resolves.toEqual({ requests: [], voteOutcomes: [], nowPlayingRequestId: null });
  });

  it("does not offer a Twitch refund for a fulfilled channel-point request", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    const requestId = "channel-points-already-submitted";
    const db = database as unknown as D1Database;
    const track = spotifyTrack(TRACK_IDS[0] ?? "glassharbor01");
    await transitionRequest(db, {
      channelId: CHANNEL_ID,
      requestId,
      fromState: null,
      toState: "approved",
      now: "2026-11-16T19:00:00.000Z",
      newRequest: {
        source: "channel_points",
        requestType: "channel_points",
        channelPointsRewardId: "reward-fictional",
        track: {
          id: track.id,
          uri: track.uri,
          title: track.name,
          artists: track.artists.map(({ name }) => name),
          durationMs: track.duration_ms,
          explicit: track.explicit,
          coverUrl: null,
          spotifyUrl: track.external_urls.spotify,
        },
        operationId: requestId,
        streamId: "stream-fictional-current",
      },
    });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now: "2026-11-16T19:01:00.000Z",
    });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now: "2026-11-16T19:02:00.000Z",
    });

    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${requestId}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refund: true }),
    }), { DB: db });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "song_request_channel_points_already_fulfilled" });
    await expect(database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(requestId).first())
      .resolves.toEqual({ state: "submitted" });
  });

  it("starts reconnect OAuth without deleting the current Spotify credentials", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
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
    await database.prepare("UPDATE channels SET language = 'de' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
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
    expect(startChatVote.mock.calls[0]?.[1]?.title).toBe("Song-Abstimmung");
    expect(await database.prepare("SELECT ballot_id FROM song_requests_votes").all()).toMatchObject({ results: [] });

    await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(CHANNEL_ID).run();
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
    expect(startChatVote.mock.calls[1]?.[1]?.title).toBe("Song vote");
  });

  it("stores the song vote mapping before a fast ballot result can be delivered", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", "stream-fictional-current", "2026-11-15T19:00:00.000Z").run();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const id = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1) ?? "glassharbor01";
      return Promise.resolve(new Response(JSON.stringify(spotifyTrack(id)), { status: 200 }));
    }));
    const durableContext = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      streamState: () => Promise.resolve("online"),
      streamStartedAt: () => Promise.resolve({ streamId: "stream-fictional-current", startedAt: "2026-11-15T19:00:00.000Z" }),
      schedule: vi.fn(() => Promise.resolve()),
      getAlarmDeadline: () => Promise.resolve(null),
    } as unknown as ModuleAlarmContext;
    const startChatVote = vi.fn<(channelId: string, request: ModuleChatVoteStartRequest) => Promise<{ status: "started"; ballotId: string }>>(
      async (_channelId, request) => {
        const requestedBallotId = (request as ModuleChatVoteStartRequest & { ballotId?: string }).ballotId;
        const ballotId = requestedBallotId ?? "ballot-fast-close";
        await handleSongRequestDurableAction(durableContext, {
          kind: "chat_vote.result",
          targetModuleId: "song_requests",
          targetHandlerKey: "submit",
          ballotId,
          labels: request.labels,
          counts: [6, 2],
          closedAt: "2026-11-15T19:02:00.000Z",
        });
        return { status: "started", ballotId };
      },
    );
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-vote-race" });
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

    expect(response.status).toBe(201);
    const responseBody: unknown = await response.json();
    if (typeof responseBody !== "object" || responseBody === null || !("ballotId" in responseBody) || typeof responseBody.ballotId !== "string") {
      throw new Error("The started vote did not return a ballot id.");
    }
    const ballotId = responseBody.ballotId;
    expect(await database.prepare("SELECT state FROM song_requests_votes WHERE ballot_id = ?").bind(ballotId).first())
      .toEqual({ state: "queued" });
    expect(await database.prepare("SELECT state FROM song_requests WHERE operation_id = ?")
      .bind(`mod_vote:${ballotId}`).first()).toEqual({ state: "approved" });
    const voteRow = await database.prepare("SELECT candidate_tracks_json FROM song_requests_votes WHERE ballot_id = ?")
      .bind(ballotId).first<{ candidate_tracks_json: string }>();
    expect(JSON.parse(voteRow?.candidate_tracks_json ?? "[]")).toMatchObject([
      { albumName: "North Window" },
      { albumName: "North Window" },
    ]);
  });

  it("allows Spotify track lookup and ballot setup while no active device is reported", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'no_active_device', ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", "stream-fictional-current", "2026-11-15T19:00:00.000Z").run();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const id = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1) ?? "glassharbor01";
      return Promise.resolve(new Response(JSON.stringify(spotifyTrack(id)), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const startChatVote = vi.fn(() => Promise.resolve({ status: "busy" as const }));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-no-device" });
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
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(startChatVote).toHaveBeenCalledOnce();
  });

  it("allows Spotify search while the player has no active device", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'no_active_device', ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      tracks: { items: [spotifyTrack(TRACK_IDS[0] ?? "glassharbor01")], total: 1, limit: 10, offset: 0 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-search-no-device" });
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/search?q=Glass%20Harbor`), {
      DB: database as unknown as D1Database,
      APP_ENV: "local",
      SPOTIFY_API_BASE: "https://spotify.example/v1",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
      },
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(textOf(fetcher.mock.calls[0]?.[0])).pathname).toBe("/v1/search");
  });

  it("blocks search when the Spotify slot is revoked during token acquisition", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-song-search-revoked" });
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/search?q=Glass%20Harbor`), {
      DB: database as unknown as D1Database,
      APP_ENV: "local",
      SPOTIFY_API_BASE: "https://spotify.example/v1",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({
          getSpotifyAccessToken: async () => {
            await database.prepare("DELETE FROM spotify_channel_access WHERE channel_id = ?").bind(CHANNEL_ID).run();
            return "revoked-spotify-access-fictional";
          },
        }),
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "spotify_not_enabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid candidate counts instead of starting a vote", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
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
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
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

  it("does not bump the connection revision on repeated reads while disconnected", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at) VALUES (?, 'not_connected', NULL, ?)")
      .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();

    const getSpotifyAccessToken = vi.fn(() => spotifyAccessToken({
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: { readWithVersion: () => Promise.resolve(null) },
    } as unknown as ModuleAlarmContext));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("secrets", () => ({
        status: () => Promise.resolve({ configured: false, updatedAt: null }),
        read: () => Promise.resolve(null),
        readWithVersion: () => Promise.resolve(null),
        prepareWrite: () => Promise.resolve({} as D1PreparedStatement),
        prepareDelete: () => ({} as D1PreparedStatement),
      }));
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const environment = {
      DB: database as unknown as D1Database,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken }),
      },
    } as unknown as ModuleRouteEnvironment["Bindings"];
    const readRevision = async (): Promise<number | null> => (await database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:song_requests:connection'",
    ).bind(CHANNEL_ID).first<{ revision: number }>())?.revision ?? null;
    const revisionBeforeReads = await readRevision();

    const firstResponse = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/connection`), environment);
    const secondResponse = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/connection`), environment);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(getSpotifyAccessToken).toHaveBeenCalledTimes(2);
    expect(await readRevision()).toBe(revisionBeforeReads);
  });
});
