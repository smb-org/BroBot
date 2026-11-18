import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleChatVoteStartRequest, ModuleRouteEnvironment } from "../../src/modules/contract";
import { transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { saveSongRequestChapter } from "../../src/modules/song_requests/repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "chapter-route-channel-fictional";
const databaseList: TestD1Database[] = [];

afterEach(() => { for (const database of databaseList.splice(0)) database.close(); });

describe("song request chapter vote route", () => {
  it("returns a localized 409 when fewer than two chapter tracks are eligible", async () => {
    const database = new TestD1Database();
    databaseList.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-18T10:00:00.000Z").run();
    await database.prepare(`INSERT INTO channel_stream_state
      (channel_id, state, changed_at, source, stream_id, started_at)
      VALUES (?, 'online', ?, 'eventsub', ?, ?)`)
      .bind(CHANNEL_ID, "2026-11-18T10:00:00.000Z", "stream-chapter-fictional", "2026-11-18T10:00:00.000Z").run();
    const saved = await saveSongRequestChapter(database as unknown as D1Database, CHANNEL_ID, null, null, {
      name: "Night Drive",
      offerInCockpit: true,
      tracks: [{ id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: null }],
    }, "2026-11-18T10:00:00.000Z");
    if (saved.status !== "saved") throw new Error("Expected a saved chapter fixture.");
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, "2026-11-18T10:00:00.000Z").run();
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-chapter-vote" });
      context.set("startChatVote", () => Promise.resolve({ status: "started" as const, ballotId: "ballot-unused-fictional" }));
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId: saved.chapter.id }),
    }), {
      DB: database as unknown as D1Database,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "song_vote_chapter_not_enough_tracks",
      message: {
        de: "Dieses Kapitel hat weniger als zwei verfügbare Songs. Ergänze Tracks oder prüfe die Abklingzeit.",
        en: "This chapter has fewer than two eligible tracks. Add tracks or check the cooldown.",
      },
    });
  });

  it("draws chapter candidates after token acquisition so newly ineligible tracks stay out of the ballot", async () => {
    const database = new TestD1Database();
    databaseList.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-18T10:00:00.000Z").run();
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, "2026-11-18T10:00:00.000Z").run();
    await database.prepare(`INSERT INTO channel_stream_state
      (channel_id, state, changed_at, source, stream_id, started_at)
      VALUES (?, 'online', ?, 'eventsub', ?, ?)`)
      .bind(CHANNEL_ID, "2026-11-18T10:00:00.000Z", "stream-chapter-fictional", "2026-11-18T10:00:00.000Z").run();
    const saved = await saveSongRequestChapter(database as unknown as D1Database, CHANNEL_ID, null, null, {
      name: "Night Drive",
      offerInCockpit: true,
      tracks: [
        { id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: null },
        { id: "quietatlas02", title: "Quiet Atlas", artists: ["Mira Vale"], coverUrl: null },
        { id: "silvercurrent03", title: "Silver Current", artists: ["Mira Vale"], coverUrl: null },
      ],
    }, "2026-11-18T10:00:00.000Z");
    if (saved.status !== "saved") throw new Error("Expected a saved chapter fixture.");

    const db = database as unknown as D1Database;
    const startChatVote = vi.fn((_channelId: string, request: ModuleChatVoteStartRequest) => Promise.resolve({
      status: "started" as const,
      ballotId: request.ballotId ?? "ballot-chapter-fictional",
    }));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-fictional", sessionId: "session-chapter-vote" });
      context.set("startChatVote", startChatVote);
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId: saved.chapter.id }),
    }), {
      DB: db,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({
          getSpotifyAccessToken: async () => {
            await transitionRequest(db, {
              channelId: CHANNEL_ID,
              requestId: "request-during-token-fictional",
              fromState: null,
              toState: "approved",
              now: "2026-11-18T10:01:00.000Z",
              newRequest: {
                source: "channel_points",
                track: {
                  id: "glassharbor01", uri: "spotify:track:glassharbor01", title: "Glass Harbor",
                  artists: ["Mira Vale"], albumName: null, durationMs: 200_000, explicit: false,
                  coverUrl: null, spotifyUrl: "https://open.spotify.com/track/glassharbor01",
                },
                operationId: "operation-during-token-fictional",
                streamId: "stream-chapter-fictional",
              },
            });
            return "spotify-access-fictional";
          },
        }),
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ ballotId: string; tracks: { id: string }[] }>();
    expect(body.tracks).toHaveLength(2);
    expect(body.tracks.map(({ id }) => id)).not.toContain("glassharbor01");
    const mapping = await database.prepare("SELECT candidate_tracks_json FROM song_requests_votes WHERE ballot_id = ?")
      .bind(body.ballotId).first<{ candidate_tracks_json: string }>();
    const storedTracks = JSON.parse(mapping?.candidate_tracks_json ?? "[]") as { id: string }[];
    expect(storedTracks.map(({ id }) => id)).not.toContain("glassharbor01");
    expect(startChatVote).toHaveBeenCalledOnce();
  });
});
