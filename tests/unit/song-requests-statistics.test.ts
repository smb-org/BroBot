import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { readSongRequestStatistics, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-request-statistics";
const STREAM_ONE = "stream-statistics-one";
const STREAM_TWO = "stream-statistics-two";
const NOW = "2026-11-17T19:00:00.000Z";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const addRequest = async (
  database: TestD1Database,
  input: {
    id: string;
    streamId: string;
    state: "approved" | "submitting" | "submitted" | "observed_playing" | "not_observed" | "outcome_unknown" | "pending_review" | "rejected";
    requestType?: "vote" | "bot_points" | "free" | "channel_points";
    userId?: string | null;
    displayName?: string | null;
    trackId?: string;
    title?: string;
    albumName?: string | null;
  },
): Promise<void> => {
  const db = database as unknown as D1Database;
  const trackId = input.trackId ?? "track-glass-harbor";
  await transitionRequest(db, {
    channelId: CHANNEL_ID,
    requestId: input.id,
    fromState: null,
    toState: input.state === "pending_review" || input.state === "rejected" ? "pending_review" : "approved",
    now: NOW,
    newRequest: {
      source: input.requestType === "vote" ? "mod_vote" : input.requestType === "channel_points" ? "channel_points" : "points",
      requestType: input.requestType ?? "free",
      track: {
        id: trackId,
        uri: `spotify:track:${trackId}`,
        title: input.title ?? "Glass Harbor",
        artists: ["Mira Vale"],
        albumName: input.albumName ?? null,
        durationMs: 201_000,
        explicit: false,
        coverUrl: null,
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      },
      operationId: input.id,
      streamId: input.streamId,
      roundId: input.streamId,
      requesterUserId: input.userId ?? "requester-1",
      requesterLogin: "viewer-one",
      requesterDisplayName: input.displayName ?? "Viewer One",
    },
  });
  if (input.state === "rejected") {
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "pending_review", toState: "rejected", now: NOW });
  } else if (input.state === "submitting" || input.state === "outcome_unknown") {
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "approved", toState: "submitting", now: NOW });
    if (input.state === "outcome_unknown") await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "submitting", toState: "outcome_unknown", now: NOW });
  } else if (input.state === "submitted" || input.state === "observed_playing" || input.state === "not_observed") {
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "approved", toState: "submitting", now: NOW });
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "submitting", toState: "submitted", now: NOW });
    if (input.state !== "submitted") await transitionRequest(db, { channelId: CHANNEL_ID, requestId: input.id, fromState: "submitted", toState: input.state, now: NOW });
  }
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("song request statistics", () => {
  it("aggregates accepted requests by stream and total while excluding vote requests and non-queue states", async () => {
    const database = await createDatabase();
    const acceptedStates = ["approved", "submitting", "submitted", "observed_playing", "not_observed", "outcome_unknown"] as const;
    for (const [index, state] of acceptedStates.entries()) {
      await addRequest(database, {
        id: `accepted-${String(index)}`,
        streamId: STREAM_ONE,
        state,
        requestType: index === 0 ? "free" : "bot_points",
        userId: "requester-1",
        displayName: "Viewer One",
        trackId: index < 3 ? "track-glass-harbor" : `track-${String(index)}`,
      });
    }
    await addRequest(database, { id: "vote-request", streamId: STREAM_ONE, state: "approved", requestType: "vote", userId: "vote-winner", displayName: "Vote winner", trackId: "track-vote" });
    await addRequest(database, { id: "pending-request", streamId: STREAM_ONE, state: "pending_review", requestType: "free", userId: "pending-user" });
    await addRequest(database, { id: "rejected-request", streamId: STREAM_ONE, state: "rejected", requestType: "free", userId: "rejected-user" });
    await addRequest(database, { id: "other-stream-request", streamId: STREAM_TWO, state: "approved", requestType: "channel_points", userId: "requester-1", displayName: "Viewer One", trackId: "track-glass-harbor" });
    await addRequest(database, { id: "album-request", streamId: STREAM_ONE, state: "approved", requestType: "free", trackId: "track-album", title: "Silver Current", albumName: "North Window" });
    await addRequest(database, { id: "legacy-album-request", streamId: STREAM_ONE, state: "approved", requestType: "free", trackId: "track-album", title: "Silver Current", albumName: null });

    const db = database as unknown as D1Database;
    await expect(readSongRequestStatistics(db, CHANNEL_ID, STREAM_ONE)).resolves.toEqual({
      requesters: [{ userId: "requester-1", displayName: "Viewer One", count: 8 }],
      tracks: [
        { trackId: "track-glass-harbor", title: "Glass Harbor", artists: ["Mira Vale"], albumName: null, count: 3 },
        { trackId: "track-album", title: "Silver Current", artists: ["Mira Vale"], albumName: "North Window", count: 2 },
        { trackId: "track-3", title: "Glass Harbor", artists: ["Mira Vale"], albumName: null, count: 1 },
        { trackId: "track-4", title: "Glass Harbor", artists: ["Mira Vale"], albumName: null, count: 1 },
        { trackId: "track-5", title: "Glass Harbor", artists: ["Mira Vale"], albumName: null, count: 1 },
        { trackId: "track-vote", title: "Glass Harbor", artists: ["Mira Vale"], albumName: null, count: 1 },
      ],
    });
    const total = await readSongRequestStatistics(db, CHANNEL_ID, null);
    expect(total.requesters).toEqual([{ userId: "requester-1", displayName: "Viewer One", count: 9 }]);
    expect(total.tracks.find(({ trackId }) => trackId === "track-glass-harbor")?.count).toBe(4);
    expect(total.requesters.map(({ userId }) => userId)).not.toContain("vote-winner");
  });

  it("serves stream statistics only for stream IDs present in channel statistics", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    await database.prepare(
      "INSERT INTO channel_statistics (channel_id, stream_id, window_start, messages, emotes) VALUES (?, ?, ?, 0, 0)",
    ).bind(CHANNEL_ID, STREAM_ONE, NOW).run();
    await addRequest(database, { id: "route-stat-request", streamId: STREAM_ONE, state: "approved", userId: "requester-route" });

    const app = new Hono<ModuleRouteEnvironment>();
    app.route("/channels/:channelId", songRequestsRoutes);
    const env = { DB: db } as ModuleRouteEnvironment["Bindings"];
    const valid = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/statistics?scope=stream&streamId=${STREAM_ONE}`), env);
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ requesters: [{ userId: "requester-route", count: 1 }] });
    const missing = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/statistics?scope=stream&streamId=stream-missing`), env);
    expect(missing.status).toBe(404);
  });

  it("uses the accepted-request partial index for stream and total aggregation", async () => {
    const database = await createDatabase();
    const states = "'approved', 'submitting', 'submitted', 'observed_playing', 'not_observed', 'outcome_unknown'";
    const streamPlan = await database.prepare(
      `EXPLAIN QUERY PLAN SELECT requester_user_id, COUNT(*) FROM song_requests
        WHERE channel_id = ? AND stream_id = ? AND state IN (${states}) AND request_type != 'vote' AND requester_user_id IS NOT NULL
        GROUP BY requester_user_id`,
    ).bind(CHANNEL_ID, STREAM_ONE).all<{ detail: string }>();
    const totalPlan = await database.prepare(
      `EXPLAIN QUERY PLAN SELECT requester_user_id, COUNT(*) FROM song_requests
        WHERE channel_id = ? AND state IN (${states}) AND request_type != 'vote' AND requester_user_id IS NOT NULL
        GROUP BY requester_user_id`,
    ).bind(CHANNEL_ID).all<{ detail: string }>();

    expect(streamPlan.results.map(({ detail }) => detail).join(" ")).toContain("song_requests_statistics_idx");
    expect(totalPlan.results.map(({ detail }) => detail).join(" ")).toContain("song_requests_statistics_idx");
  });
});
