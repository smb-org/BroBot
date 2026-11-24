import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotModule, ModuleTwitchRankUser } from "../../src/modules/contract";
import {
  TwitchRanksStore,
  applyTwitchRankEventToStore,
  parseTwitchRankEvent,
  runTwitchRanksReconcile,
  twitchRankCompletenessReason,
  twitchRankPageSchema,
  twitchRankSnapshot,
  type TwitchRankEvent,
  type TwitchRankType,
} from "../../src/worker/durable/twitch-ranks";
import { helixPages } from "../../src/worker/twitch/helix";
import type { ChannelJobRunContext } from "../../src/worker/durable/channel-jobs";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

const databases: DatabaseSync[] = [];

const storeFor = (options: {
  scheduleConsumerAlarmSync?: (moduleId: string, alarmKey: string, deadline: number) => void;
  legacySyncState?: boolean;
} = {}): { store: TwitchRanksStore; storage: DurableObjectStorage } => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  if (options.legacySyncState === true) database.exec(`CREATE TABLE twitch_rank_sync_state (
    rank_type TEXT PRIMARY KEY CHECK (rank_type IN ('vip', 'moderator')),
    snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('never', 'running', 'failed', 'success')),
    snapshot_started_at TEXT,
    applied_snapshot_started_at TEXT,
    last_success_at TEXT
  )`);
  const sql = {
    exec: <Row extends Record<string, unknown>>(query: string, ...values: SQLInputValue[]) => {
      const statement = database.prepare(query);
      const rows = /^\s*(SELECT|PRAGMA)/iu.test(query)
        ? statement.all(...values) as Row[]
        : (statement.run(...values), [] as Row[]);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  const storage = {
    sql,
    transactionSync: <Result>(operation: () => Result): Result => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { store: new TwitchRanksStore(storage, options), storage };
};

const jobContext = (storage: DurableObjectStorage, isCurrent: () => boolean = () => true): ChannelJobRunContext => ({
  jobId: "host:twitch_ranks:reconcile",
  claimToken: "test-claim-token",
  isCurrent,
  assertCurrent: () => { if (!isCurrent()) throw new Error("stale claim"); },
  commit: (write) => storage.transactionSync(() => {
    if (!isCurrent()) return false;
    write(storage.sql);
    return true;
  }),
});

const consumer = { moduleId: "test_role_consumer", alarmKey: "role_reconcile" } as const;
const consumerModule = {
  id: consumer.moduleId,
  consumes: ["twitch_ranks"],
  reconcileAlarmKeys: { twitch_ranks: consumer.alarmKey },
  alarms: [{ key: consumer.alarmKey, job: { handlerKey: "test:role_reconcile" } }],
} as unknown as BotModule;
const user: ModuleTwitchRankUser = { userId: "viewer-1", login: "pixelpilot", displayName: "PixelPilot" };
const seedUser = (
  store: TwitchRanksStore,
  storage: DurableObjectStorage,
  rankType: TwitchRankType,
  value: ModuleTwitchRankUser,
  updatedAt: string,
): void => {
  store.readState(rankType);
  storage.transactionSync(() => storage.sql.exec(
    `INSERT INTO twitch_rank_memberships
       (rank_type, user_id, user_login, user_display_name, is_member, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    rankType,
    value.userId,
    value.login,
    value.displayName,
    updatedAt,
  ));
};
const event = (overrides: Partial<TwitchRankEvent> = {}): TwitchRankEvent => ({
  messageId: "event-1",
  rankType: "vip",
  action: "remove",
  userId: user.userId,
  login: user.login,
  displayName: user.displayName,
  eventAt: "2026-11-24T12:00:01.000Z",
  ...overrides,
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Twitch rank storage", () => {
  it("adds tracking-gap state to an existing ChannelObject schema", () => {
    const { store } = storeFor({ legacySyncState: true });

    expect(store.readState("vip").lastTrackingGapAt).toBeNull();
  });

  it("does not ask Helix for data when there are no consumers", async () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const scopeAvailable = vi.fn(() => Promise.resolve(true));
    const listRankUsers = vi.fn();

    await expect(runTwitchRanksReconcile(context, {
      store,
      now: "2026-11-24T12:00:00.000Z",
      consumers: [],
      scopeAvailable,
      listRankUsers,
    })).resolves.toMatchObject({ summary: { en: "0 VIPs, 0 moderators" } });

    expect(scopeAvailable).not.toHaveBeenCalled();
    expect(listRankUsers).not.toHaveBeenCalled();
  });

  it("replays a VIP removal delivered during a snapshot over the snapshot page", () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    seedUser(store, storage, "vip", user, "2026-11-24T11:00:00.000Z");

    const startedAt = "2026-11-24T12:00:00.000Z";
    expect(store.beginSnapshot(context, "vip", startedAt)).toBe(true);
    expect(store.applyEvent(event(), [consumer]).changed).toBe(true);
    expect(store.applySnapshot(context, "vip", startedAt, "2026-11-24T12:00:02.000Z", [user], [consumer])).toBe(true);

    expect(store.readUserIds("vip")).toEqual(new Set());
  });

  it("records a gap for skipped delivery during token failure and rejects its in-flight snapshot", async () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const database = new TestD1Database();
    try {
      await insertChannel(database, "rank-channel");
      await insertLoginIdentityAndSession(database, "rank-channel", ["channel:bot", "channel:read:vips"]);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
      ).bind("rank-channel", consumer.moduleId).run();
      await database.prepare(
        "UPDATE twitch_login_identity SET status = 'error', reason = 'validate_failed' WHERE user_id = ?",
      ).bind("rank-channel").run();

      const previousStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      expect(store.beginSnapshot(context, "vip", previousStartedAt)).toBe(true);
      expect(store.applySnapshot(
        context,
        "vip",
        previousStartedAt,
        new Date(Date.parse(previousStartedAt) + 1_000).toISOString(),
        [user],
        [consumer],
      )).toBe(true);
      const inFlightStartedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      expect(store.beginSnapshot(context, "vip", inFlightStartedAt)).toBe(true);

      const reconcileNeeded = vi.fn(async () => {});
      await expect(applyTwitchRankEventToStore(
        { DB: database as unknown as D1Database },
        store,
        "rank-channel",
        {
          messageId: "token-error-removal",
          subscriptionType: "channel.vip.remove",
          payload: {
            user_id: user.userId,
            user_login: user.login,
            user_name: user.displayName,
            broadcaster_user_id: "rank-channel",
            broadcaster_user_login: "fictionalchannel",
            broadcaster_user_name: "FictionalChannel",
          },
          eventAt: new Date(Date.parse(inFlightStartedAt) + 1_000).toISOString(),
        },
        reconcileNeeded,
        [consumerModule],
      )).resolves.toMatchObject({ changed: true, ignored: false, duplicate: false });
      // The applied event itself must leave the gap, before any later skipped delivery does.
      expect(store.readState("vip").lastTrackingGapAt).not.toBeNull();
      expect(store.readState("vip").snapshotStatus).toBe("failed");

      await expect(applyTwitchRankEventToStore(
        { DB: database as unknown as D1Database },
        store,
        "rank-channel",
        {
          messageId: "malformed-during-token-error",
          subscriptionType: "channel.vip.remove",
          payload: {},
          eventAt: new Date().toISOString(),
        },
        reconcileNeeded,
        [consumerModule],
      )).resolves.toMatchObject({ ignored: true, duplicate: false });

      expect(reconcileNeeded).toHaveBeenCalledTimes(2);
      expect(store.readUserIds("vip")).toEqual(new Set());
      await database.prepare(
        "UPDATE twitch_login_identity SET status = 'connected', reason = NULL WHERE user_id = ?",
      ).bind("rank-channel").run();
      const gapState = store.readState("vip");
      expect(gapState.snapshotStatus).toBe("failed");
      expect(gapState.lastTrackingGapAt).not.toBeNull();
      expect(() => store.applySnapshot(
        context,
        "vip",
        inFlightStartedAt,
        new Date(Date.now() + 1_000).toISOString(),
        [user],
        [consumer],
      )).toThrow("twitch_rank_snapshot_superseded");

      const completeness = {
        scopeAvailable: true,
        tokenValid: true,
        snapshotStatus: gapState.snapshotStatus,
        lastSuccessAt: gapState.lastSuccessAt,
        snapshotStartedAt: gapState.snapshotStartedAt,
        appliedSnapshotStartedAt: gapState.appliedSnapshotStartedAt,
        lastTrackingGapAt: gapState.lastTrackingGapAt,
        subscriptionsEnabledSinceSnapshot: true,
        jobPaused: false,
        now: Date.now() + 2_000,
        intervalMs: 60 * 60_000,
      };
      expect(twitchRankCompletenessReason(completeness)).toBe("tracking_gap");

      const afterGap = new Date(Date.parse(gapState.lastTrackingGapAt ?? "") + 1_000).toISOString();
      expect(store.beginSnapshot(context, "vip", afterGap)).toBe(true);
      expect(store.applySnapshot(context, "vip", afterGap, new Date(Date.parse(afterGap) + 1_000).toISOString(), [], [consumer])).toBe(true);
      const recoveredState = store.readState("vip");
      expect(twitchRankCompletenessReason({
        ...completeness,
        snapshotStatus: recoveredState.snapshotStatus,
        lastSuccessAt: recoveredState.lastSuccessAt,
        snapshotStartedAt: recoveredState.snapshotStartedAt,
        appliedSnapshotStartedAt: recoveredState.appliedSnapshotStartedAt,
        lastTrackingGapAt: recoveredState.lastTrackingGapAt,
        now: Date.parse(recoveredState.lastSuccessAt ?? ""),
      })).toBeNull();
    } finally {
      database.close();
    }
  });

  it("lets a snapshot supersede an older event delivered while the pages are loading", () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const startedAt = "2026-11-24T12:00:00.000Z";

    expect(store.beginSnapshot(context, "vip", startedAt)).toBe(true);
    store.applyEvent(event({ eventAt: "2026-11-24T11:59:59.000Z" }), [consumer]);
    store.applySnapshot(context, "vip", startedAt, "2026-11-24T12:00:02.000Z", [user], [consumer]);

    expect(store.readUserIds("vip")).toEqual(new Set([user.userId]));
  });

  it("rolls back a rank event, receipt, and gap together if alarm scheduling fails", () => {
    let shouldFail = true;
    const scheduleConsumerAlarmSync = vi.fn(() => {
      if (shouldFail) throw new Error("alarm storage unavailable");
    });
    const { store, storage } = storeFor({ scheduleConsumerAlarmSync });

    expect(() => store.applyEvent(
      event({ action: "add" }),
      [consumer],
      Date.now(),
      "2026-11-24T12:00:01.000Z",
    )).toThrow("alarm storage unavailable");
    expect(store.readUserIds("vip")).toEqual(new Set());
    expect(store.readState("vip").lastTrackingGapAt).toBeNull();
    shouldFail = false;
    expect(store.applyEvent(event({ action: "add" }), [consumer]).duplicate).toBe(false);
    expect(store.isConsumerDirty(consumer.moduleId)).toEqual({ dirty: true, generation: 1 });
    expect(store.applyEvent(event({ action: "add" }), [consumer]).duplicate).toBe(true);
    expect(store.readUserIds("vip")).toEqual(new Set([user.userId]));
    expect(store.markConsumerReconciled(consumer.moduleId, 1, jobContext(storage)))
      .toBe(true);
    expect(store.isConsumerDirty(consumer.moduleId)).toEqual({ dirty: false, generation: 1 });
    expect(scheduleConsumerAlarmSync).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous rank set and marks the type incomplete when the second Helix page fails", async () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const previous = { userId: "viewer-old", login: "oldpixel", displayName: "OldPixel" };
    seedUser(store, storage, "vip", previous, "2026-11-24T11:00:00.000Z");
    const pageCalls: (string | null)[] = [];

    await expect(runTwitchRanksReconcile(context, {
      store,
      now: "2026-11-24T12:00:00.000Z",
      consumers: [consumer],
      scopeAvailable: (rankType) => Promise.resolve(rankType === "vip"),
      listRankUsers: async (rankType) => rankType === "vip" ? await helixPages((cursor) => {
        pageCalls.push(cursor);
        return Promise.resolve(cursor === null
          ? { ok: true as const, status: 200, data: { data: [user], pagination: { cursor: "cursor-next" } } }
          : { ok: false as const, status: 503, reason: "http_503" as const, message: null, body: {} });
      }) : { ok: true as const, status: 200, data: [] },
    })).rejects.toThrow();

    expect(pageCalls).toEqual([null, "cursor-next"]);
    expect(store.readUserIds("vip")).toEqual(new Set([previous.userId]));
    expect(store.readState("vip").snapshotStatus).toBe("failed");
    expect(twitchRankCompletenessReason({
      scopeAvailable: true,
      tokenValid: true,
      snapshotStatus: store.readState("vip").snapshotStatus,
      lastSuccessAt: store.readState("vip").lastSuccessAt,
      snapshotStartedAt: store.readState("vip").snapshotStartedAt,
      subscriptionsEnabledSinceSnapshot: true,
      jobPaused: false,
      now: Date.parse("2026-11-24T12:00:03.000Z"),
      intervalMs: 60 * 60_000,
    })).toBe("snapshot_failed");
  });

  it("does not call Helix or change members when the scope is unavailable", async () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const previous = { userId: "viewer-old", login: "oldpixel", displayName: "OldPixel" };
    seedUser(store, storage, "vip", previous, "2026-11-24T11:00:00.000Z");
    const listRankUsers = vi.fn();

    await expect(runTwitchRanksReconcile(context, {
      store,
      now: "2026-11-24T12:00:00.000Z",
      consumers: [consumer],
      scopeAvailable: () => Promise.resolve(false),
      listRankUsers,
    })).rejects.toMatchObject({ code: "missing_scope" });

    expect(listRankUsers).not.toHaveBeenCalled();
    expect(store.readUserIds("vip")).toEqual(new Set([previous.userId]));
  });

  it("requires each independent completeness condition before exposing a complete rank set", () => {
    const complete = {
      scopeAvailable: true,
      tokenValid: true,
      snapshotStatus: "success" as const,
      lastSuccessAt: "2026-11-24T11:00:00.000Z",
      snapshotStartedAt: "2026-11-24T10:59:00.000Z",
      subscriptionsEnabledSinceSnapshot: true,
      jobPaused: false,
      now: Date.parse("2026-11-24T12:00:00.000Z"),
      intervalMs: 60 * 60_000,
    };

    expect(twitchRankCompletenessReason(complete)).toBeNull();
    expect(twitchRankCompletenessReason({ ...complete, scopeAvailable: false })).toBe("missing_scope");
    expect(twitchRankCompletenessReason({ ...complete, subscriptionsEnabledSinceSnapshot: false })).toBe("eventsub_incomplete");
    expect(twitchRankCompletenessReason({ ...complete, tokenValid: false })).toBe("token_invalid");
    expect(twitchRankCompletenessReason({ ...complete, jobPaused: true })).toBe("job_paused");
    expect(twitchRankCompletenessReason({ ...complete, lastSuccessAt: "2026-11-24T09:59:59.999Z" })).toBe("stale");
    expect(twitchRankSnapshot({
      snapshotStatus: "never",
      snapshotStartedAt: null,
      appliedSnapshotStartedAt: null,
      lastSuccessAt: null,
      lastTrackingGapAt: null,
      userIds: new Set([user.userId]),
    }, {
      ...complete,
      scopeAvailable: false,
      snapshotStatus: "never",
      snapshotStartedAt: null,
      lastSuccessAt: null,
    })).toMatchObject({ available: false, complete: false, reason: "missing_scope", userIds: new Set() });
  });

  it("parses the current Helix and EventSub payload shapes", () => {
    expect(twitchRankPageSchema.parse({
      data: [{ user_id: "viewer-1", user_login: "pixelpilot", user_name: "PixelPilot" }],
      pagination: { cursor: "cursor-next" },
    })).toEqual({ data: [user], pagination: { cursor: "cursor-next" } });
    expect(twitchRankPageSchema.parse({
      data: [{ user_id: "user-42", user_login: "modpixel", user_name: "ModPixel" }],
      pagination: {},
    })).toMatchObject({ data: [{ userId: "user-42", login: "modpixel", displayName: "ModPixel" }] });
    expect(parseTwitchRankEvent("msg-vip", "channel.vip.remove", {
      user_id: "user-41",
      user_login: "pixelpilot",
      user_name: "PixelPilot",
      broadcaster_user_id: "channel-1",
      broadcaster_user_login: "fictionalchannel",
      broadcaster_user_name: "FictionalChannel",
    }, "2026-11-24T12:00:01.123456789Z")).toMatchObject({
      rankType: "vip", action: "remove", userId: "user-41", login: "pixelpilot", eventAt: "2026-11-24T12:00:01.123456789Z",
    });
    expect(parseTwitchRankEvent("msg-moderator", "channel.moderator.add", {
      user_id: "user-42",
      user_login: "modpixel",
      user_name: "ModPixel",
      broadcaster_user_id: "channel-1",
      broadcaster_user_login: "fictionalchannel",
      broadcaster_user_name: "FictionalChannel",
    }, "2026-11-24T12:00:02.000Z")).toMatchObject({ rankType: "moderator", action: "add", userId: "user-42" });

    for (const [action, rankType, expectedAction, userKey] of [
      ["vip", "vip", "add", "vip"],
      ["unvip", "vip", "remove", "unvip"],
      ["mod", "moderator", "add", "mod"],
      ["unmod", "moderator", "remove", "unmod"],
    ] as const) {
      expect(parseTwitchRankEvent(`msg-${action}`, "channel.moderate", {
        action,
        [userKey]: { user_id: "user-42", user_login: "modpixel", user_name: "ModPixel" },
      }, "2026-11-24T12:00:03.000Z")).toMatchObject({ rankType, action: expectedAction, userId: "user-42" });
    }
  });

  it("applies a delayed event newer than the applied snapshot start even after snapshot commit", () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const startedAt = "2026-11-24T12:00:00.000Z";
    expect(store.beginSnapshot(context, "vip", startedAt)).toBe(true);
    expect(store.applySnapshot(context, "vip", startedAt, "2026-11-24T12:00:05.000Z", [user], [consumer])).toBe(true);

    expect(store.applyEvent(event({
      messageId: "delayed-remove",
      action: "remove",
      eventAt: "2026-11-24T12:00:02.000000001Z",
    }), [consumer]).changed).toBe(true);
    expect(store.readUserIds("vip")).toEqual(new Set());
  });

  it("keeps event state writable while paused, reports incomplete, then refreshes after resume", async () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const initialStartedAt = "2026-11-24T10:00:00.000Z";
    expect(store.beginSnapshot(context, "vip", initialStartedAt)).toBe(true);
    expect(store.applySnapshot(context, "vip", initialStartedAt, "2026-11-24T10:00:01.000Z", [user], [consumer])).toBe(true);

    expect(store.applyEvent(event({ action: "remove", eventAt: "2026-11-24T11:00:00.000Z" }), [consumer]).changed).toBe(true);
    const pausedReason = twitchRankCompletenessReason({
      scopeAvailable: true,
      tokenValid: true,
      snapshotStatus: store.readState("vip").snapshotStatus,
      lastSuccessAt: store.readState("vip").lastSuccessAt,
      snapshotStartedAt: store.readState("vip").snapshotStartedAt,
      subscriptionsEnabledSinceSnapshot: true,
      jobPaused: true,
      now: Date.parse("2026-11-24T11:30:00.000Z"),
      intervalMs: 60 * 60_000,
    });
    expect(pausedReason).toBe("job_paused");
    expect(store.readUserIds("vip")).toEqual(new Set());

    await runTwitchRanksReconcile(context, {
      store,
      now: "2026-11-24T11:31:00.000Z",
      consumers: [consumer],
      scopeAvailable: (rankType) => Promise.resolve(rankType === "vip"),
      listRankUsers: () => Promise.resolve({ ok: true, status: 200, data: [] }),
      completedAt: () => "2026-11-24T11:31:01.000Z",
    });

    const resumedState = store.readState("vip");
    expect(resumedState.snapshotStatus).toBe("success");
    expect(resumedState.userIds).toEqual(new Set());
    expect(twitchRankCompletenessReason({
      scopeAvailable: true,
      tokenValid: true,
      snapshotStatus: resumedState.snapshotStatus,
      lastSuccessAt: resumedState.lastSuccessAt,
      snapshotStartedAt: resumedState.snapshotStartedAt,
      subscriptionsEnabledSinceSnapshot: true,
      jobPaused: false,
      now: Date.parse("2026-11-24T11:31:02.000Z"),
      intervalMs: 60 * 60_000,
    })).toBeNull();
  });

  it("keeps snapshot writes behind the channel job claim fence", () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage, () => false);

    expect(store.beginSnapshot(context, "moderator", "2026-11-24T12:00:00.000Z")).toBe(false);
    expect(store.readState("moderator").snapshotStatus).toBe("never");
  });
});
