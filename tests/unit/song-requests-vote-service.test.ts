import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import type { SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import {
  handleSongRequestDurableAction,
  handleSongRequestsActivation,
  handleSubmitAlarm,
  pollSongRequestsPlayback,
  spotifyAccessToken,
  processSongRequestsEvent,
  SONG_REQUESTS_ALARM,
  SONG_REQUESTS_SUBMIT_ALARM_PREFIX,
  MAX_BACKOFF_MS,
} from "../../src/modules/song_requests/service";
import { createNowPlayingSnapshot, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-vote-service";
const STREAM_ID = "stream-fictional-current";
const NOW = Date.parse("2026-11-15T19:02:00.000Z");
const TRACKS = ["glassharbor01", "quietatlas02", "silvercurrent03"].map((id, index) => ({
  id,
  uri: `spotify:track:${id}`,
  title: ["Glass Harbor", "Quiet Atlas", "Silver Current"][index] ?? "Unknown track",
  artists: ["Mira Vale"],
  durationMs: 201_000,
  explicit: false,
  coverUrl: null,
  spotifyUrl: `https://open.spotify.com/track/${id}`,
}));
const textOf = (value: unknown): string => typeof value === "string" ? value : value instanceof URL ? value.href : "";
const trackAt = (index: number): (typeof TRACKS)[number] => {
  const track = TRACKS[index];
  if (track === undefined) throw new Error("Unknown fixture track.");
  return track;
};
const spotifyTrackFixture = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover-one", width: 640, height: 640 }] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};
const databases: TestD1Database[] = [];

const createContext = async (ballotId: string) => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
    .bind(CHANNEL_ID).run();
  await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
    .bind(CHANNEL_ID, "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
  await database.prepare("INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at) VALUES (?, 'connected', NULL, ?)")
    .bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
     VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
  ).bind(CHANNEL_ID, "2026-11-15T19:00:00.000Z", STREAM_ID, "2026-11-15T19:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO song_requests_votes (ballot_id, channel_id, stream_id, candidate_tracks_json, moderator_user_id, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).bind(ballotId, CHANNEL_ID, STREAM_ID, JSON.stringify(TRACKS), "moderator-fictional", "2026-11-15T19:00:00.000Z").run();
  const clear = vi.fn<ModuleAlarmContext["clear"]>(() => Promise.resolve());
  const pendingAlarms = new Map<string, number>();
  const schedule = vi.fn<ModuleAlarmContext["schedule"]>((key, deadline) => {
    pendingAlarms.set(key, deadline);
    return Promise.resolve();
  });
  const publishModuleOverlayMessage = vi.fn<ModuleAlarmContext["publishModuleOverlayMessage"]>(() => Promise.resolve());
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, reason: null, retryable: false, delivery: "delivered" }));
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    environment: { APP_ENV: "local", SPOTIFY_CLIENT_ID: "fictional-client", SPOTIFY_CLIENT_SECRET: "fictional-secret", SPOTIFY_API_BASE: "https://spotify.mock/v1" },
    secrets: {
      readWithVersion: () => Promise.resolve({
        value: JSON.stringify({ accessToken: "spotify-access-fictional", refreshToken: "spotify-refresh-fictional", expiresAt: Date.parse("2099-01-01T00:00:00.000Z") }),
        version: "encrypted-envelope-version",
      }),
    },
    streamState: () => Promise.resolve("online"),
    streamStartedAt: () => Promise.resolve({ streamId: STREAM_ID, startedAt: "2026-11-15T19:00:00.000Z" }),
    channelLanguage: () => Promise.resolve("en"),
    sendChat,
    clear,
    schedule,
    getAlarmDeadline: (key: string) => Promise.resolve(pendingAlarms.get(key) ?? null),
    publishModuleOverlayMessage,
  } as unknown as ModuleAlarmContext;
  return { database, context, clear, schedule, publishModuleOverlayMessage, sendChat };
};

const voteResult = (ballotId: string, counts: number[]) => ({
  kind: "chat_vote.result" as const,
  targetModuleId: "song_requests" as const,
  targetHandlerKey: "submit",
  ballotId,
  labels: TRACKS.map(({ title }) => title),
  counts,
  closedAt: new Date(NOW).toISOString(),
});

const requestIdFor = async (database: TestD1Database): Promise<string> => {
  const row = await database.prepare("SELECT id FROM song_requests WHERE channel_id = ? LIMIT 1")
    .bind(CHANNEL_ID).first<{ id: string }>();
  if (row === null) throw new Error("The vote did not create a song request.");
  return row.id;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("durable song vote results", () => {
  it("claims the winner and schedules a keyed submit alarm without calling Spotify", async () => {
    const { database, context, schedule } = await createContext("ballot-winner");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await handleSongRequestDurableAction(context, voteResult("ballot-winner", [1, 5, 2]));

    const requestId = await requestIdFor(database);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "approved" });
    expect(schedule).toHaveBeenCalledWith(`${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`, expect.any(Number), undefined, null, undefined, undefined, "submit");
  });

  it("enqueues from the keyed alarm and sends only an automated queue update", async () => {
    const { database, context, sendChat } = await createContext("ballot-submit");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await handleSongRequestDurableAction(context, voteResult("ballot-submit", [1, 5, 2]));
    const requestId = await requestIdFor(database);

    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(textOf(fetcher.mock.calls[0]?.[0])).toContain("/me/player/queue?uri=spotify%3Atrack%3Aquietatlas02");
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(requestId).first()).toEqual({ state: "submitted" });
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(sendChat.mock.calls[0]?.[0]).toContain("queued in Spotify");
    expect(sendChat.mock.calls[0]?.[5]).toEqual({ automated: true });
  });

  it.each([
    { name: "a tie", ballotId: "ballot-tie", counts: [4, 4, 1], expected: "tie" },
    { name: "zero votes", ballotId: "ballot-zero", counts: [0, 0, 0], expected: "no_votes" },
  ])("does not enqueue when the result is $name", async ({ ballotId, counts, expected }) => {
    const { database, context, schedule } = await createContext(ballotId);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await handleSongRequestDurableAction(context, voteResult(ballotId, counts));
    expect(fetcher).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state FROM song_requests_votes WHERE ballot_id = ?").bind(ballotId).first())
      .toEqual({ state: expected });
  });

  it("rejects a winning request with stream_offline instead of treating the ballot as empty", async () => {
    const { database, context, schedule, sendChat } = await createContext("ballot-offline");
    context.streamState = () => Promise.resolve("offline");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await handleSongRequestDurableAction(context, voteResult("ballot-offline", [8, 1, 0]));
    const requestId = await requestIdFor(database);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "rejected", failure_reason: "stream_offline" });
    expect(await database.prepare("SELECT state FROM song_requests_votes WHERE ballot_id = ?").bind("ballot-offline").first())
      .toEqual({ state: "queued" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0]).toContain("stream is offline");
    expect(sendChat.mock.calls[0]?.[5]).toEqual({ automated: true });
  });

  it.each([
    { name: "no active device", status: 404, reason: "NO_ACTIVE_DEVICE", state: "no_active_device", message: null },
    { name: "Premium missing", status: 403, reason: "PREMIUM_REQUIRED", state: "premium_required", message: null },
    { name: "a forbidden scope", status: 403, reason: undefined, state: "spotify_error", message: "Spotify rejected the request" },
    { name: "429 after the retry budget", status: 429, reason: undefined, state: "connected", message: null },
  ])("stores a clear $name enqueue failure without a second send", async ({ status, reason, state, message }) => {
    const ballotId = `ballot-${String(status)}-${reason ?? "rate"}`;
    const { database, context, sendChat } = await createContext(ballotId);
    const body = { error: { status, message: "Spotify rejected the request", ...(reason === undefined ? {} : { reason }) } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), {
      status,
      headers: status === 429 ? { "Retry-After": "3" } : {},
    }));
    vi.stubGlobal("fetch", fetcher);
    await handleSongRequestDurableAction(context, voteResult(ballotId, [8, 1, 0]));
    const requestId = await requestIdFor(database);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await database.prepare("SELECT state, error_message FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state, error_message: message });
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(requestId).first()).toEqual({ state: "failed" });
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it("marks a timeout after Spotify accepted as outcome_unknown and never retries it", async () => {
    const { database, context } = await createContext("ballot-timeout");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Connection closed after Spotify accepted the queue command."));
    vi.stubGlobal("fetch", fetcher);
    await handleSongRequestDurableAction(context, voteResult("ballot-timeout", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?")
      .bind(requestId).first()).toEqual({ state: "outcome_unknown", failure_reason: "network_or_timeout" });
  });

  it("does not send a winner after deactivation completes during token acquisition", async () => {
    const { database, context } = await createContext("ballot-deactivated-before-send");
    await handleSongRequestDurableAction(context, voteResult("ballot-deactivated-before-send", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    context.secrets.readWithVersion = async () => {
      await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
        .bind(CHANNEL_ID).run();
      await handleSongRequestsActivation(context, false);
      return {
        value: JSON.stringify({ accessToken: "spotify-access-fictional", refreshToken: "spotify-refresh-fictional", expiresAt: Date.parse("2099-01-01T00:00:00.000Z") }),
        version: "encrypted-envelope-version",
      };
    };
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", failure_reason: "module_disabled" });
  });

  it("does not send a winner when deactivation completes during the final stream reads", async () => {
    const { database, context } = await createContext("ballot-deactivated-during-final-stream-reads");
    await handleSongRequestDurableAction(context, voteResult("ballot-deactivated-during-final-stream-reads", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    let streamReads = 0;
    context.streamStartedAt = async () => {
      streamReads += 1;
      if (streamReads === 2) {
        await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
          .bind(CHANNEL_ID).run();
        await handleSongRequestsActivation(context, false);
      }
      return { streamId: STREAM_ID, startedAt: "2026-11-15T19:00:00.000Z" };
    };
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", failure_reason: "module_disabled" });
  });

  it("does not send a winner when its Spotify slot is revoked during the final stream reads", async () => {
    const { database, context } = await createContext("ballot-slot-revoked-during-final-stream-reads");
    await handleSongRequestDurableAction(context, voteResult("ballot-slot-revoked-during-final-stream-reads", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    let streamReads = 0;
    context.streamStartedAt = async () => {
      streamReads += 1;
      if (streamReads === 2) {
        await database.prepare("DELETE FROM spotify_channel_access WHERE channel_id = ?").bind(CHANNEL_ID).run();
      }
      return { streamId: STREAM_ID, startedAt: "2026-11-15T19:00:00.000Z" };
    };
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", failure_reason: "spotify_not_enabled" });
  });

  it("reports an uncertain outcome when deactivation conflicts after Spotify received the POST", async () => {
    const { database, context, sendChat } = await createContext("ballot-deactivated-after-send");
    await handleSongRequestDurableAction(context, voteResult("ballot-deactivated-after-send", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    let releasePost!: () => void;
    let postStarted!: () => void;
    const postStartedPromise = new Promise<void>((resolve) => { postStarted = resolve; });
    const postResponse = new Promise<void>((resolve) => { releasePost = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      postStarted();
      await postResponse;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetcher);
    const submitting = handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);
    await postStartedPromise;

    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).run();
    await handleSongRequestsActivation(context, false);
    releasePost();
    await submitting;

    // Deactivation already settled the row as failed; the late Spotify completion must not overwrite that decision.
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", failure_reason: "module_disabled" });
    expect(sendChat.mock.calls[0]?.[0]).toContain("module_disabled");
  });

  it("reports an uncertain outcome when the Spotify slot is revoked after Spotify received the POST", async () => {
    const { database, context, sendChat } = await createContext("ballot-slot-revoked-after-post");
    await handleSongRequestDurableAction(context, voteResult("ballot-slot-revoked-after-post", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    let releasePost!: () => void;
    let postStarted!: () => void;
    const postStartedPromise = new Promise<void>((resolve) => { postStarted = resolve; });
    const postResponse = new Promise<void>((resolve) => { releasePost = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      postStarted();
      await postResponse;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetcher);
    const submitting = handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);
    await postStartedPromise;

    await database.prepare("DELETE FROM spotify_channel_access WHERE channel_id = ?").bind(CHANNEL_ID).run();
    releasePost();
    await submitting;

    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "outcome_unknown", failure_reason: "submit_state_conflict" });
    expect(sendChat.mock.calls[0]?.[0]).toContain("result is unclear");
    expect(sendChat.mock.calls[0]?.[0]).not.toContain("was not queued");
  });

  it("backs off a live poll while disconnected and keeps its schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { database, context, schedule, clear } = await createContext("ballot-poll-disconnected");
    await database.prepare("UPDATE song_requests_connections SET state = 'reconnect_required' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await pollSongRequestsPlayback(context);

    expect(fetcher).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(SONG_REQUESTS_ALARM, NOW + 24_000, undefined, undefined);
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "reconnect_required" });

    await database.prepare("UPDATE song_requests_connections SET state = 'connected' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    const reconnectFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", reconnectFetch);
    await pollSongRequestsPlayback(context);
    expect(reconnectFetch).toHaveBeenCalledOnce();
    expect(schedule.mock.calls.at(-1)?.[0]).toBe(SONG_REQUESTS_ALARM);
  });

  it("probes Spotify again after no_active_device and restores the connected state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { database, context, schedule } = await createContext("ballot-device-recovery");
    await database.prepare("UPDATE song_requests_connections SET state = 'no_active_device' WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await pollSongRequestsPlayback(context);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(textOf(fetcher.mock.calls[0]?.[0])).toContain("/me/player/currently-playing");
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "connected" });
    expect(schedule).toHaveBeenCalledWith(SONG_REQUESTS_ALARM, NOW + 12_000, undefined, undefined);
  });

  it("treats a revoked Spotify slot as disconnected in token and polling paths", async () => {
    const { database, context } = await createContext("ballot-revoked-slot-runtime");
    await database.prepare("DELETE FROM spotify_channel_access WHERE channel_id = ?").bind(CHANNEL_ID).run();
    expect(await spotifyAccessToken(context)).toBeNull();
    await database.prepare("UPDATE song_requests_connections SET state = 'connected' WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await pollSongRequestsPlayback(context);
    await handleSongRequestDurableAction(context, voteResult("ballot-revoked-slot-runtime", [9, 2, 1]));
    const requestId = await requestIdFor(database);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "not_connected" });
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", failure_reason: "spotify_not_enabled" });
  });

  it("does not restore now playing or re-arm polling after stream.offline during a Spotify fetch", async () => {
    const { database, context, schedule } = await createContext("ballot-poll-offline-race");
    const db = database as unknown as D1Database;
    await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, spotifyTrackFixture, new Date(NOW - 12_000).toISOString(), 5_000);
    context.streamState = async () => (await database.prepare("SELECT state FROM channel_stream_state WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ state: string }>())?.state === "online" ? "online" : "offline";
    context.streamStartedAt = async () => {
      const row = await database.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
        .bind(CHANNEL_ID).first<{ state: string; stream_id: string | null }>();
      return { streamId: row?.state === "online" ? row.stream_id : null, startedAt: null };
    };
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const responsePromise = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      fetchStarted();
      await responsePromise;
      return new Response(JSON.stringify({ is_playing: true, progress_ms: 0, currently_playing_type: "track", item: spotifyTrackFixture }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const polling = pollSongRequestsPlayback(context);
    await fetchStartedPromise;

    await database.prepare("UPDATE channel_stream_state SET state = 'offline', stream_id = NULL WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const eventContext = {
      ...context,
      clearAlarm: vi.fn(() => Promise.resolve()),
      scheduleAlarm: vi.fn(() => Promise.resolve()),
      streamSession: { streamId: STREAM_ID },
      streamStateTransitionAccepted: true,
    } as unknown as ModuleExecutionContext;
    await processSongRequestsEvent({
      subscriptionType: "stream.offline",
      channelId: CHANNEL_ID,
      receivedAt: new Date(NOW).toISOString(),
    } as unknown as ModuleEvent<SongRequestsSettings>, eventContext);
    releaseFetch();
    await polling;

    expect(await database.prepare("SELECT track_json FROM song_requests_now_playing WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ track_json: null });
    expect(schedule.mock.calls.filter(([key]) => key === SONG_REQUESTS_ALARM)).toHaveLength(0);
  });

  it("reconciles an approved winner when its submit alarm could not be scheduled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { database, context, schedule } = await createContext("ballot-missed-submit-alarm");
    schedule.mockRejectedValueOnce(new Error("Alarm storage is temporarily unavailable."));

    await expect(handleSongRequestDurableAction(context, voteResult("ballot-missed-submit-alarm", [9, 2, 1])))
      .rejects.toThrow("Alarm storage is temporarily unavailable.");
    const requestId = await requestIdFor(database);
    const submitAlarmKey = `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`;
    expect(schedule.mock.calls.filter(([key]) => key === submitAlarmKey)).toHaveLength(1);
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "approved" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await pollSongRequestsPlayback(context);

    const submitCalls = schedule.mock.calls.filter(([key]) => key === submitAlarmKey);
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls[1]).toEqual([submitAlarmKey, NOW, undefined, null, undefined, undefined, "submit"]);
  });

  it("honors the full Retry-After value when it exceeds the exponential backoff cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { database, context, schedule } = await createContext("ballot-poll-missing-token");
    context.secrets.readWithVersion = () => Promise.resolve(null);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());

    await pollSongRequestsPlayback(context);

    expect(schedule).toHaveBeenCalledWith(SONG_REQUESTS_ALARM, NOW + 24_000, undefined, undefined);
    expect(await database.prepare("SELECT state, poll_failures FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "not_connected", poll_failures: 1 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { status: 429, message: "Rate limited" } }), {
      status: 429,
      headers: { "Retry-After": "600" },
    }));
    vi.stubGlobal("fetch", fetcher);
    await database.prepare("UPDATE song_requests_connections SET state = 'connected' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    context.secrets.readWithVersion = () => Promise.resolve({
      value: JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresAt: NOW + 3_600_000 }), version: "version",
    });
    await pollSongRequestsPlayback(context);
    expect(schedule.mock.calls.at(-1)?.[1]).toBe(NOW + Math.max(MAX_BACKOFF_MS, 600_000));
  });

  it("clears the polling alarm on an accepted stream.offline event", async () => {
    const { context } = await createContext("ballot-stream-offline");
    const clearAlarm = vi.fn(() => Promise.resolve());
    const scheduleAlarm = vi.fn(() => Promise.resolve());
    const eventContext = {
      ...context,
      clearAlarm,
      scheduleAlarm,
      streamSession: { streamId: STREAM_ID },
      streamStateTransitionAccepted: true,
    } as unknown as ModuleExecutionContext;
    const event = {
      subscriptionType: "stream.offline",
      channelId: CHANNEL_ID,
      receivedAt: new Date(NOW).toISOString(),
    } as unknown as ModuleEvent<SongRequestsSettings>;

    await processSongRequestsEvent(event, eventContext);

    expect(clearAlarm).toHaveBeenCalledWith("poll");
    expect(scheduleAlarm).not.toHaveBeenCalled();
  });

  it("ages stale submitting rows and routes the outcome through the ledger transition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { database, context, schedule } = await createContext("ballot-submit-interrupted");
    const db = database as unknown as D1Database;
    await transitionRequest(db, {
      channelId: CHANNEL_ID,
      requestId: "request-interrupted",
      fromState: null,
      toState: "approved",
      now: new Date(NOW - 120_000).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(0), operationId: "mod_vote:interrupted", streamId: STREAM_ID },
    });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-interrupted", fromState: "approved", toState: "submitting",
      now: new Date(NOW - 61_000).toISOString(),
    });
    context.streamState = () => Promise.resolve("offline");

    await pollSongRequestsPlayback(context);

    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-interrupted'").first())
      .toEqual({ state: "outcome_unknown", failure_reason: "submit_interrupted" });
    expect(schedule).toHaveBeenCalledWith(`${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}request-interrupted`, NOW, undefined, null, undefined, undefined, "submit");
  });

  it("clears polling and settles open rows when the module is disabled, then resumes mid-stream when enabled", async () => {
    const { database, context, schedule, clear } = await createContext("ballot-activation");
    const db = database as unknown as D1Database;
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-pending", fromState: null, toState: "pending_review", now: new Date(NOW).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(0), operationId: "pending-op", streamId: STREAM_ID },
    });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-approved", fromState: null, toState: "approved", now: new Date(NOW).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(2), operationId: "approved-op", streamId: STREAM_ID },
    });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-submitting", fromState: null, toState: "approved", now: new Date(NOW).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(2), operationId: "submitting-op", streamId: STREAM_ID },
    });
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-submitting", fromState: "approved", toState: "submitting", now: new Date(NOW).toISOString() });
    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-unknown", fromState: null, toState: "approved", now: new Date(NOW).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(1), operationId: "unknown-op", streamId: STREAM_ID },
    });
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-unknown", fromState: "approved", toState: "submitting", now: new Date(NOW).toISOString() });
    await transitionRequest(db, { channelId: CHANNEL_ID, requestId: "request-unknown", fromState: "submitting", toState: "outcome_unknown", failureReason: "network_or_timeout", now: new Date(NOW).toISOString() });

    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'").bind(CHANNEL_ID).run();
    await handleSongRequestsActivation(context, false);
    expect(clear).toHaveBeenCalledWith(SONG_REQUESTS_ALARM);
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-pending'").first())
      .toEqual({ state: "rejected", failure_reason: "module_disabled" });
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-approved'").first())
      .toEqual({ state: "rejected", failure_reason: "module_disabled" });
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-submitting'").first())
      .toEqual({ state: "failed", failure_reason: "module_disabled" });
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-unknown'").first())
      .toEqual({ state: "failed", failure_reason: "module_disabled" });

    await transitionRequest(db, {
      channelId: CHANNEL_ID, requestId: "request-late-vote", fromState: null, toState: "approved", now: new Date(NOW).toISOString(),
      newRequest: { source: "mod_vote", track: trackAt(0), operationId: "late-vote-op", streamId: STREAM_ID },
    });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await handleSubmitAlarm(context, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}request-late-vote`);
    expect(await database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = 'request-late-vote'").first())
      .toEqual({ state: "rejected", failure_reason: "module_disabled" });
    expect(fetcher).not.toHaveBeenCalled();

    context.streamState = () => Promise.resolve("online");
    await database.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'song_requests'").bind(CHANNEL_ID).run();
    await handleSongRequestsActivation(context, true);
    expect(schedule).toHaveBeenCalledWith(SONG_REQUESTS_ALARM, expect.any(Number), undefined, undefined);
  });

  it("matches the next submitted request when the same track restarts and progress drops", async () => {
    const { database } = await createContext("ballot-repeat-run");
    const db = database as unknown as D1Database;
    for (const [requestId, operationId] of [["request-run-one", "run-one"], ["request-run-two", "run-two"]] as const) {
      await transitionRequest(db, {
        channelId: CHANNEL_ID, requestId, fromState: null, toState: "approved", now: new Date(NOW).toISOString(),
        newRequest: { source: "mod_vote", track: trackAt(0), operationId, streamId: STREAM_ID },
      });
      await transitionRequest(db, { channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now: new Date(NOW).toISOString() });
      await transitionRequest(db, { channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now: new Date(NOW).toISOString() });
    }
    const track = {
      id: "glassharbor01", uri: "spotify:track:glassharbor01", name: "Glass Harbor", duration_ms: 201_000,
      explicit: false, artists: [{ id: "miravale01", name: "Mira Vale" }],
      album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover", width: 640, height: 640 }] },
      external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
    };
    const { createNowPlayingSnapshot } = await import("../../src/modules/song_requests/adapters/d1");

    await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, track, new Date(NOW).toISOString(), 90_000);
    await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, track, new Date(NOW + 12_000).toISOString(), 102_000);
    const restarted = await createNowPlayingSnapshot(db, CHANNEL_ID, STREAM_ID, track, new Date(NOW + 24_000).toISOString(), 300);

    expect(restarted.changed).toBe(true);
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = 'request-run-one'").first()).toEqual({ state: "observed_playing" });
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = 'request-run-two'").first()).toEqual({ state: "observed_playing" });
  });
});
