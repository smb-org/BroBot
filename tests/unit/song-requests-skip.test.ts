import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsSettingsSchema, type SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import {
  createNowPlayingSnapshot,
  createSkipVoteMapping,
} from "../../src/modules/song_requests/adapters/d1";
import {
  handleSongRequestDurableAction,
  processSongRequestsEvent,
  skipSongTrack,
} from "../../src/modules/song_requests/service";
import { songRequestsModule } from "../../src/modules/song_requests/index";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-skip";
const STREAM_ID = "stream-skip-current";
const NOW = Date.parse("2026-11-17T19:00:00.000Z");
const TRACK = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};
const changedTrack = { ...TRACK, id: "quietatlas02", uri: "spotify:track:quietatlas02", name: "Quiet Atlas" };
const environment = {
  APP_ENV: "local",
  SPOTIFY_API_BASE: "https://spotify.mock/v1",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fictional") }),
  },
} as unknown as Env;
const databases: TestD1Database[] = [];

const createDatabase = async (settings: Record<string, unknown> = { skipVote: { enabled: true, threshold: 2, cooldownSeconds: 120 } }): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, ?)")
    .bind(CHANNEL_ID, JSON.stringify(settings)).run();
  await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
    .bind(CHANNEL_ID, "moderator-fictional", new Date(NOW).toISOString()).run();
  await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
    .bind(CHANNEL_ID, new Date(NOW).toISOString()).run();
  await database.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
     VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
  ).bind(CHANNEL_ID, new Date(NOW).toISOString(), STREAM_ID, new Date(NOW).toISOString()).run();
  return database;
};

const addNowPlaying = async (database: TestD1Database, current: typeof TRACK | typeof changedTrack = TRACK): Promise<void> => {
  await createNowPlayingSnapshot(database as unknown as D1Database, CHANNEL_ID, STREAM_ID, current, new Date(NOW).toISOString(), 0);
};

const chatEvent = (text: string, options: { userId?: string; chatStatus?: readonly ("moderator" | "broadcaster" | "subscriber" | "vip" | "founder")[] | null; settings?: Record<string, unknown> } = {}): ModuleEvent<SongRequestsSettings> => ({
  channelId: CHANNEL_ID,
  subscriptionType: "channel.chat.message",
  triggerId: "trigger-skip-command",
  receivedAt: new Date(NOW).toISOString(),
  actor: null,
  chatStatus: options.chatStatus ?? null,
  settings: songRequestsSettingsSchema.parse(options.settings ?? { skipVote: { enabled: true, threshold: 2, cooldownSeconds: 120 } }),
  payload: {
    chatter_user_id: options.userId ?? "viewer-skip-one",
    chatter_user_login: "viewer_skip_one",
    message_id: "message-skip-command",
    message: { text },
  },
} as ModuleEvent<SongRequestsSettings>);

const eventContext = (
  database: TestD1Database,
  options: {
    openBallot?: boolean;
    startChatVote?: ModuleExecutionContext["startChatVote"];
    castChatVote?: ModuleExecutionContext["castChatVote"];
    scheduleAlarm?: ModuleExecutionContext["scheduleAlarm"];
  } = {},
): ModuleExecutionContext => ({
  DB: database as unknown as D1Database,
  channelId: CHANNEL_ID,
  environment,
  channelLanguage: () => Promise.resolve("en"),
  botUserId: () => Promise.resolve("bot-skip"),
  ballots: { hasOpenBallot: () => Promise.resolve(options.openBallot ?? false) },
  startChatVote: options.startChatVote,
  castChatVote: options.castChatVote,
  scheduleAlarm: options.scheduleAlarm ?? (() => Promise.resolve(undefined)),
} as unknown as ModuleExecutionContext);

const replyText = (result: Awaited<ReturnType<typeof processSongRequestsEvent>>): string => {
  const action = result.actions[0];
  return action?.kind === "chat" ? action.text : "";
};

const addSkipMapping = async (database: TestD1Database, ballotId: string, startTrackId = TRACK.id, threshold = 2): Promise<void> => {
  const inserted = await createSkipVoteMapping(database as unknown as D1Database, {
    ballotId,
    channelId: CHANNEL_ID,
    streamId: STREAM_ID,
    userId: "viewer-skip-one",
    startTrackId,
    threshold,
    cooldownSeconds: 120,
    now: new Date(NOW).toISOString(),
  });
  expect(inserted).toBe(true);
};

const alarmContext = (database: TestD1Database): ModuleAlarmContext => ({
  DB: database as unknown as D1Database,
  channelId: CHANNEL_ID,
  environment,
  secrets: {
    readWithVersion: () => Promise.resolve({
      value: JSON.stringify({ accessToken: "spotify-access-fictional", refreshToken: "spotify-refresh-fictional", expiresAt: NOW + 3_600_000 }),
      version: "credential-version",
    }),
  },
  channelLanguage: () => Promise.resolve("en"),
  sendChat: vi.fn(() => Promise.resolve({ sent: true, reason: null, retryable: false, delivery: "delivered" as const })),
  schedule: vi.fn(() => Promise.resolve(undefined)),
  scheduleIfEarlier: vi.fn(() => Promise.resolve(undefined)),
} as unknown as ModuleAlarmContext);

const skipResult = (ballotId: string, counts: number[]) => ({
  kind: "chat_vote.result" as const,
  targetModuleId: "song_requests" as const,
  targetHandlerKey: "submit",
  ballotId,
  labels: ["Yes", "No"],
  counts,
  closedAt: new Date(NOW).toISOString(),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("skip vote chat command", () => {
  it("replies when viewer voting is disabled", async () => {
    const database = await createDatabase({ skipVote: { enabled: false } });
    const result = await processSongRequestsEvent(chatEvent("!skip", { settings: { skipVote: { enabled: false } } }), eventContext(database));
    expect(replyText(result)).toBe("Song voting is disabled.");
  });

  it("reports no track, no connection, and cooldown without opening a ballot", async () => {
    const noTrackDatabase = await createDatabase();
    expect(replyText(await processSongRequestsEvent(chatEvent("!skip"), eventContext(noTrackDatabase))))
      .toBe("No song is playing right now.");

    const disconnectedDatabase = await createDatabase();
    await addNowPlaying(disconnectedDatabase);
    await disconnectedDatabase.prepare("UPDATE song_requests_connections SET state = 'not_connected' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    expect(replyText(await processSongRequestsEvent(chatEvent("!skip"), eventContext(disconnectedDatabase))))
      .toBe("Spotify is not connected.");

    const cooldownDatabase = await createDatabase();
    await addNowPlaying(cooldownDatabase);
    await cooldownDatabase.prepare(
      `INSERT INTO song_requests_votes
        (ballot_id, channel_id, stream_id, candidate_tracks_json, moderator_user_id, state, created_at, completed_at,
         vote_kind, start_track_id, skip_threshold, skip_cooldown_seconds, skip_result)
       VALUES ('skip-cooldown', ?, ?, '[]', 'viewer-skip-one', 'queued', ?, ?, 'skip', ?, 2, 120, 'skipped')`,
    ).bind(CHANNEL_ID, STREAM_ID, new Date(NOW - 30_000).toISOString(), new Date(NOW - 30_000).toISOString(), TRACK.id).run();
    vi.setSystemTime(NOW);
    expect(replyText(await processSongRequestsEvent(chatEvent("!skip"), eventContext(cooldownDatabase))))
      .toBe("Please wait 90 seconds before starting another skip vote.");
  });

  it("replies with the cockpit busy text when another ballot is open", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    const result = await processSongRequestsEvent(chatEvent("!skip"), eventContext(database, { openBallot: true }));
    expect(replyText(result)).toBe("Another vote is already open.");
  });

  it("persists the skip mapping before starting and counts the starter as yes", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    const startChatVote = vi.fn<NonNullable<ModuleExecutionContext["startChatVote"]>>(async (request) => {
      const saved = await database.prepare("SELECT vote_kind, start_track_id, skip_threshold FROM song_requests_votes WHERE ballot_id = ?")
        .bind(request.ballotId ?? "").first();
      expect(saved).toEqual({ vote_kind: "skip", start_track_id: TRACK.id, skip_threshold: 2 });
      return { status: "started" as const, ballotId: request.ballotId ?? "" };
    });
    const castChatVote = vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 } as never));
    const result = await processSongRequestsEvent(chatEvent("!skip"), eventContext(database, { startChatVote, castChatVote }));

    expect(replyText(result)).toBe("Skip vote started. Your yes vote is already counted.");
    expect(startChatVote).toHaveBeenCalledWith(expect.objectContaining({ kind: "yes_no", labels: ["Yes", "No"], durationSeconds: 30 }));
    // chat_voting ballots count choices from 1; 0 would be rejected as not open.
    expect(castChatVote).toHaveBeenCalledWith(expect.any(String), "viewer-skip-one", 1);
  });

  it("casts !skip as yes while a skip ballot is open even if voting was disabled afterward", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    await addSkipMapping(database, "skip-existing-ballot");
    const castChatVote = vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [2, 0], revision: 2 } as never));
    const result = await processSongRequestsEvent(
      chatEvent("!skip", { settings: { skipVote: { enabled: false } } }),
      eventContext(database, { castChatVote }),
    );

    expect(replyText(result)).toBe("Your yes vote was counted.");
    expect(castChatVote).toHaveBeenCalledWith("skip-existing-ballot", "viewer-skip-one", 1);
  });

  it("lets moderators skip directly from chat and schedules the next playback poll", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    vi.setSystemTime(NOW);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const scheduleAlarm = vi.fn(() => Promise.resolve(undefined));
    const result = await processSongRequestsEvent(chatEvent("!skip", { chatStatus: ["moderator"] }), eventContext(database, { scheduleAlarm }));

    expect(replyText(result)).toBe("The song was skipped.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(fetcher.mock.calls[0]?.[0] as string).pathname).toBe("/v1/me/player/next");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(scheduleAlarm).toHaveBeenCalledWith("poll", "poll", NOW + 1_000, undefined, null);
  });
});

describe("skip vote close result", () => {
  it.each([
    { ballotId: "skip-below-threshold", counts: [1, 0], expected: "threshold_not_met", state: "tie" },
    { ballotId: "skip-no-majority", counts: [2, 2], expected: "no_majority", state: "tie" },
  ])("does not skip when the result is $expected", async ({ ballotId, counts, expected, state }) => {
    const database = await createDatabase();
    await addNowPlaying(database);
    await addSkipMapping(database, ballotId);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const context = alarmContext(database);

    await handleSongRequestDurableAction(context, skipResult(ballotId, counts));

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT state, skip_result, completed_at FROM song_requests_votes WHERE ballot_id = ?")
      .bind(ballotId).first()).toMatchObject({ state, skip_result: expected, completed_at: new Date(NOW).toISOString() });
  });

  it("starts the configured cooldown from the ballot close time", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    await addSkipMapping(database, "skip-cooldown-start");
    vi.setSystemTime(NOW);
    await handleSongRequestDurableAction(alarmContext(database), skipResult("skip-cooldown-start", [1, 0]));

    const result = await processSongRequestsEvent(chatEvent("!skip"), eventContext(database));
    expect(replyText(result)).toBe("Please wait 120 seconds before starting another skip vote.");
  });

  it("skips only if the track from vote start is still playing", async () => {
    const database = await createDatabase();
    await addNowPlaying(database, changedTrack);
    await addSkipMapping(database, "skip-track-changed");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const context = alarmContext(database);

    await handleSongRequestDurableAction(context, skipResult("skip-track-changed", [3, 1]));

    expect(fetcher).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT skip_result FROM song_requests_votes WHERE ballot_id = 'skip-track-changed'").first())
      .toEqual({ skip_result: "track_changed" });
    expect(context.sendChat).toHaveBeenCalledWith(expect.stringContaining("track changed while the vote was open"), "skip-vote-result:skip-track-changed");
  });

  it("skips through Spotify once after a winning yes vote", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    await addSkipMapping(database, "skip-winner");
    vi.setSystemTime(NOW);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const context = alarmContext(database);

    await handleSongRequestDurableAction(context, skipResult("skip-winner", [3, 1]));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await database.prepare("SELECT state, skip_result FROM song_requests_votes WHERE ballot_id = 'skip-winner'").first())
      .toEqual({ state: "queued", skip_result: "skipped" });
    expect(context.scheduleIfEarlier).toHaveBeenCalledWith("poll", NOW + 1_000, undefined, null);
  });

  it("does not retry Spotify 429 responses and persists backoff", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    await addSkipMapping(database, "skip-rate-limited");
    vi.setSystemTime(NOW);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { status: 429, message: "Rate limited" } }), {
      status: 429,
      headers: { "Retry-After": "30" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const context = alarmContext(database);

    await handleSongRequestDurableAction(context, skipResult("skip-rate-limited", [3, 1]));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await database.prepare("SELECT poll_backoff_until FROM song_requests_connections WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ poll_backoff_until: NOW + 30_000 });
    expect(await database.prepare("SELECT skip_result FROM song_requests_votes WHERE ballot_id = 'skip-rate-limited'").first())
      .toEqual({ skip_result: "spotify_unavailable" });
  });

  it("returns the existing no-active-device state for Spotify next 404 and blocks calls during poll backoff", async () => {
    const database = await createDatabase();
    await addNowPlaying(database);
    vi.setSystemTime(NOW);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { status: 404, message: "No active device", reason: "NO_ACTIVE_DEVICE" } }), { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(skipSongTrack({ DB: database as unknown as D1Database, channelId: CHANNEL_ID, environment }, () => Promise.resolve("token")))
      .resolves.toBe("no_active_device");
    expect(await database.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?").bind(CHANNEL_ID).first())
      .toEqual({ state: "no_active_device" });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await database.prepare("UPDATE song_requests_connections SET state = 'connected', poll_backoff_until = ? WHERE channel_id = ?")
      .bind(NOW + 5_000, CHANNEL_ID).run();
    fetcher.mockClear();
    await expect(skipSongTrack({ DB: database as unknown as D1Database, channelId: CHANNEL_ID, environment }, () => Promise.resolve("token")))
      .resolves.toBe("spotify_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("moderator skip route and cockpit action", () => {
  it("exposes the operator-only instant cockpit action and executes the skip route", async () => {
    const action = songRequestsModule.actions?.find(({ id }) => id === "skip-song");
    expect(action).toMatchObject({ id: "skip-song", requiredRole: "operator", icon: "skip-forward", conditions: ["moduleEnabled"] });

    const database = await createDatabase();
    await addNowPlaying(database);
    vi.setSystemTime(NOW);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("scheduleModuleAlarmIfEarlier", () => Promise.resolve(undefined));
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);
    const env = {
      DB: database as unknown as D1Database,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ getSpotifyAccessToken: () => Promise.resolve("token") }) },
    } as unknown as ModuleRouteEnvironment["Bindings"];

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/skip`, { method: "POST" }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "skipped" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
