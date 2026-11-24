import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleTwitchRankUser } from "../../src/modules/contract";
import {
  TwitchRanksStore,
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

const databases: DatabaseSync[] = [];

const storeFor = (options: {
  scheduleConsumerAlarmSync?: (moduleId: string, alarmKey: string, deadline: number) => void;
} = {}): { store: TwitchRanksStore; storage: DurableObjectStorage } => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
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

  it("lets a snapshot supersede an older event delivered while the pages are loading", () => {
    const { store, storage } = storeFor();
    const context = jobContext(storage);
    const startedAt = "2026-11-24T12:00:00.000Z";

    expect(store.beginSnapshot(context, "vip", startedAt)).toBe(true);
    store.applyEvent(event({ eventAt: "2026-11-24T11:59:59.000Z" }), [consumer]);
    store.applySnapshot(context, "vip", startedAt, "2026-11-24T12:00:02.000Z", [user], [consumer]);

    expect(store.readUserIds("vip")).toEqual(new Set([user.userId]));
  });

  it("rolls back the rank event and receipt together if consumer alarm scheduling fails, then deduplicates a retry", () => {
    let shouldFail = true;
    const scheduleConsumerAlarmSync = vi.fn(() => {
      if (shouldFail) throw new Error("alarm storage unavailable");
    });
    const { store, storage } = storeFor({ scheduleConsumerAlarmSync });

    expect(() => store.applyEvent(event({ action: "add" }), [consumer])).toThrow("alarm storage unavailable");
    expect(store.readUserIds("vip")).toEqual(new Set());
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
    expect(twitchRankSnapshot({ snapshotStatus: "never", snapshotStartedAt: null, lastSuccessAt: null, userIds: new Set([user.userId]) }, {
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
