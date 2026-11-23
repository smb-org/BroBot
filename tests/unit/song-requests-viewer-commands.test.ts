import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext, ModulePointsAccess } from "../../src/modules/contract";
import { songRequestsSettingsSchema, type SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import {
  readSongRequest,
  transitionRequest,
} from "../../src/modules/song_requests/adapters/d1";
import {
  processSongRequestsEvent,
  songRequestChargeOperationId,
  songRequestRefundOperationId,
} from "../../src/modules/song_requests/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-viewer-commands";
const STREAM_ID = "stream-viewer-commands";
const NOW = "2026-11-23T19:00:00.000Z";
const TRACK = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  title: "Glass Harbor",
  artists: ["Mira Vale"],
  albumName: "Quiet Atlas",
  durationMs: 201_000,
  explicit: false,
  coverUrl: null,
  spotifyUrl: "https://open.spotify.com/track/glassharbor01",
};
const databases: TestD1Database[] = [];

const createDatabase = async (rawSettings: Record<string, unknown> = {}): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  const settings = songRequestsSettingsSchema.parse(rawSettings);
  await database.batch([
    database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, ?)")
      .bind(CHANNEL_ID, JSON.stringify(settings)),
    database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, NOW, STREAM_ID, NOW),
  ]);
  return database;
};

const createPoints = () => {
  const operations = new Map<string, { kind: string; result: unknown }>();
  const cooldowns = new Map<string, number>();
  const apply = vi.fn((operationId: string, kind: string, _movements: unknown[], result: unknown) => {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.kind !== kind) return Promise.reject(new Error("operation_conflict"));
      return Promise.resolve({ result: existing.result });
    }
    operations.set(operationId, { kind, result });
    return Promise.resolve({ result });
  });
  const points = {
    apply,
    getOperation: vi.fn((operationId: string) => Promise.resolve(operations.get(operationId) ?? null)),
    claimCooldown: vi.fn((key: string, seconds: number) => {
      const until = cooldowns.get(key) ?? 0;
      if (until > Date.now()) return Promise.resolve(false);
      cooldowns.set(key, Date.now() + seconds * 1_000);
      return Promise.resolve(true);
    }),
  } as unknown as ModulePointsAccess;
  return { points, operations, apply };
};

const eventContext = (
  database: TestD1Database | D1Database,
  points: ModulePointsAccess,
  options: { channelPoints?: ModuleExecutionContext["channelPoints"] } = {},
): ModuleExecutionContext => ({
  DB: database as unknown as D1Database,
  channelId: CHANNEL_ID,
  points,
  channelLanguage: () => Promise.resolve("en"),
  botUserId: () => Promise.resolve("bot-viewer-commands"),
  ...(options.channelPoints === undefined ? {} : { channelPoints: options.channelPoints }),
  scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
  scheduleAlarmIfEarlier: vi.fn(() => Promise.resolve(undefined)),
  clearAlarm: vi.fn(() => Promise.resolve(undefined)),
} as unknown as ModuleExecutionContext);

const chatEvent = (
  text: string,
  userId = "viewer-one",
  options: { settings?: Record<string, unknown>; sourceBroadcasterUserId?: string } = {},
) => ({
  channelId: CHANNEL_ID,
  subscriptionType: "channel.chat.message" as const,
  triggerId: `trigger-${text.replaceAll("!", "")}`,
  receivedAt: NOW,
  actor: null,
  chatStatus: null,
  settings: songRequestsSettingsSchema.parse(options.settings ?? {}),
  payload: {
    chatter_user_id: userId,
    chatter_user_login: userId.replaceAll("-", "_"),
    chatter_user_name: "Fictional Viewer",
    message_id: `message-${text.replaceAll("!", "")}`,
    message: { text },
    ...(options.sourceBroadcasterUserId === undefined ? {} : { source_broadcaster_user_id: options.sourceBroadcasterUserId }),
  },
}) as ModuleEvent<SongRequestsSettings>;

const replyText = (result: Awaited<ReturnType<typeof processSongRequestsEvent>>): string => {
  const action = result.actions.find((candidate) => candidate.kind === "chat");
  return action?.kind === "chat" ? action.text : "";
};

const seedRequest = async (
  database: TestD1Database,
  options: {
    requestId: string;
    userId?: string;
    state?: "pending_review" | "approved" | "submitting" | "submitted";
    requestType?: "bot_points" | "free" | "channel_points";
    createdAt?: string;
  },
): Promise<void> => {
  const requestState = options.state ?? "approved";
  const requestType = options.requestType ?? "free";
  const channelPoints = requestType === "channel_points";
  const initialState = requestState === "pending_review" ? "pending_review" : "approved";
  await transitionRequest(database as unknown as D1Database, {
    channelId: CHANNEL_ID,
    requestId: options.requestId,
    fromState: null,
    toState: initialState,
    now: options.createdAt ?? NOW,
    newRequest: {
      source: channelPoints ? "channel_points" : "points",
      requestType,
      channelPointsRewardId: channelPoints ? "reward-fictional" : null,
      chargedAmount: requestType === "bot_points" ? 10 : 0,
      track: { ...TRACK, title: options.requestId },
      operationId: `operation-${options.requestId}`,
      streamId: STREAM_ID,
      roundId: STREAM_ID,
      requesterUserId: options.userId ?? "viewer-one",
      requesterLogin: (options.userId ?? "viewer-one").replaceAll("-", "_"),
      requesterDisplayName: options.userId ?? "Fictional Viewer",
    },
  });
  if (requestState === "submitting" || requestState === "submitted") {
    await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: options.requestId, fromState: "approved", toState: "submitting", now: NOW,
    });
  }
  if (requestState === "submitted") {
    await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: options.requestId, fromState: "submitting", toState: "submitted", now: NOW,
    });
  }
};

const setNowPlaying = async (database: TestD1Database, requester: string | null): Promise<void> => {
  await database.prepare(
    `INSERT INTO song_requests_now_playing (channel_id, revision, track_json, progress_ms, observed_at)
     VALUES (?, 1, ?, 0, ?)`,
  ).bind(CHANNEL_ID, JSON.stringify({
    id: TRACK.id,
    title: "Glass Harbor",
    artist: "Mira Vale",
    spotifyUrl: TRACK.spotifyUrl,
    requester,
    source: requester === null ? "manual" : "points",
  }), NOW).run();
};

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("song request viewer chat commands", () => {
  it("reports the current track with its Spotify link and requester, or says nothing is playing", async () => {
    const database = await createDatabase();
    const { points } = createPoints();
    const context = eventContext(database, points);
    expect(replyText(await processSongRequestsEvent(chatEvent("!song"), context)))
      .toBe("No song is playing right now.");

    await setNowPlaying(database, "Fictional Viewer");
    const result = await processSongRequestsEvent(chatEvent("!song", "viewer-two"), context);
    expect(replyText(result)).toContain("Glass Harbor — Mira Vale");
    expect(replyText(result)).toContain("https://open.spotify.com/track/glassharbor01");
    expect(replyText(result)).toContain("Requested by Fictional Viewer");

    await database.prepare("UPDATE song_requests_now_playing SET track_json = ? WHERE channel_id = ?")
      .bind(JSON.stringify({
        id: TRACK.id,
        title: "Glass Harbor",
        artist: "Mira Vale",
        spotifyUrl: TRACK.spotifyUrl,
        requester: null,
        source: "manual",
      }), CHANNEL_ID).run();
    const manualReply = replyText(await processSongRequestsEvent(chatEvent("!song", "viewer-three"), context));
    expect(manualReply).toContain("Glass Harbor — Mira Vale");
    expect(manualReply).not.toContain("Requested by");
  });

  it("lists only the caller's open requests with positions from the ledger order", async () => {
    const database = await createDatabase();
    const { points } = createPoints();
    await seedRequest(database, { requestId: "own-first", userId: "viewer-one", createdAt: "2026-11-23T18:00:00.000Z" });
    await seedRequest(database, { requestId: "other-second", userId: "viewer-two", createdAt: "2026-11-23T18:01:00.000Z" });
    await seedRequest(database, { requestId: "own-third", userId: "viewer-one", createdAt: "2026-11-23T18:02:00.000Z" });

    const result = await processSongRequestsEvent(chatEvent("!queue"), eventContext(database, points));
    expect(replyText(result)).toBe("Your open song requests: 1. Mira Vale – own-first (Quiet Atlas); 3. Mira Vale – own-third (Quiet Atlas)");
    expect(replyText(result)).not.toContain("other-second");
  });

  it("reports an empty queue and truncates long replies with a count under 500 characters", async () => {
    const emptyDatabase = await createDatabase();
    const { points: emptyPoints } = createPoints();
    expect(replyText(await processSongRequestsEvent(chatEvent("!queue"), eventContext(emptyDatabase, emptyPoints))))
      .toBe("You have no open song requests.");

    const longDatabase = await createDatabase();
    const { points } = createPoints();
    for (let index = 0; index < 12; index += 1) {
      await transitionRequest(longDatabase as unknown as D1Database, {
        channelId: CHANNEL_ID,
        requestId: `long-${String(index).padStart(2, "0")}`,
        fromState: null,
        toState: "approved",
        now: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        newRequest: {
          source: "points",
          requestType: "free",
          track: { ...TRACK, title: `A very long fictional track title ${String(index)} ${"harbor ".repeat(7)}` },
          operationId: `operation-long-${String(index)}`,
          streamId: STREAM_ID,
          roundId: STREAM_ID,
          requesterUserId: "viewer-one",
        },
      });
    }
    const reply = replyText(await processSongRequestsEvent(chatEvent("!queue"), eventContext(longDatabase, points)));
    expect(Array.from(reply).length).toBeLessThanOrEqual(500);
    expect(reply).toContain("… +");
  });

  it("refuses a withdrawal transition for a request owned by another viewer", async () => {
    const database = await createDatabase();
    await seedRequest(database, { requestId: "foreign-request", userId: "viewer-two" });
    const withdraw = (expectedRequesterUserId: string): Promise<boolean> => transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID,
      requestId: "foreign-request",
      fromState: "approved",
      toState: "rejected",
      failureReason: "viewer_wrong_song",
      refundDue: true,
      expectedRequesterUserId,
      now: NOW,
    });
    expect(await withdraw("viewer-one")).toBe(false);
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "foreign-request")).toMatchObject({ state: "approved" });
    expect(await withdraw("viewer-two")).toBe(true);
  });

  it("withdraws only the caller's newest pre-submit request and refunds bot points once", async () => {
    const database = await createDatabase();
    const { points, operations, apply } = createPoints();
    await seedRequest(database, { requestId: "own-older", userId: "viewer-one", requestType: "bot_points", createdAt: "2026-11-23T18:00:00.000Z" });
    await seedRequest(database, { requestId: "own-newest", userId: "viewer-one", state: "pending_review", requestType: "bot_points", createdAt: "2026-11-23T18:01:00.000Z" });
    await seedRequest(database, { requestId: "other-newer", userId: "viewer-two", requestType: "bot_points", createdAt: "2026-11-23T18:02:00.000Z" });
    await seedRequest(database, { requestId: "own-submitted-newest", userId: "viewer-one", state: "submitted", requestType: "bot_points", createdAt: "2026-11-23T18:03:00.000Z" });
    operations.set(songRequestChargeOperationId("own-newest"), { kind: "stake", result: { amount: 10 } });

    const context = eventContext(database, points);
    const result = await processSongRequestsEvent(chatEvent("!wrongsong"), context);
    expect(replyText(result)).toBe("Your latest song request was withdrawn. Bot points were refunded.");
    expect(context.clearAlarm).toHaveBeenCalledWith("submit:own-newest");
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "own-newest"))
      .toMatchObject({ state: "rejected", failureReason: "viewer_wrong_song", refundDue: false });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "own-older"))
      .toMatchObject({ state: "approved" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "own-submitted-newest"))
      .toMatchObject({ state: "submitted" });
    expect(await readSongRequest(database as unknown as D1Database, CHANNEL_ID, "other-newer"))
      .toMatchObject({ state: "approved" });
    expect(operations.has(songRequestRefundOperationId("own-newest"))).toBe(true);
    expect(apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);

    expect(replyText(await processSongRequestsEvent(chatEvent("!wrongsong"), context)))
      .toBe("You can no longer withdraw that song request.");
    expect(apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
  });

  it("cancels channel point redemptions and refuses requests that already reached submission", async () => {
    const database = await createDatabase();
    const { points } = createPoints();
    await seedRequest(database, { requestId: "channel-points-request", requestType: "channel_points" });
    const resolveRedemption = vi.fn(() => Promise.resolve(true));
    const context = eventContext(database, points, { channelPoints: { resolveRedemption } as never });
    expect(replyText(await processSongRequestsEvent(chatEvent("!wrongsong"), context)))
      .toBe("Your latest song request was withdrawn. The Channel Points redemption was canceled.");
    expect(resolveRedemption).toHaveBeenCalledWith("operation-channel-points-request", "CANCELED");

    const submittedDatabase = await createDatabase();
    const { points: submittedPoints, apply } = createPoints();
    await seedRequest(submittedDatabase, { requestId: "submitted-request", state: "submitted", requestType: "bot_points" });
    const submittedContext = eventContext(submittedDatabase, submittedPoints);
    expect(replyText(await processSongRequestsEvent(chatEvent("!wrongsong"), submittedContext)))
      .toBe("You can no longer withdraw that song request.");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not refund when the submit transition wins the compare-and-set race", async () => {
    const database = await createDatabase();
    const { points, operations, apply } = createPoints();
    await seedRequest(database, { requestId: "racing-request", requestType: "bot_points" });
    operations.set(songRequestChargeOperationId("racing-request"), { kind: "stake", result: { amount: 10 } });
    const baseDatabase = database as unknown as D1Database;
    let submitWon = false;
    const racingDatabase = new Proxy(baseDatabase, {
      get(target, property) {
        if (property !== "prepare") {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SELECT id, state, failure_reason FROM song_requests")) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                first: async <Row>(): Promise<Row | null> => {
                  const row = await bound.first<Row>();
                  if (!submitWon && row !== null) {
                    submitWon = true;
                    await transitionRequest(baseDatabase, {
                      channelId: CHANNEL_ID,
                      requestId: "racing-request",
                      fromState: "approved",
                      toState: "submitting",
                      now: NOW,
                    });
                  }
                  return row;
                },
              };
            },
          };
        };
      },
    });

    const result = await processSongRequestsEvent(chatEvent("!wrongsong"), eventContext(racingDatabase, points));
    expect(replyText(result)).toBe("You can no longer withdraw that song request.");
    expect(await readSongRequest(baseDatabase, CHANNEL_ID, "racing-request")).toMatchObject({ state: "submitting" });
    expect(apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(0);
  });

  it("applies per-user cooldowns, honors disabled settings, and ignores bot or shared-chat messages", async () => {
    const database = await createDatabase();
    const { points } = createPoints();
    const context = eventContext(database, points);
    expect(replyText(await processSongRequestsEvent(chatEvent("!queue"), context))).toBe("You have no open song requests.");
    expect((await processSongRequestsEvent(chatEvent("!queue"), context)).actions).toEqual([]);
    await setNowPlaying(database, null);
    await seedRequest(database, { requestId: "viewer-disabled-request", userId: "viewer-disabled" });

    for (const [command, settings, expected] of [
      ["!song", { songCommandEnabled: false }, "Now playing:"],
      ["!queue", { queueCommandEnabled: false }, "1. Mira Vale – viewer-disabled-request"],
      ["!wrongsong", { wrongSongCommandEnabled: false }, "was withdrawn"],
    ] as const) {
      const result = await processSongRequestsEvent(chatEvent(command, "viewer-disabled", { settings }), context);
      expect(result.actions).toEqual([]);
      expect(replyText(await processSongRequestsEvent(chatEvent(command, "viewer-disabled"), context))).toContain(expected);
    }
    expect(points.claimCooldown).toHaveBeenCalledTimes(5);
    expect((await processSongRequestsEvent(chatEvent("!song", "bot-viewer-commands"), context)).actions).toEqual([]);
    expect((await processSongRequestsEvent(chatEvent("!song", "viewer-shared", { sourceBroadcasterUserId: "another-channel" }), context)).actions)
      .toEqual([]);
  });
});
