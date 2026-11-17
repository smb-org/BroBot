import { afterEach, describe, expect, it } from "vitest";

import {
  clearSongRequestsForStreamEnd,
  createNowPlayingSnapshot,
  createVoteRequestClaim,
  latestSongRequestStreamId,
  readSongRequest,
  recentSongVoteOutcomes,
  resolveUnknownRequest,
  transitionRequest,
} from "../../src/modules/song_requests/adapters/d1";
import type { SpotifyTrack } from "../../src/modules/song_requests/domain/track";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-ledger";
const STREAM_ID = "stream-fictional-current";
const NOW = "2026-11-15T19:00:00.000Z";
const spotifyTrack: SpotifyTrack = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover", width: 640, height: 640 }] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const addVote = async (database: TestD1Database, ballotId: string, createdAt: string, streamId = STREAM_ID): Promise<void> => {
  await database.prepare(
    `INSERT INTO song_requests_votes (ballot_id, channel_id, stream_id, candidate_tracks_json, moderator_user_id, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).bind(ballotId, CHANNEL_ID, streamId, JSON.stringify([]), "moderator-fictional", createdAt).run();
};

const seedRequest = async (
  database: TestD1Database,
  requestId: string,
  operationId: string,
  state: "pending_review" | "approved" | "submitted" | "outcome_unknown",
  streamId: string | null,
): Promise<void> => {
  const db = database as unknown as D1Database;
  const initialState = state === "submitted" || state === "outcome_unknown" ? "approved" : state;
  await transitionRequest(db, {
    channelId: CHANNEL_ID,
    requestId,
    fromState: null,
    toState: initialState,
    now: NOW,
    newRequest: {
      source: "mod_vote",
      track: {
        id: spotifyTrack.id,
        uri: spotifyTrack.uri,
        title: spotifyTrack.name,
        artists: ["Mira Vale"],
        albumName: "Quiet Atlas",
        durationMs: spotifyTrack.duration_ms,
        explicit: false,
        coverUrl: null,
        spotifyUrl: spotifyTrack.external_urls.spotify,
      },
      operationId,
      streamId,
    },
  });
  if (state === "submitted" || state === "outcome_unknown") {
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now: NOW });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: state, now: NOW,
      failureReason: state === "outcome_unknown" ? "network_or_timeout" : null,
    });
  }
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("song request ledger", () => {
  it("claims each ballot once before its Spotify enqueue", async () => {
    const database = await createDatabase();
    await addVote(database, "ballot-claim-once", NOW);
    const input = {
      channelId: CHANNEL_ID,
      ballotId: "ballot-claim-once",
      moderatorUserId: "moderator-fictional",
      track: {
        id: spotifyTrack.id,
        uri: spotifyTrack.uri,
        title: spotifyTrack.name,
        artists: ["Mira Vale"],
        durationMs: spotifyTrack.duration_ms,
        explicit: false,
        coverUrl: "https://i.scdn.co/image/fictional-cover",
        spotifyUrl: spotifyTrack.external_urls.spotify,
      },
      streamId: STREAM_ID,
      requestId: "request-claim-first",
      now: NOW,
    };
    expect(await createVoteRequestClaim(database as unknown as D1Database, input)).toBe(true);
    expect(await createVoteRequestClaim(database as unknown as D1Database, { ...input, requestId: "request-claim-second" })).toBe(false);
    expect(await database.prepare("SELECT count(*) AS count FROM song_requests").first<{ count: number }>()).toEqual({ count: 1 });
    expect(await database.prepare("SELECT state, request_id FROM song_requests_votes WHERE ballot_id = ?").bind(input.ballotId).first())
      .toEqual({ state: "queued", request_id: input.requestId });
    expect(await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: input.requestId, fromState: "approved", toState: "submitted", now: NOW,
    })).toBe(false);
  });

  it("validates request transitions and sets submitted_at only when submitted", async () => {
    const database = await createDatabase();
    await addVote(database, "ballot-transition", NOW);
    await createVoteRequestClaim(database as unknown as D1Database, {
      channelId: CHANNEL_ID,
      ballotId: "ballot-transition",
      moderatorUserId: "moderator-fictional",
      track: { id: spotifyTrack.id, uri: spotifyTrack.uri, title: spotifyTrack.name, artists: ["Mira Vale"], durationMs: 201_000, explicit: false, coverUrl: null, spotifyUrl: spotifyTrack.external_urls.spotify },
      streamId: STREAM_ID,
      requestId: "request-transition",
      now: NOW,
    });
    const db = database as unknown as D1Database;

    expect(await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-transition", fromState: "approved", toState: "submitted", now: NOW })).toBe(false);
    expect(await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-transition", fromState: "approved", toState: "submitting", now: NOW })).toBe(true);
    expect(await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-transition", fromState: "submitting", toState: "submitted", now: "2026-11-15T20:00:00.000Z" })).toBe(true);
    expect(await database.prepare("SELECT state, submitted_at FROM song_requests WHERE id = 'request-transition'").first())
      .toEqual({ state: "submitted", submitted_at: "2026-11-15T20:00:00.000Z" });
  });

  it("persists Twitch resolution obligations with final channel-points ledger states", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    const request = (requestId: string, state: "pending_review" | "approved") => transitionRequest(db, {
      channelId: CHANNEL_ID,
      requestId,
      fromState: null,
      toState: state,
      now: NOW,
      newRequest: {
        source: "channel_points",
        channelPointsRewardId: "reward-fictional",
        track: {
          id: spotifyTrack.id,
          uri: spotifyTrack.uri,
          title: spotifyTrack.name,
          artists: ["Mira Vale"],
          durationMs: spotifyTrack.duration_ms,
          explicit: false,
          coverUrl: null,
          spotifyUrl: spotifyTrack.external_urls.spotify,
        },
        operationId: requestId,
        streamId: STREAM_ID,
        roundId: STREAM_ID,
      },
    });

    await expect(request("channel-points-submit", "approved")).resolves.toBe(true);
    await expect(transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "channel-points-submit", fromState: "approved", toState: "submitting", now: NOW,
    })).resolves.toBe(true);
    await expect(transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "channel-points-submit", fromState: "submitting", toState: "submitted", now: NOW,
    })).resolves.toBe(true);
    await expect(database.prepare(
      "SELECT request_type, source, charged_amount, channel_points_reward_id, channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind("channel-points-submit").first()).resolves.toEqual({
      request_type: "channel_points", source: "channel_points", charged_amount: 0,
      channel_points_reward_id: "reward-fictional", channel_points_resolution_due: "FULFILLED",
    });

    await expect(request("channel-points-reject", "pending_review")).resolves.toBe(true);
    await expect(transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "channel-points-reject", fromState: "pending_review", toState: "rejected",
      failureReason: "moderator_rejected", refundDue: true, now: NOW,
    })).resolves.toBe(true);
    await expect(database.prepare(
      "SELECT charged_amount, refund_due, channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind("channel-points-reject").first()).resolves.toEqual({
      charged_amount: 0, refund_due: 0, channel_points_resolution_due: "CANCELED",
    });
  });

  it("clears the outgoing Twitch obligation when an external terminal status closes a request", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "external-channel-points", fromState: null, toState: "pending_review", now: NOW,
      newRequest: {
        source: "channel_points", requestType: "channel_points", channelPointsRewardId: "reward-fictional",
        track: {
          id: spotifyTrack.id, uri: spotifyTrack.uri, title: spotifyTrack.name, artists: ["Mira Vale"],
          durationMs: spotifyTrack.duration_ms, explicit: false, coverUrl: null, spotifyUrl: spotifyTrack.external_urls.spotify,
        },
        operationId: "external-channel-points", streamId: STREAM_ID, roundId: STREAM_ID,
      },
    });
    await database.prepare(
      "UPDATE song_requests SET channel_points_resolution_due = 'CANCELED' WHERE id = ?",
    ).bind("external-channel-points").run();
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "external-channel-points", fromState: "pending_review", toState: "rejected",
      failureReason: "twitch_canceled", now: NOW, suppressChannelPointsResolution: true,
    });
    await expect(database.prepare(
      "SELECT state, channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind("external-channel-points").first()).resolves.toEqual({ state: "rejected", channel_points_resolution_due: null });
  });

  it("matches the oldest same-stream request, leaves manual tracks unmatched, and avoids unchanged writes", async () => {
    const database = await createDatabase();
    await addVote(database, "ballot-old-stream", "2026-11-14T19:00:00.000Z", "stream-old");
    await addVote(database, "ballot-first", "2026-11-15T19:00:00.000Z");
    await addVote(database, "ballot-second", "2026-11-15T19:01:00.000Z");
    const base = {
      channelId: CHANNEL_ID,
      moderatorUserId: "moderator-fictional",
      track: {
        id: spotifyTrack.id,
        uri: spotifyTrack.uri,
        title: spotifyTrack.name,
        artists: ["Mira Vale"],
        albumName: "Quiet Atlas",
        durationMs: spotifyTrack.duration_ms,
        explicit: false,
        coverUrl: "https://i.scdn.co/image/fictional-cover",
        spotifyUrl: spotifyTrack.external_urls.spotify,
      },
      requestId: "request-old-stream",
      now: "2026-11-14T19:00:00.000Z",
    };
    await createVoteRequestClaim(database as unknown as D1Database, { ...base, ballotId: "ballot-old-stream", streamId: "stream-old" });
    await createVoteRequestClaim(database as unknown as D1Database, { ...base, ballotId: "ballot-first", requestId: "request-first", streamId: STREAM_ID, now: NOW });
    await createVoteRequestClaim(database as unknown as D1Database, { ...base, ballotId: "ballot-second", requestId: "request-second", streamId: STREAM_ID, now: "2026-11-15T19:01:00.000Z" });
    for (const requestId of ["request-old-stream", "request-first", "request-second"]) {
      await transitionRequest(database as unknown as D1Database, {
        channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now: NOW,
      });
      await transitionRequest(database as unknown as D1Database, {
        channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now: NOW,
      });
    }

    const first = await createNowPlayingSnapshot(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, spotifyTrack, NOW);
    expect(first.changed).toBe(true);
    expect(first.state).toMatchObject({ title: "Glass Harbor", artist: "Mira Vale", requester: null, source: "mod_vote" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "request-first")).toMatchObject({ state: "observed_playing", albumName: "Quiet Atlas" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "request-second")).toMatchObject({ state: "submitted" });

    const unchanged = await createNowPlayingSnapshot(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, spotifyTrack, "2026-11-15T19:00:12.000Z");
    expect(unchanged).toMatchObject({ changed: false, revision: first.revision });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "request-second")).toMatchObject({ state: "submitted" });

    const manual = { ...spotifyTrack, id: "silentmap04", uri: "spotify:track:silentmap04", name: "Silent Map" };
    await createNowPlayingSnapshot(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, manual, "2026-11-15T19:01:00.000Z");
    const duplicateAgain = await createNowPlayingSnapshot(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, spotifyTrack, "2026-11-15T19:02:00.000Z");
    expect(duplicateAgain.state).toMatchObject({ title: "Glass Harbor", requester: null });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "request-second")).toMatchObject({ state: "observed_playing" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "request-old-stream")).toMatchObject({ state: "submitted" });
  });

  it("keeps the published progress anchor until a seek drifts past three seconds", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    const first = await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, spotifyTrack, NOW, 10_000);
    const steadyPoll = await createNowPlayingSnapshot(
      db, CHANNEL_ID, STREAM_ID, spotifyTrack, "2026-11-15T19:00:12.000Z", 22_000,
    );

    expect(steadyPoll).toMatchObject({ changed: false, revision: first.revision });
    expect(await database.prepare("SELECT progress_ms, observed_at FROM song_requests_now_playing WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ progress_ms: 10_000, observed_at: NOW });

    const seek = await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, spotifyTrack, "2026-11-15T19:00:24.000Z", 23_000);
    expect(seek).toMatchObject({ changed: true, revision: first.revision + 1 });
  });

  it("settles stream-scoped rows and advances the empty overlay revision on offline", async () => {
    const database = await createDatabase();
    await addVote(database, "ballot-offline", NOW);
    const base = {
      channelId: CHANNEL_ID,
      ballotId: "ballot-offline",
      moderatorUserId: "moderator-fictional",
      track: {
        id: spotifyTrack.id, uri: spotifyTrack.uri, title: spotifyTrack.name, artists: ["Mira Vale"],
        durationMs: spotifyTrack.duration_ms, explicit: false, coverUrl: null, spotifyUrl: spotifyTrack.external_urls.spotify,
      },
      streamId: STREAM_ID,
      requestId: "request-offline-submitted",
      now: NOW,
    };
    await createVoteRequestClaim(database as unknown as D1Database, base);
    await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: base.requestId, fromState: "approved", toState: "submitting", now: NOW,
    });
    await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: base.requestId, fromState: "submitting", toState: "submitted", now: NOW,
    });
    await seedRequest(database, "pending-row", "pending-operation", "pending_review", STREAM_ID);
    await seedRequest(database, "missing-stream-row", "missing-stream-operation", "pending_review", null);
    await seedRequest(database, "unknown-row", "unknown-operation", "outcome_unknown", STREAM_ID);
    await database.prepare("INSERT INTO song_requests_now_playing (channel_id, revision, track_json) VALUES (?, 9, NULL)")
      .bind(CHANNEL_ID).run();

    const result = await clearSongRequestsForStreamEnd(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, "2026-11-15T22:00:00.000Z");
    expect(result).toMatchObject({ changed: true, revision: 9 });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, base.requestId)).toMatchObject({ state: "not_observed" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "pending-row")).toMatchObject({ state: "rejected" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "unknown-row")).toMatchObject({ state: "failed", failureReason: "submit_outcome_uncertain" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "missing-stream-row"))
      .toMatchObject({ state: "rejected", failureReason: "stream_ended" });
  });

  it("lets a moderator resolve an unclear send once", async () => {
    const database = await createDatabase();
    await seedRequest(database, "unknown-resolution", "unknown-resolution-operation", "outcome_unknown", STREAM_ID);

    await expect(resolveUnknownRequest(database as unknown as D1Database, CHANNEL_ID, "unknown-resolution", "submitted", "2026-11-15T20:00:00.000Z"))
      .resolves.toBe(true);
    await expect(resolveUnknownRequest(database as unknown as D1Database, CHANNEL_ID, "unknown-resolution", "failed", "2026-11-15T20:01:00.000Z"))
      .resolves.toBe(false);
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "unknown-resolution"))
      .toMatchObject({ state: "submitted", failureReason: null });
  });

  it("keeps vote outcomes attached to their stream after the channel goes offline", async () => {
    const database = await createDatabase();
    await addVote(database, "ballot-old-outcome", "2026-11-14T19:00:00.000Z", "stream-old");
    await database.prepare("UPDATE song_requests_votes SET state = 'no_votes' WHERE ballot_id = ?").bind("ballot-old-outcome").run();
    await addVote(database, "ballot-current-outcome", NOW, STREAM_ID);
    await database.prepare("UPDATE song_requests_votes SET state = 'tie' WHERE ballot_id = ?").bind("ballot-current-outcome").run();
    await addVote(database, "ballot-drawn-outcome", "2026-11-15T18:59:00.000Z", STREAM_ID);
    await database.prepare("UPDATE song_requests_votes SET state = 'queued', drawn_by_lot = 1 WHERE ballot_id = ?").bind("ballot-drawn-outcome").run();

    expect(await recentSongVoteOutcomes(database as unknown as D1Database, CHANNEL_ID, STREAM_ID))
      .toEqual([
        { ballotId: "ballot-current-outcome", state: "tie", drawnByLot: false, createdAt: NOW },
        { ballotId: "ballot-drawn-outcome", state: "drawn", drawnByLot: true, createdAt: "2026-11-15T18:59:00.000Z" },
      ]);
    expect(await latestSongRequestStreamId(database as unknown as D1Database, CHANNEL_ID, null)).toBe(STREAM_ID);
  });
});
