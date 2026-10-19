import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ModuleAlarmContext, ModuleAlarmDefinition, ModuleExternalFetchBudget } from "../../src/modules/contract";
import { templateLanguageText } from "../../src/modules/template-language";
import { AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY } from "../../src/worker/durable/automated-chat-output";
import type { ChatSendResult, sendChatMessage } from "../../src/worker/chat";

type HostChatSender = (...args: Parameters<typeof sendChatMessage>) => Promise<ChatSendResult>;
const hostChatMock = vi.hoisted(() => ({ send: vi.fn<HostChatSender>() }));

vi.mock("../../src/worker/chat", () => ({
  sendChatMessage: (...args: Parameters<typeof sendChatMessage>) => hostChatMock.send(...args),
}));

import {
  insertPointChannel,
  pointObject,
  pointTestModule,
  capturePointError,
  clearPointObjectAlarms,
  deferPointAlarmWithin,
  forcePointAlarm,
  openAnnouncedRound,
  runPointObject,
  runPointAlarm,
  schedulePointCancellationNoticeAlarmWithin,
  stubPointRoundChat,
  runMigrations,
  testCard,
  type PointsWorkerObject,
} from "./points-test-helpers";

beforeAll(runMigrations);
afterEach(async () => {
  try {
    await clearPointObjectAlarms();
  } finally {
    vi.useRealTimers();
  }
  hostChatMock.send.mockReset();
  hostChatMock.send.mockImplementation(() => Promise.resolve({
    sent: false,
    truncated: false,
    delivery: "not_attempted",
    reason: "test_transport_unconfigured",
    detail: {},
  }));
});

describe("game rounds in the worker Durable Object", () => {
  it(`rejects a join after the stored deadline without booking a stake (${testCard("join checks the round deadline inside the DO transaction", "a late participant loses points or appears in the round")})`, async () => {
    const channelId = `round-deadline-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 40);
    const joinResult = await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" }));
      await target.openGameRound(pointTestModule, "round-late", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await target.markGameRoundAnnounced(pointTestModule, "round-late", Date.now() - 1, "round:late");
      const result = await target.joinGameRound(pointTestModule, "round-late", "msg:late", "viewer-a", "nachtfalke", 10, {});
      await deferPointAlarmWithin(state);
      return result;
    });

    expect(joinResult).toEqual({ status: "round_closed" });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(40);
    await expect(object.pointHistory(pointTestModule, "viewer-a")).resolves.toMatchObject({ rows: [{ operationId: "bonus:viewer-a" }] });
  });

  it(`allows one join per account and replays the same message key (${testCard("a participant can stake once and exact event retries are idempotent", "duplicate joins withdraw a second stake")})`, async () => {
    const channelId = `round-join-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 40);
    await openAnnouncedRound(object, pointTestModule, "round-one", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);

    await expect(object.joinGameRound(pointTestModule, "round-one", "msg:join", "viewer-a", "pixelpilz", 10, {}))
      .resolves.toEqual({ status: "joined", replayed: false });
    await expect(object.joinGameRound(pointTestModule, "round-one", "msg:join", "viewer-a", "pixelpilz", 10, {}))
      .resolves.toEqual({ status: "joined", replayed: true });
    await expect(object.joinGameRound(pointTestModule, "round-one", "msg:join-again", "viewer-a", "pixelpilz", 10, {}))
      .resolves.toEqual({ status: "already_joined" });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(30);
    await expect(object.pointHistory(pointTestModule, "viewer-a")).resolves.toMatchObject({ rows: [
      { operationId: "msg:join", kind: "stake", delta: -10, balanceAfter: 30 },
      { operationId: "bonus:viewer-a", kind: "bonus" },
    ] });
  });

  it(`resolves a round once and ranks its net in the resolution month (${testCard("the round result and monthly net commit with one resolve operation", "retrying resolution pays the same winner twice or omits the net")})`, async () => {
    const channelId = `round-resolve-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 40);
    await openAnnouncedRound(object, pointTestModule, "round-resolve", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 15 }], result: { winner: "viewer-a" } } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-resolve", "msg:stake", "viewer-a", "nachtfalke", 10, {});

    const first = await object.resolveGameRound(pointTestModule, "round-resolve", {
      kind: "test",
      params: { payouts: [{ accountId: "viewer-a", amount: 15 }], result: { winner: "viewer-a" } },
    });
    const replay = await object.resolveGameRound(pointTestModule, "round-resolve", {
      kind: "test",
      params: { payouts: [{ accountId: "viewer-a", amount: 15 }], result: { winner: "viewer-a" } },
    });

    expect(first).toMatchObject({ replayed: false, result: { winner: "viewer-a" } });
    expect(replay).toMatchObject({ replayed: true, result: { winner: "viewer-a" } });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(45);
    await expect(object.pointRanking(pointTestModule, new Date().toISOString().slice(0, 7), 10)).resolves.toEqual([
      { accountId: "viewer-a", login: "nachtfalke", net: 5 },
    ]);
  });

  it(`refunds each open participant once when a module closes (${testCard("module shutdown returns every escrowed stake exactly once", "a participant is refunded twice or remains short")})`, async () => {
    const channelId = `round-refund-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 30);
    await object.touchPointAccount(pointTestModule, "viewer-b", "pixelpilz", 20);
    await openAnnouncedRound(object, pointTestModule, "round-refund", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-refund", "msg:stake-a", "viewer-a", "nachtfalke", 12, {});
    await object.joinGameRound(pointTestModule, "round-refund", "msg:stake-b", "viewer-b", "pixelpilz", 7, {});

    await object.setGameModuleGate(pointTestModule, true, 1);
    await expect(object.cancelOpenGameRounds(pointTestModule, 1)).resolves.toBe(1);
    await expect(object.cancelOpenGameRounds(pointTestModule, 1)).resolves.toBe(0);
    await expect(Promise.all([
      object.pointBalance(pointTestModule, "viewer-a"),
      object.pointBalance(pointTestModule, "viewer-b"),
    ])).resolves.toEqual([30, 20]);
    const [firstHistory, secondHistory] = await Promise.all([
      object.pointHistory(pointTestModule, "viewer-a"),
      object.pointHistory(pointTestModule, "viewer-b"),
    ]);
    expect(firstHistory.rows.filter((row) => row.kind === "refund")).toHaveLength(1);
    expect(secondHistory.rows.filter((row) => row.kind === "refund")).toHaveLength(1);
    await expect(object.pointRanking(pointTestModule, new Date().toISOString().slice(0, 7), 10)).resolves.toEqual([]);
  });

  it(`reconciles a committed D1 disable before settling an expired round (${testCard("the D1 activation revision cancels before alarm settlement", "the stale open gate settles the round")})`, async () => {
    const channelId = `round-d1-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-d1-disable", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-d1-disable", "msg:stake", "viewer-a", "nachtfalke", 5, {});
    await database.prepare("UPDATE channel_modules SET enabled = 0, revision = 2 WHERE channel_id = ? AND module_id = ?")
      .bind(channelId, pointTestModule).run();
    expect(await forcePointAlarm(object, "round-d1-disable", (_target, state) => {
      state.storage.sql.exec(
        "UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?",
        Date.now() - 60_000,
        "round-d1-disable",
      );
    })).toBe(true);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-d1-disable",
    ).one().state)).resolves.toBe("cancelled");
  });

  it(`refunds a disable missed before re-enable before opening a new round (${testCard("re-enable immediately refunds every round opened before last_disabled_revision", "an old stake remains debited until a later alarm")})`, async () => {
    const channelId = `round-missed-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await object.touchPointAccount(pointTestModule, "viewer-b", "pixelpilz", 20);
    await openAnnouncedRound(object, pointTestModule, "round-before-missed-disable", {
      durationS: 60,
      announceText: "The earlier round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-before-missed-disable", "msg:old-stake", "viewer-a", "nachtfalke", 5, {});
    await object.joinGameRound(pointTestModule, "round-before-missed-disable", "msg:other-old-stake", "viewer-b", "pixelpilz", 7, {});

    await database.prepare(
      "UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();
    await database.prepare(
      "UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();
    await object.setGameModuleGate(pointTestModule, false, 3, 2);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(object.pointBalance(pointTestModule, "viewer-b")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-before-missed-disable",
    ).one().state)).resolves.toBe("cancelled");
    await expect(object.joinGameRound(
      pointTestModule, "round-before-missed-disable", "msg:late-old-stake", "viewer-a", "nachtfalke", 5, {},
    )).resolves.toEqual({ status: "round_closed" });

    await openAnnouncedRound(object, pointTestModule, "round-after-missed-disable", {
      durationS: 60,
      announceText: "The newer round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 3 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-after-missed-disable", "msg:new-stake", "viewer-a", "nachtfalke", 3, {});

    await object.resolveGameRound(pointTestModule, "round-after-missed-disable", {
      kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 3 }] },
    });

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ round_id: string; state: string }>(
      "SELECT round_id, state FROM game_rounds WHERE round_id IN (?, ?) ORDER BY round_id",
      "round-after-missed-disable",
      "round-before-missed-disable",
    ).toArray())).resolves.toEqual([
      { round_id: "round-after-missed-disable", state: "resolved" },
      { round_id: "round-before-missed-disable", state: "cancelled" },
    ]);
  });

  it(`clears schedules for rounds cancelled during re-enable (${testCard("re-enable removes alarms for rounds it cancels and arms the earliest remaining schedule", "cancelled rounds leave stale points:round entries or a later platform alarm")})`, async () => {
    const channelId = `round-reenable-schedules-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    const cancelledDeadline = Date.now() + 60_000;
    const remainingDeadline = cancelledDeadline + 60_000;
    const cancelledAlarmKey = "points:round:round-before-reenable";
    const remainingAlarmKey = "points:round:round-still-scheduled";
    await openAnnouncedRound(object, pointTestModule, "round-before-reenable", {
      durationS: 60,
      announceText: "The earlier round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, cancelledDeadline);
    await runPointObject(object, async (_target, state) => {
      const table = state.storage.kv.get<Record<string, { deadline: number; handler: string; revision: number }>>(
        "channel:alarm_schedule",
      ) ?? {};
      table[remainingAlarmKey] = { deadline: remainingDeadline, handler: "host:points_round", revision: 1 };
      state.storage.kv.put("channel:alarm_schedule", table);
      await state.storage.setAlarm(cancelledDeadline);
    });

    await database.prepare(
      "UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();
    await database.prepare(
      "UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();
    await object.setGameModuleGate(pointTestModule, false, 3, 2);

    const state = await runPointObject(object, async (_target, objectState) => ({
      roundState: objectState.storage.sql.exec<{ state: string }>(
        "SELECT state FROM game_rounds WHERE round_id = ?", "round-before-reenable",
      ).one().state,
      table: objectState.storage.kv.get<Record<string, { deadline: number }>>("channel:alarm_schedule") ?? {},
      platformAlarm: await objectState.storage.getAlarm(),
    }));
    expect(state.roundState).toBe("cancelled");
    expect(state.table[cancelledAlarmKey]).toBeUndefined();
    expect(state.table[remainingAlarmKey]?.deadline).toBe(remainingDeadline);
    expect(state.platformAlarm).toBe(remainingDeadline);
  });

  it(`keeps recovery local for historical points state when D1 is unavailable (${testCard("history-only point storage does not block unrelated channel work at startup", "startup queries D1 despite having no active round or pending cancellation")})`, async () => {
    const channelId = `round-history-only-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 10);
    await openAnnouncedRound(object, pointTestModule, "round-history-only", {
      durationS: 60,
      announceText: "The historical round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 5 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-history-only", "msg:history-stake", "viewer-a", "nachtfalke", 5, {});
    await object.resolveGameRound(pointTestModule, "round-history-only", {
      kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 5 }] },
    });
    await runPointObject(object, async (target) => {
      const internals = target as unknown as { recordChatActivity(): Promise<number> };
      await expect(internals.recordChatActivity()).resolves.toBe(1);
    });

    const mutableEnv = env as unknown as { DB: D1Database };
    const originalDatabase = mutableEnv.DB;
    mutableEnv.DB = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    try {
      await evictDurableObject(object as unknown as DurableObjectStub);
      await runPointObject(object, async (target) => {
        const internals = target as unknown as { recordChatActivity(): Promise<number> };
        await expect(internals.recordChatActivity()).resolves.toBe(2);
      });
    } finally {
      mutableEnv.DB = originalDatabase;
    }
  });

  it(`schedules pending point reconciliation immediately without waiting for D1 (${testCard("active point work retries D1 reconciliation from a durable alarm", "startup blocks on D1 before unrelated channel work can run")})`, async () => {
    const channelId = `round-pending-recovery-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await openAnnouncedRound(object, pointTestModule, "round-pending-recovery", {
      durationS: 60,
      announceText: "The pending round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await runPointObject(object, async (target) => {
      const internals = target as unknown as { recordChatActivity(): Promise<number> };
      await expect(internals.recordChatActivity()).resolves.toBe(1);
    });

    const mutableEnv = env as unknown as { DB: D1Database };
    const originalDatabase = mutableEnv.DB;
    mutableEnv.DB = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    try {
      await evictDurableObject(object as unknown as DurableObjectStub);
      await runPointObject(object, async (target, state) => {
        const internals = target as unknown as { recordChatActivity(): Promise<number> };
        await expect(internals.recordChatActivity()).resolves.toBe(2);
        await expect(target.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(0);
        const alarmTable = state.storage.kv.get<Record<string, { deadline: number; handler: string }>>(
          "channel:alarm_schedule",
        ) ?? {};
        expect(alarmTable["points:activation_reconciliation"]).toMatchObject({
          handler: "host:points_activation_reconciliation",
        });
        expect(alarmTable["points:activation_reconciliation"]?.deadline).toBeLessThanOrEqual(Date.now());
      });
    } finally {
      mutableEnv.DB = originalDatabase;
    }
  });

  it(`reconciles a pending disable after a missed re-enable across eviction (${testCard("startup keeps cancellation intent until an immediate activation alarm reads D1", "local cancellation drains before re-enable revision 3 reaches the gate")})`, async () => {
    const channelId = `round-missed-reenable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-missed-reenable", {
      durationS: 60,
      announceText: "The older round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);

    await database.prepare(
      "UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();
    await runPointObject(object, async (_target, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE module_gates SET closed = 1, revision = 2 WHERE module_id = ?", pointTestModule);
      state.storage.sql.exec(
        "INSERT INTO game_round_cancellations (module_id, revision) VALUES (?, ?) ON CONFLICT(module_id) DO UPDATE SET revision = excluded.revision",
        pointTestModule,
        2,
      );
    });
    await database.prepare(
      "UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, pointTestModule).run();

    await evictDurableObject(object as unknown as DurableObjectStub);
    await runPointObject(object, async (target, state) => {
      await expect(target.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
      const internals = target as unknown as { recordChatActivity(): Promise<number> };
      await expect(internals.recordChatActivity()).resolves.toBe(1);
      const alarmTable = state.storage.kv.get<Record<string, { deadline: number; handler: string }>>(
        "channel:alarm_schedule",
      ) ?? {};
      expect(alarmTable["points:activation_reconciliation"]).toMatchObject({
        handler: "host:points_activation_reconciliation",
      });
      expect(alarmTable["points:activation_reconciliation"]?.deadline).toBeLessThanOrEqual(Date.now());
      await deferPointAlarmWithin(state);
    });
    expect(await runPointAlarm(object)).toBe(true);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await openAnnouncedRound(object, pointTestModule, "round-after-reenable", {
      durationS: 60,
      announceText: "The newer round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      revision: number;
      closed: number;
    }>("SELECT state, (SELECT revision FROM module_gates WHERE module_id = ?) AS revision, (SELECT closed FROM module_gates WHERE module_id = ?) AS closed FROM game_rounds WHERE round_id = ?",
    pointTestModule,
    pointTestModule,
    "round-missed-reenable").one())).resolves.toMatchObject({ state: "cancelled", revision: 3, closed: 0 });
  });

  it(`applies a delayed older disable only to rounds opened before it (${testCard("revision-scoped cancellation refunds older stakes while preserving newer rounds", "a stale disable is lost or refunds a round opened after re-enable")})`, async () => {
    const channelId = `round-stale-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 50);
    await openAnnouncedRound(object, pointTestModule, "round-before-disable", {
      durationS: 60,
      announceText: "The earlier round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-before-disable", "msg:old-stake", "viewer-a", "pixelpilz", 10, {});

    await database.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = ?")
      .bind(channelId, pointTestModule).run();
    await object.setGameModuleGate(pointTestModule, false, 3);
    await openAnnouncedRound(object, pointTestModule, "round-after-enable", {
      durationS: 60,
      announceText: "The later round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-after-enable", "msg:new-stake", "viewer-a", "pixelpilz", 5, {});

    await object.setGameModuleGate(pointTestModule, true, 2);
    await expect(object.cancelOpenGameRounds(pointTestModule, 2)).resolves.toBe(1);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(45);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ round_id: string; state: string }>(
      "SELECT round_id, state FROM game_rounds WHERE round_id IN (?, ?) ORDER BY round_id",
      "round-after-enable",
      "round-before-disable",
    ).toArray())).resolves.toEqual([
      { round_id: "round-after-enable", state: "open" },
      { round_id: "round-before-disable", state: "cancelled" },
    ]);
  });

  it(`rejects overlong round and account identifiers before accepting them (${testCard("bounded identifiers are enforced before ledger writes", "refund identifiers can exceed the operation key limit")})`, async () => {
    const channelId = `round-id-boundaries-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const validRound = "valid-round";
    const roundData = {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    };

    await expect(capturePointError(object, (target) => target.openGameRound(pointTestModule, "r".repeat(65), roundData)))
      .resolves.toBe("invalid_round_id");
    await object.openGameRound(pointTestModule, validRound, roundData);
    await object.markGameRoundAnnounced(pointTestModule, validRound, Date.now() + 60_000, `round:${validRound}`);

    await expect(capturePointError(object, (target) => target.joinGameRound(
      pointTestModule, validRound, "msg:invalid-account", "a".repeat(33), "nachtfalke", 1, {},
    ))).resolves.toBe("invalid_account_id");
    await expect(capturePointError(object, (target) => target.joinGameRound(
      pointTestModule, validRound, "msg:invalid-character", "viewer/invalid", "nachtfalke", 1, {},
    ))).resolves.toBe("invalid_account_id");

    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_rounds WHERE round_id = ?", "r".repeat(65),
    ).one().count)).resolves.toBe(0);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", validRound,
    ).one().count)).resolves.toBe(0);
  });

  it(`cancels and recovers a round at the maximum supported identifier lengths (${testCard("boundary-length identifiers remain cancellable after restart", "a valid maximum-length refund fails during startup recovery")})`, async () => {
    const channelId = `round-id-max-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    const roundId = "r".repeat(64);
    const accountId = "a".repeat(32);
    await object.setGameModuleGate(pointTestModule, false, 1);
    await object.touchPointAccount(pointTestModule, accountId, "pixelpilz", 20);
    await openAnnouncedRound(object, pointTestModule, roundId, {
      durationS: 60,
      announceText: "The boundary round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, roundId, "msg:boundary-stake", accountId, "pixelpilz", 7, {});
    await database.prepare(
      "UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = ?",
    )
      .bind(channelId, pointTestModule).run();
    await object.setGameModuleGate(pointTestModule, true, 2);

    await evictDurableObject(object as unknown as DurableObjectStub);
    await expect(object.pointBalance(pointTestModule, accountId)).resolves.toBe(20);
    await expect(object.pointHistory(pointTestModule, accountId)).resolves.toMatchObject({ rows: [
      { operationId: `round:${roundId}:refund:${accountId}`, kind: "refund", delta: 7 },
      { operationId: `msg:boundary-stake`, kind: "stake", delta: -7 },
      { operationId: `bonus:${accountId}`, kind: "bonus", delta: 20 },
    ] });
    expect(hostChatMock.send).not.toHaveBeenCalled();
  });

  it(`does not post an announcement after its round is cancelled and the module re-enabled (${testCard("the pre-post callback checks the persisted round attempt", "re-enabling the module revives an announcement for a cancelled round")})`, async () => {
    const channelId = `round-stale-announcement-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    const roundId = "round-cancel-before-post";
    const roundData = {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    };
    let targetRef!: PointsWorkerObject;
    const posted: string[] = [];
    hostChatMock.send.mockImplementation(async (...args) => {
      const [, , text, , , stillValid] = args;
      await database.prepare("UPDATE channel_modules SET enabled = 0, revision = 2 WHERE channel_id = ? AND module_id = ?")
        .bind(channelId, pointTestModule).run();
      await targetRef.setGameModuleGate(pointTestModule, true, 2);
      await targetRef.cancelOpenGameRounds(pointTestModule, 2);
      await database.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = ?")
        .bind(channelId, pointTestModule).run();
      await targetRef.setGameModuleGate(pointTestModule, false, 3);

      const valid = await (stillValid?.() ?? Promise.resolve(true));
      if (valid) posted.push(text);
      return {
        sent: valid,
        truncated: false,
        delivery: valid ? "sent" : "not_attempted",
        reason: valid ? null : "stale_before_send",
        detail: {},
      };
    });

    await runPointObject(object, async (target, state) => {
      targetRef = target;
      await target.setGameModuleGate(pointTestModule, false, 1);
      await target.openGameRound(pointTestModule, roundId, roundData);
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, roundId)).toBe(true);

    expect(posted).toEqual([]);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", roundId,
    ).one().state)).resolves.toBe("cancelled");
  });

  it(`persists and sends one host cancellation notice with the refund (${testCard("a disabled game refunds escrow and announces cancellation once", "a refund has no durable notice or a retry posts it twice")})`, async () => {
    const channelId = `round-cancellation-notice-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 0, '{}')",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    const sentTexts: string[] = [];
    hostChatMock.send.mockImplementation(async (...args: Parameters<typeof sendChatMessage>) => {
      const [, , text, , , stillValid, claimBeforePost, , afterPost] = args;
      expect(await (stillValid?.() ?? Promise.resolve(true))).toBe(true);
      expect(await (claimBeforePost?.() ?? Promise.resolve(true))).toBe(true);
      sentTexts.push(text);
      await afterPost?.("sent", null);
      return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
    });
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancellation-notice", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancellation-notice", "msg:stake", "viewer-a", "nachtfalke", 5, {});
    await object.setGameModuleGate(pointTestModule, true, 11);

    await expect(object.cancelOpenGameRounds(pointTestModule, 11)).resolves.toBe(1);
    await expect(object.cancelOpenGameRounds(pointTestModule, 11)).resolves.toBe(0);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    expect(sentTexts).toEqual(["Runde abgebrochen, Einsätze erstattet."]);
    expect(templateLanguageText.en.pointRoundCancelled).toBe("Round cancelled, stakes refunded.");
    expect(hostChatMock.send).toHaveBeenCalledOnce();
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{
      module_id: string;
      revision: number;
      completed_at: string | null;
    }>(
      "SELECT module_id, revision, completed_at FROM game_round_cancellation_notices WHERE module_id = ? AND revision = ?",
      pointTestModule,
      11,
    ).one())).resolves.toMatchObject({ module_id: pointTestModule, revision: 11 });
  });

  it(`keeps an overlapping cancellation notice pending until its alarm retry (${testCard("a notice stays pending during an overlapping send claim and after definite rejection, then delivers once", "an overlapping attempt completes an unresolved notice or loses the retry", "hostChatMock defers and rejects the first send and confirms one later mocked delivery")})`, async () => {
    const channelId = `round-cancellation-overlap-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const database = (env as unknown as { DB: D1Database }).DB;
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 0, '{}')",
    ).bind(channelId, pointTestModule).run();
    const object = pointObject(channelId);
    const claimedTexts: string[] = [];
    let confirmedDeliveries = 0;
    let signalFirstSendStarted!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => { signalFirstSendStarted = resolve; });
    let resolveFirstSend!: (result: ChatSendResult) => void;
    const firstSendOutcome = new Promise<ChatSendResult>((resolve) => { resolveFirstSend = resolve; });
    hostChatMock.send.mockImplementation(async (...args: Parameters<typeof sendChatMessage>) => {
      const [, , text, , , stillValid, claimBeforePost, , afterPost] = args;
      expect(await (stillValid?.() ?? Promise.resolve(true))).toBe(true);
      const claim = await (claimBeforePost?.() ?? Promise.resolve(true));
      if (claim !== true) {
        return {
          sent: false,
          truncated: false,
          delivery: "not_attempted",
          reason: claim === "rate_limited" ? "rate_limited" : "already_attempted",
          detail: {},
        };
      }
      claimedTexts.push(text);
      if (claimedTexts.length === 1) {
        signalFirstSendStarted();
        const result = await firstSendOutcome;
        await afterPost?.(result.delivery, result.reason);
        return result;
      }
      confirmedDeliveries += 1;
      await afterPost?.("sent", null);
      return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
    });
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancellation-overlap", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancellation-overlap", "msg:stake", "viewer-a", "nachtfalke", 5, {});
    await object.setGameModuleGate(pointTestModule, true, 13);

    await runPointObject(object, async (target, state) => {
      let firstAttemptOutcome: Promise<
        | { status: "fulfilled"; value: number }
        | { status: "rejected"; error: unknown }
      > | null = null;
      let firstAttemptResult:
        | { status: "fulfilled"; value: number }
        | { status: "rejected"; error: unknown }
        | undefined;
      try {
        const firstAttempt = target.cancelOpenGameRounds(pointTestModule, 13);
        firstAttemptOutcome = firstAttempt.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        await firstSendStarted;
        await expect(target.cancelOpenGameRounds(pointTestModule, 13)).resolves.toBe(0);
        const completedWhileSending = state.storage.sql.exec<{
          completed_at: string | null;
        }>(
          "SELECT completed_at FROM game_round_cancellation_notices WHERE module_id = ? AND revision = ?",
          pointTestModule,
          13,
        ).one();
        expect(completedWhileSending.completed_at).toBeNull();
      } finally {
        resolveFirstSend({ sent: false, truncated: false, delivery: "rejected", reason: "rate_limited", detail: {} });
        if (firstAttemptOutcome !== null) firstAttemptResult = await firstAttemptOutcome;
      }
      expect(firstAttemptResult).toEqual({ status: "fulfilled", value: 1 });
      const completedAfterRejection = state.storage.sql.exec<{
        completed_at: string | null;
      }>("SELECT completed_at FROM game_round_cancellation_notices WHERE module_id = ? AND revision = ?", pointTestModule, 13).one();
      expect(completedAfterRejection.completed_at).toBeNull();
    });

    await runPointObject(object, async (_target, state) => {
      await state.storage.delete(AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY);
      await schedulePointCancellationNoticeAlarmWithin(state, pointTestModule, 13);
    });
    expect(await runPointAlarm(object)).toBe(true);

    const completedAfterRetry = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      completed_at: string | null;
    }>("SELECT completed_at FROM game_round_cancellation_notices WHERE module_id = ? AND revision = ?", pointTestModule, 13).one());
    expect(completedAfterRetry.completed_at).not.toBeNull();
    expect(claimedTexts).toHaveLength(2);
    expect(confirmedDeliveries).toBe(1);
  });

  it(`rolls back a stake refund when its cancellation notice cannot be persisted (${testCard("refund and cancellation notice share one transaction", "a stake is returned without leaving a cancellation notice")})`, async () => {
    const channelId = `round-cancellation-notice-atomic-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancellation-notice-atomic", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancellation-notice-atomic", "msg:stake", "viewer-a", "nachtfalke", 5, {});
    await object.setGameModuleGate(pointTestModule, true, 12);

    await runPointObject(object, (_target, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS game_round_cancellation_notices (
          module_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          PRIMARY KEY (module_id, revision)
        )
      `);
      state.storage.sql.exec(`CREATE TRIGGER reject_cancellation_notice
          BEFORE INSERT ON game_round_cancellation_notices
          BEGIN SELECT RAISE(ABORT, 'simulated_notice_storage_failure'); END`);
    });

    await expect(capturePointError(object, (target) => target.cancelOpenGameRounds(pointTestModule, 12)))
      .resolves.toContain("simulated_notice_storage_failure");
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(15);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-cancellation-notice-atomic",
    ).one().state)).resolves.toBe("open");
  });

  it(`closes a gate before cancelling and reopens only for a newer revision (${testCard("gate revision order blocks new game operations and round starts", "a stale activation reopens a newer disabled module")})`, async () => {
    const channelId = `round-gate-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 20);
    await expect(object.setGameModuleGate(pointTestModule, true, 4)).resolves.toEqual({ applied: true });
    await expect(object.setGameModuleGate(pointTestModule, false, 3)).resolves.toEqual({ applied: false });
    await expect(capturePointError(object, (target) => target.openGameRound(pointTestModule, "round-closed", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }))).resolves.toBe("module_closed");
    await expect(capturePointError(object, (target) => target.applyPointOperation(pointTestModule, "msg:closed", "game", [
      { accountId: "viewer-a", delta: -1 }, { accountId: "__house", delta: 1 },
    ], {}))).resolves.toBe("module_closed");
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(object.setGameModuleGate(pointTestModule, false, 5)).resolves.toEqual({ applied: true });
    await openAnnouncedRound(object, pointTestModule, "round-open", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
  });

  it(`refunds a pending cancellation before a newer activation clears its intent (${testCard("re-enabling commits outstanding refunds before clearing cancellation intent", "re-enabling strands an escrowed stake or permits settlement")})`, async () => {
    const channelId = `round-reenable-refund-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-reenable-refund", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 50 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-reenable-refund", "msg:stake", "viewer-a", "nachtfalke", 5, {});

    await expect(object.setGameModuleGate(pointTestModule, true, 1)).resolves.toEqual({ applied: true });
    await expect(object.setGameModuleGate(pointTestModule, false, 2)).resolves.toEqual({ applied: true });

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-reenable-refund",
    ).one().state)).resolves.toBe("cancelled");
    await expect(capturePointError(object, (target) => target.resolveGameRound(pointTestModule, "round-reenable-refund", {
      kind: "test",
      params: { payouts: [{ accountId: "viewer-a", amount: 50 }] },
    }))).resolves.toBe("round_closed");
  });

  it(`retries points recovery after the first initialization attempt fails (${testCard("a later points access retries rejected lazy recovery after eviction", "a transient recovery failure leaves points initialization permanently incomplete", "recovery is fault-injected once on an evicted Durable Object")})`, async () => {
    const channelId = `round-recovery-retry-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.pointBalance(pointTestModule, "viewer-a");
    await openAnnouncedRound(object, pointTestModule, "round-recovery-retry", {
      durationS: 60,
      announceText: "The retry round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await evictDurableObject(object as unknown as DurableObjectStub);

    await runPointObject(object, async (target) => {
      const internals = target as unknown as { recoverPointRoundAlarms(): Promise<void> };
      const recover = internals.recoverPointRoundAlarms.bind(target);
      let attempts = 0;
      Object.assign(target, {
        recoverPointRoundAlarms: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated_recovery_failure");
          await recover();
        },
      });

      let firstError: string | null = null;
      try {
        await target.pointBalance(pointTestModule, "viewer-a");
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toBe("simulated_recovery_failure");
      await expect(target.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(0);
      expect(attempts).toBe(2);
    });
  });

  it(`shares one points recovery across concurrent first accesses after eviction (${testCard("concurrent points accesses share one lazy recovery promise", "both first accesses independently run recovery after eviction", "recovery waits on a test-controlled promise before calling the real recovery method")})`, async () => {
    const channelId = `round-recovery-concurrent-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.pointBalance(pointTestModule, "viewer-a");
    await openAnnouncedRound(object, pointTestModule, "round-recovery-concurrent", {
      durationS: 60,
      announceText: "The concurrent round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await evictDurableObject(object as unknown as DurableObjectStub);

    await runPointObject(object, async (target) => {
      const internals = target as unknown as { recoverPointRoundAlarms(): Promise<void> };
      const recover = internals.recoverPointRoundAlarms.bind(target);
      let attempts = 0;
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      Object.assign(target, {
        recoverPointRoundAlarms: async () => {
          attempts += 1;
          await recoveryGate;
          await recover();
        },
      });

      const balanceAccess = target.pointBalance(pointTestModule, "viewer-a");
      const summaryAccess = target.pointSummary(pointTestModule);
      const attemptsBeforeRecoveryFinishes = attempts;
      releaseRecovery();
      await expect(balanceAccess).resolves.toBe(0);
      await expect(summaryAccess).resolves.toMatchObject({ circulation: 0 });
      expect(attemptsBeforeRecoveryFinishes).toBe(1);
      expect(attempts).toBe(1);
    });
  });

  it(`restores a lost round schedule and platform alarm after an unrelated request wakes the object (${testCard("an unrelated request after eviction restores a deleted schedule entry and alarm", "a round stays open after both persisted alarm records are removed")})`, async () => {
    const channelId = `round-recovery-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    vi.useFakeTimers();
    const deadlineAt = Date.now() + 5_000;
    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" }));
      await target.openGameRound(pointTestModule, "round-recovery", {
      durationS: 1,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 5 }], result: { recovered: true } } },
      });
      await target.markGameRoundAnnounced(pointTestModule, "round-recovery", Date.now() + 500, "round:recovery");
      await target.joinGameRound(pointTestModule, "round-recovery", "msg:stake", "viewer-a", "nachtfalke", 5, {});
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", deadlineAt, "round-recovery");
      const alarmTable = state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule") ?? {};
      expect(alarmTable["points:round:round-recovery"]).toBeDefined();
      Reflect.deleteProperty(alarmTable, "points:round:round-recovery");
      state.storage.kv.put("channel:alarm_schedule", alarmTable);
    });
    await evictDurableObject(object as unknown as DurableObjectStub);
    await runPointObject(object, async (target, state) => {
      await target.getPanelResourceRevisions();
      const alarmTable = state.storage.kv.get<Record<string, { deadline: number; handler: string }>>(
        "channel:alarm_schedule",
      ) ?? {};
      expect(alarmTable["points:round:round-recovery"]).toEqual({
        deadline: deadlineAt,
        handler: "host:points_round",
        revision: 1,
      });
      const platformAlarmAt = await state.storage.getAlarm();
      expect(platformAlarmAt).not.toBeNull();
      expect(platformAlarmAt).toBeLessThanOrEqual(deadlineAt);
      // Keep the platform from auto-delivering while this test advances its clock;
      // runDurableObjectAlarm below explicitly drives the restored persisted schedule.
      await state.storage.setAlarm(deadlineAt + 60_000);
    });
    vi.setSystemTime(deadlineAt + 1);
    expect(await runPointAlarm(object)).toBe(true);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-recovery",
    ).one().state)).resolves.toBe("resolved");
    await expect(object.pointRanking(pointTestModule, new Date().toISOString().slice(0, 7), 10)).resolves.toEqual([
      { accountId: "viewer-a", login: "nachtfalke", net: 0 },
    ]);
  });

  it(`keeps dry-run snapshot RPCs from recovering a missing point alarm (${testCard("read-only dry-run snapshots do not write recovered round schedules or platform alarms", "a dry-run snapshot mutates local point recovery state", "the test invokes the same read-only RPCs used by dry-run before inspecting persisted SQLite and alarm state")})`, async () => {
    const channelId = `round-dry-run-snapshot-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    const roundId = "round-dry-run-snapshot";
    await openAnnouncedRound(object, pointTestModule, roundId, {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, roundId, "msg:dry-run-stake", "viewer-a", "nachtfalke", 5, {});
    await runPointObject(object, async (_target, state) => {
      await state.storage.deleteAlarm();
      const table = state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule") ?? {};
      Reflect.deleteProperty(table, `points:round:${roundId}`);
      state.storage.kv.put("channel:alarm_schedule", table);
    });
    await evictDurableObject(object as unknown as DurableObjectStub);

    await Promise.all([
      object.readBallotSnapshot("chat_voting", "missing-poll"),
      object.readBallotDryRunSnapshot("chat_voting", "missing-poll", "viewer-a"),
      object.hasOpenBallotSnapshot(),
      object.getActiveChatterSnapshot("viewer-a"),
      object.getActiveChatterCountSnapshot(60_000),
    ]);

    await runPointObject(object, async (_target, state) => {
      const table = state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule") ?? {};
      expect(table[`points:round:${roundId}`]).toBeUndefined();
      await expect(state.storage.getAlarm()).resolves.toBeNull();
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM game_rounds WHERE round_id = ?", roundId,
      ).one().state).toBe("open");
    });
  });

  it(`cancels a round when disabling its gate and rejects the next join (${testCard("closeGate precedes the join transaction and refunds existing stakes", "a post-close join books or an existing stake remains in escrow")})`, async () => {
    const channelId = `round-close-race-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 25);
    await openAnnouncedRound(object, pointTestModule, "round-close-race", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-close-race", "msg:stake", "viewer-a", "nachtfalke", 8, {});
    await object.setGameModuleGate(pointTestModule, true, 8);

    await expect(capturePointError(object, (target) => target.joinGameRound(pointTestModule, "round-close-race", "msg:late", "viewer-a", "nachtfalke", 8, {})))
      .resolves.toBe("module_closed");
    await expect(object.cancelOpenGameRounds(pointTestModule, 8)).resolves.toBe(1);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(25);
  });

  it(`does not cancel a newer activation for a stale disable revision (${testCard("cancellation checks the closed gate revision inside its transaction", "an old disable refunds a round opened after a newer enable")})`, async () => {
    const channelId = `round-stale-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 25);
    await expect(object.setGameModuleGate(pointTestModule, false, 3)).resolves.toEqual({ applied: true });
    await openAnnouncedRound(object, pointTestModule, "round-new-activation", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-new-activation", "msg:stake", "viewer-a", "nachtfalke", 8, {});

    await expect(object.setGameModuleGate(pointTestModule, true, 2)).resolves.toEqual({ applied: false });
    await expect(object.cancelOpenGameRounds(pointTestModule, 2)).resolves.toBe(0);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(17);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-new-activation",
    ).one().state)).resolves.toBe("open");
  });

  it(`recovers a gate-close cancellation after the route crashes before its refund RPC (${testCard("the close intent blocks settlement and startup recovery refunds escrow", "a crashed disable settles or strands an open stake")})`, async () => {
    const channelId = `round-cancel-recovery-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancel-recovery", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 99 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancel-recovery", "msg:stake", "viewer-a", "pixelpilz", 10, {});

    await expect(object.setGameModuleGate(pointTestModule, true, 8)).resolves.toEqual({ applied: true });
    await expect(capturePointError(object, (target) => target.resolveGameRound(pointTestModule, "round-cancel-recovery", {
      kind: "test",
      params: { payouts: [{ accountId: "viewer-a", amount: 99 }] },
    }))).resolves.toBe("round_cancellation_pending");
    await evictDurableObject(object as unknown as DurableObjectStub);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-cancel-recovery",
    ).one().state)).resolves.toBe("cancelled");
    const history = await object.pointHistory(pointTestModule, "viewer-a");
    expect(history.rows.some((row) => row.kind === "refund" && row.delta === 10)).toBe(true);
  });

  it(`defers cancellation notices to the alarm after lazy recovery (${testCard("the first points access refunds and schedules without calling the chat sender", "point recovery waits for external cancellation notice delivery", "hostChatMock supplies a confirmed send; points recovery itself is asserted to make no transport call")})`, async () => {
    const channelId = `round-cancel-startup-notice-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sentTexts: string[] = [];
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancel-startup-notice", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancel-startup-notice", "msg:stake", "viewer-a", "nachtfalke", 5, {});
    await object.setGameModuleGate(pointTestModule, true, 14);
    await evictDurableObject(object as unknown as DurableObjectStub);
    await runPointObject(object, async (target, state) => {
      await expect(target.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
      await deferPointAlarmWithin(state);
    });
    hostChatMock.send.mockImplementation(async (...args: Parameters<typeof sendChatMessage>) => {
      const [, , text, , , stillValid, claimBeforePost, , afterPost] = args;
      expect(await (stillValid?.() ?? Promise.resolve(true))).toBe(true);
      expect(await (claimBeforePost?.() ?? Promise.resolve(true))).toBe(true);
      sentTexts.push(text);
      await afterPost?.("sent", null);
      return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
    });

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    expect(hostChatMock.send).not.toHaveBeenCalled();
    const pendingNotice = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      completed_at: string | null;
    }>(
      `SELECT game_rounds.state, game_round_cancellation_notices.completed_at
       FROM game_rounds JOIN game_round_cancellation_notices
         ON game_round_cancellation_notices.module_id = game_rounds.module_id
       WHERE game_rounds.round_id = ? AND game_round_cancellation_notices.revision = ?`,
      "round-cancel-startup-notice",
      14,
    ).one());
    expect(pendingNotice).toEqual({ state: "cancelled", completed_at: null });

    expect(await runPointAlarm(object)).toBe(true);

    expect(sentTexts).toHaveLength(1);
    expect(hostChatMock.send).toHaveBeenCalledOnce();
  });

  it(`refunds a pending cancellation when a round alarm runs before the route refund RPC (${testCard("round alarms recover the pending cancellation before resolving", "an expired round settles after its gate closes")})`, async () => {
    const channelId = `round-cancel-alarm-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 20);
    await openAnnouncedRound(object, pointTestModule, "round-cancel-alarm", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 99 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-cancel-alarm", "msg:stake", "viewer-a", "pixelpilz", 10, {});
    await object.setGameModuleGate(pointTestModule, true, 8);

    expect(await forcePointAlarm(object, "round-cancel-alarm", (_target, state) => {
      state.storage.sql.exec(
        "UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?",
        Date.now() - 60_000,
        "round-cancel-alarm",
      );
    })).toBe(true);

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-cancel-alarm",
    ).one().state)).resolves.toBe("cancelled");
  });

  it(`cancels a start line after six definite rate limits (${testCard("the announcing state retries six times and reaches cancelled", "a seventh line is sent or the round remains accepting", "the alarm transport mock supplies definite rate-limit responses")})`, async () => {
    const channelId = `round-rate-limit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" as const }));

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 10);
      await target.openGameRound(pointTestModule, "round-rate-limit", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });

    let round = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_attempts: number;
    }>("SELECT state, announce_attempts FROM game_rounds WHERE round_id = ?", "round-rate-limit").one());
    while (round.state !== "cancelled" && round.announce_attempts < 6) {
      expect(await forcePointAlarm(object, "round-rate-limit")).toBe(true);
      round = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
        state: string;
        announce_attempts: number;
      }>("SELECT state, announce_attempts FROM game_rounds WHERE round_id = ?", "round-rate-limit").one());
    }
    expect(round).toEqual({ state: "cancelled", announce_attempts: 6 });

    expect(sendChat).toHaveBeenCalledTimes(6);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(10);
  });

  it(`treats an ambiguous response without is_sent as delivered (${testCard("an HTTP-success ambiguity opens the round without a second announcement", "a potentially delivered start line cancels the round")})`, async () => {
    const channelId = `round-ambiguous-http-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => Promise.resolve({
      sent: false,
      retryable: false,
      reason: "not_sent",
      delivery: "ambiguous" as const,
    }));

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, "round-ambiguous-http", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, "round-ambiguous-http")).toBe(true);

    const recovered = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_state: string;
      deadline_at: number | null;
    }>("SELECT state, announce_state, deadline_at FROM game_rounds WHERE round_id = ?", "round-ambiguous-http").one());
    expect(recovered.state).toBe("open");
    expect(recovered.announce_state).toBe("ambiguous");
    expect(recovered.deadline_at).not.toBeNull();
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it(`preserves an HTTP-success ambiguity through the module alarm context (${testCard("module alarm context preserves ambiguous delivery outcomes", "a potentially delivered response is converted into a definite send failure", "sendChatImpl is a mocked transport response; no real chat delivery is claimed")})`, async () => {
    const channelId = `round-context-ambiguous-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChatImpl: typeof sendChatMessage = () => Promise.resolve({
      sent: false,
      truncated: false,
      delivery: "ambiguous",
      reason: "not_sent",
      detail: {},
    });

    const delivery = await runPointObject(object, async (target) => {
      const internal = target as unknown as {
        moduleAlarmContext: (
          moduleId: string,
          registration: ModuleAlarmDefinition,
          budget: ModuleExternalFetchBudget,
          streamGeneration?: number,
          identity?: ModuleAlarmContext["alarmIdentity"],
          planSequence?: number,
          sendChatImpl?: typeof sendChatMessage,
        ) => ModuleAlarmContext;
      };
      const registration = {
        key: "points_announce",
        handle: () => Promise.resolve(),
      } satisfies ModuleAlarmDefinition;
      const context = internal.moduleAlarmContext(
        pointTestModule,
        registration,
        { claim: () => true } satisfies ModuleExternalFetchBudget,
        undefined,
        undefined,
        undefined,
        sendChatImpl,
      );
      return await context.sendChat("The round starts", "round:ambiguous:announce");
    });

    expect(delivery.delivery).toBe("ambiguous");
    expect(delivery.reason).toBe("not_sent");
  });

  it.each(["pause", "mute"] as const)(
    `treats a late %s suppression as a definite announcement failure (${testCard("a control activated between pre-send validations prevents the send claim and POST", "the unannounced round opens as ambiguous", "the injected sender exercises both validation callbacks without making a network request")})`,
    async (control) => {
      const channelId = `round-late-${control}-${crypto.randomUUID()}`;
      const roundId = `round-late-${control}`;
      const database = (env as unknown as { DB: D1Database }).DB;
      await insertPointChannel(channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, '{}', 1)",
      ).bind(channelId, pointTestModule).run();
      await database.prepare(
        "INSERT INTO channel_controls (channel_id, updated_at) VALUES (?, ?)",
      ).bind(channelId, new Date().toISOString()).run();
      const object = pointObject(channelId);
      let firstValidationAccepted: boolean | null = null;
      let sendClaimResult: boolean | "rate_limited" | null = null;
      let postCount = 0;
      const sendChatImpl: typeof sendChatMessage = async (...args) => {
        const validateOutput = args[5];
        const claimBeforePost = args[6];
        if (validateOutput === undefined || claimBeforePost === undefined) {
          throw new Error("The module announcement did not provide its pre-send checks.");
        }

        firstValidationAccepted = await validateOutput();
        const column = control === "pause" ? "paused" : "muted";
        await database.prepare(`UPDATE channel_controls SET ${column} = 1, updated_at = ? WHERE channel_id = ?`)
          .bind(new Date().toISOString(), channelId).run();

        sendClaimResult = await claimBeforePost();
        if (sendClaimResult === true) {
          postCount += 1;
          return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
        }
        return {
          sent: false,
          truncated: false,
          delivery: "not_attempted",
          reason: sendClaimResult === "rate_limited" ? "rate_limited" : "already_attempted",
          detail: {},
        };
      };

      await runPointObject(object, async (target, state) => {
        const internal = target as unknown as {
          moduleAlarmContext: (
            moduleId: string,
            registration: ModuleAlarmDefinition,
            budget: ModuleExternalFetchBudget,
            streamGeneration?: number,
            identity?: ModuleAlarmContext["alarmIdentity"],
            planSequence?: number,
            sender?: typeof sendChatMessage,
          ) => ModuleAlarmContext;
        };
        const createModuleAlarmContext = internal.moduleAlarmContext.bind(target);
        Object.assign(target, {
          moduleAlarmContext: (
            moduleId: string,
            registration: ModuleAlarmDefinition,
            budget: ModuleExternalFetchBudget,
            streamGeneration?: number,
            identity?: ModuleAlarmContext["alarmIdentity"],
            planSequence?: number,
          ) => createModuleAlarmContext(
            moduleId,
            registration,
            budget,
            streamGeneration,
            identity,
            planSequence,
            sendChatImpl,
          ),
        });
        await target.openGameRound(pointTestModule, roundId, {
          durationS: 60,
          announceText: "The round starts",
          settlement: { kind: "test", params: { payouts: [] } },
        });
        await deferPointAlarmWithin(state);
      });

      expect(await forcePointAlarm(object, roundId)).toBe(true);
      expect(firstValidationAccepted).toBe(true);
      expect(sendClaimResult).toBe(false);
      expect(postCount).toBe(0);

      const round = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
        state: string;
        announce_state: string;
        deadline_at: number | null;
      }>("SELECT state, announce_state, deadline_at FROM game_rounds WHERE round_id = ?", roundId).one());
      expect(round).toEqual({ state: "cancelled", announce_state: "failed", deadline_at: null });
      const claims = await runPointObject(object, (_target, state) =>
        state.storage.get<Record<string, unknown>>("module_alarm:send_claims"));
      expect(claims?.[`round:${roundId}:announce`]).toBeUndefined();
    },
  );

  it(`timestamps a point announcement after a slower alarm handler in the same invocation (${testCard("each announcement uses its own attempt timestamp", "a slow earlier handler consumes the round duration")})`, async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const channelId = `round-fresh-attempt-time-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const attemptedAt = startedAt + 20_000;
    const sendChat = vi.fn(() => Promise.resolve({
      sent: false,
      retryable: false,
      reason: "network_error",
      delivery: "ambiguous" as const,
    }));

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      Object.assign(target, {
        expireActiveChatters: () => { vi.setSystemTime(attemptedAt); return Promise.resolve(); },
      });
      await target.openGameRound(pointTestModule, "round-fresh-attempt-time", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await state.storage.deleteAlarm();
      state.storage.kv.put("channel:alarm_schedule", {
        "channel:active_chatters_expiry": { deadline: startedAt - 1, handler: "channel.active_chatters_expiry", revision: 1 },
        "points:round:round-fresh-attempt-time": { deadline: startedAt, handler: "host:points_round", revision: 1 },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await runPointAlarm(object)).toBe(true);

    const attempt = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_state: string;
      last_attempt_at: number | null;
      deadline_at: number | null;
    }>("SELECT state, announce_state, last_attempt_at, deadline_at FROM game_rounds WHERE round_id = ?", "round-fresh-attempt-time").one());
    expect(attempt).toEqual({
      state: "open",
      announce_state: "ambiguous",
      last_attempt_at: attemptedAt,
      deadline_at: attemptedAt + 60_000,
    });
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it(`starts the round deadline after a delayed confirmed announcement (${testCard("confirmed delivery starts the configured round duration", "send latency consumes the round duration")})`, async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const channelId = `round-delayed-delivery-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => {
      vi.setSystemTime(startedAt + 4_000);
      return Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" as const });
    });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, "round-delayed-delivery", {
        durationS: 1,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, "round-delayed-delivery")).toBe(true);

    const round = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      last_attempt_at: number | null;
      deadline_at: number | null;
    }>("SELECT state, last_attempt_at, deadline_at FROM game_rounds WHERE round_id = ?", "round-delayed-delivery").one());
    expect(round).toEqual({ state: "open", last_attempt_at: startedAt, deadline_at: startedAt + 5_000 });
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it(`schedules a delayed rate-limit retry from the rejection time (${testCard("a definite rate limit waits five seconds after the response", "send latency consumes the retry delay")})`, async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const channelId = `round-delayed-rate-limit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => {
      vi.setSystemTime(startedAt + 4_000);
      return Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" as const });
    });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, "round-delayed-rate-limit", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, "round-delayed-rate-limit")).toBe(true);
    const alarm = await runPointObject(object, (_target, state) => state.storage.kv.get<Record<string, { deadline: number }>>(
      "channel:alarm_schedule",
    )?.["points:round:round-delayed-rate-limit"]);
    expect(alarm?.deadline).toBe(startedAt + 9_000);

    expect(sendChat).toHaveBeenCalledOnce();
  });

  it(`reconciles a later platform alarm on first points access after eviction (${testCard("the first points access replaces the platform alarm with the earliest stored schedule", "eviction leaves an immediately due announcement behind a later alarm")})`, async () => {
    const channelId = `round-earliest-alarm-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const laterAlarmAt = Date.now() + 60 * 60_000;

    await runPointObject(object, async (target, state) => {
      await target.openGameRound(pointTestModule, "round-earliest-alarm", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      const table = state.storage.kv.get<Record<string, { deadline: number; handler: string; revision: number }>>(
        "channel:alarm_schedule",
      ) ?? {};
      const alarmKey = "points:round:round-earliest-alarm";
      expect(table[alarmKey]).toBeDefined();
      await state.storage.setAlarm(laterAlarmAt);
    });

    await evictDurableObject(object as unknown as DurableObjectStub);
    await runPointObject(object, async (target, state) => {
      await target.pointBalance(pointTestModule, "viewer-a");
      const reconciledAlarmAt = await state.storage.getAlarm();
      expect(reconciledAlarmAt).not.toBeNull();
      expect(reconciledAlarmAt).toBeLessThan(laterAlarmAt);
    });
  });

  it(`treats a persisted attempt older than thirty seconds as delivered without resending (${testCard("the next alarm opens an ambiguous announcement from its recorded attempt time", "a lost send acknowledgement emits a duplicate start line", "a manually constructed persisted attempt row models the post-before-state-update crash and the mocked sender claims no real chat delivery")})`, async () => {
    const channelId = `round-ambiguous-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, delivery: "delivered" as const }));
    const attemptedAt = Date.now();
    const roundId = "round-ambiguous";
    const alarmKey = `points:round:${roundId}`;
    let recordAnnouncement!: (...args: unknown[]) => Promise<void>;

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 10);
      const internal = target as unknown as { recordPointRoundAnnouncement: (...args: unknown[]) => Promise<void> };
      recordAnnouncement = internal.recordPointRoundAnnouncement;
      Object.assign(target, {
        recordPointRoundAnnouncement: () => Promise.reject(new Error("simulated_crash_after_send")),
      });
      await state.storage.deleteAlarm();
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `INSERT INTO game_rounds
            (round_id, module_id, state, deadline_at, alarm_key, data_json, created_at, duration_s,
             announce_text, announce_state, announce_attempts, last_attempt_at)
           VALUES (?, ?, 'announcing', NULL, ?, ?, ?, 60, ?, 'pending', 0, NULL)`,
          roundId,
          pointTestModule,
          alarmKey,
          JSON.stringify({ settlement: { kind: "test", params: { payouts: [] } } }),
          new Date(attemptedAt).toISOString(),
          "The round starts",
        );
      });
      state.storage.kv.put("channel:alarm_schedule", {
        [alarmKey]: { deadline: Date.now(), handler: "host:points_round", revision: 1 },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, roundId)).toBe(true);
    expect(sendChat).toHaveBeenCalledOnce();

    let attemptAt = 0;
    expect(await forcePointAlarm(object, roundId, (target, state) => {
      Object.assign(target, { recordPointRoundAnnouncement: recordAnnouncement });
      attemptAt = Date.now() - 31_000;
      state.storage.sql.exec("UPDATE game_rounds SET last_attempt_at = ? WHERE round_id = ?", attemptAt, roundId);
    })).toBe(true);
    const recovered = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_state: string;
      announce_attempts: number;
      deadline_at: number | null;
    }>("SELECT state, announce_state, announce_attempts, deadline_at FROM game_rounds WHERE round_id = ?", roundId).one());
    expect(recovered).toEqual({
      state: "open",
      announce_state: "ambiguous",
      announce_attempts: 1,
      deadline_at: attemptAt + 60_000,
    });

    expect(sendChat).toHaveBeenCalledOnce();
  });

  it(`treats a crash on the sixth send as ambiguous after five rate limits (${testCard("the sixth claimed send stays pending and opens without a duplicate POST", "the sixth accepted line is marked failed after a crash", "sendChat is a mocked transport supplying five rate limits then one accepted response; no real delivery is claimed")})`, async () => {
    const channelId = `round-sixth-crash-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    let attempts = 0;
    const sendChat = vi.fn(() => {
      attempts += 1;
      return Promise.resolve(attempts <= 5
        ? { sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" as const }
        : { sent: true, retryable: false, reason: null, delivery: "delivered" as const });
    });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, "round-sixth-crash", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await forcePointAlarm(object, "round-sixth-crash")).toBe(true);
      expect(sendChat).toHaveBeenCalledTimes(attempt + 1);
    }
    let recordAnnouncement!: (...args: unknown[]) => Promise<void>;
    await runPointObject(object, (target) => {
      const internal = target as unknown as { recordPointRoundAnnouncement: (...args: unknown[]) => Promise<void> };
      recordAnnouncement = internal.recordPointRoundAnnouncement;
      Object.assign(target, {
        recordPointRoundAnnouncement: (roundId: string, stateName: string, at: number) =>
          stateName === "delivered" ? Promise.reject(new Error("simulated_crash_after_sixth_send"))
            : recordAnnouncement.call(target, roundId, stateName, at),
      });
    });
    expect(await forcePointAlarm(object, "round-sixth-crash")).toBe(true);
    let currentAttempt: number | null = null;
    let ambiguousAt = 0;
    expect(await forcePointAlarm(object, "round-sixth-crash", (target, state) => {
      Object.assign(target, { recordPointRoundAnnouncement: recordAnnouncement });
      expect(sendChat).toHaveBeenCalledTimes(6);

      currentAttempt = state.storage.sql.exec<{ last_attempt_at: number }>(
        "SELECT last_attempt_at FROM game_rounds WHERE round_id = ?", "round-sixth-crash",
      ).one().last_attempt_at;
      ambiguousAt = Date.now() - 31_000;
      state.storage.sql.exec(
        "UPDATE game_rounds SET last_attempt_at = ? WHERE round_id = ?",
        ambiguousAt,
        "round-sixth-crash",
      );
    })).toBe(true);
    const recovered = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_state: string;
      announce_attempts: number;
      deadline_at: number | null;
    }>("SELECT state, announce_state, announce_attempts, deadline_at FROM game_rounds WHERE round_id = ?", "round-sixth-crash").one());
    expect(recovered).toEqual({
      state: "open",
      announce_state: "ambiguous",
      announce_attempts: 6,
      deadline_at: ambiguousAt + 60_000,
    });
    expect(currentAttempt).toBeGreaterThan(0);

    expect(sendChat).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["missing", {}],
    ["unregistered", { settlement: { kind: "fictional", params: {} } }],
  ] as const)(`rejects a %s settlement before opening a round (${testCard("round creation rejects missing or unregistered settlement definitions", "invalid settlement input persists an active round", "only missing and fictional unregistered settlement configurations are covered")})`, async (_kind, settlementFields) => {
    const channelId = `round-settlement-validation-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const error = await capturePointError(object, (target) => target.openGameRound(pointTestModule, "round-no-settlement", {
      durationS: 60,
      announceText: "The round starts",
      ...settlementFields,
    }));

    expect(error).toBe("settlement_unknown");
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_rounds WHERE round_id = ?", "round-no-settlement",
    ).one().count)).resolves.toBe(0);
  });

  it(`refunds and terminates a round whose registered settlement rejects its persisted configuration (${testCard("an unrecoverable settlement failure cancels and refunds the round", "a rejected settlement leaves the round open with its stake in escrow", "the fictional viewer makes the test settlement invalid; the test transport is stubbed and no delivery is claimed")})`, async () => {
    const channelId = `round-settlement-failure-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await openAnnouncedRound(object, pointTestModule, "round-settlement-failure", {
      durationS: 60,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "fictional-viewer", amount: 5 }] } },
    }, Date.now() + 60_000);
    await object.joinGameRound(pointTestModule, "round-settlement-failure", "msg:stake", "viewer-a", "nachtfalke", 10, {});

    expect(await forcePointAlarm(object, "round-settlement-failure", (_target, state) => {
      state.storage.sql.exec(
        "UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?",
        Date.now() - 60_000,
        "round-settlement-failure",
      );
    })).toBe(true);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "round-settlement-failure",
    ).one().state)).resolves.toBe("cancelled");
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
  });

  it.each([
    ["network_error", undefined],
    ["already_attempted", 2_000],
  ] as const)(`anchors %s ambiguity to its actual send claim (${testCard("ambiguous delivery time uses the claim timestamp or recorded transport attempt", "retry time or the wrong timestamp starts the round duration", "sendChat is mocked and the test manually makes the scheduled alarm due")})`, async (reason, actualClaimAt) => {
    const channelId = `round-ambiguous-time-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const start = Date.now();
    let attempts = 0;
    const sendChat = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) return Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" as const });
      return Promise.resolve({
        sent: false,
        retryable: false,
        reason,
        delivery: "ambiguous" as const,
        ...(actualClaimAt === undefined ? {} : { attemptedAt: start + actualClaimAt }),
      });
    });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, "round-ambiguous-time", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await deferPointAlarmWithin(state);
    });
    expect(await forcePointAlarm(object, "round-ambiguous-time")).toBe(true);
    vi.setSystemTime(start + 5_000);
    expect(await forcePointAlarm(object, "round-ambiguous-time")).toBe(true);
    const round = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string;
      announce_state: string;
      deadline_at: number | null;
      last_attempt_at: number | null;
    }>("SELECT state, announce_state, deadline_at, last_attempt_at FROM game_rounds WHERE round_id = ?", "round-ambiguous-time").one());
    expect(round.state).toBe("open");
    expect(round.announce_state).toBe("ambiguous");
    expect(round.last_attempt_at).not.toBeNull();
    const claimedAt = round.last_attempt_at;
    if (claimedAt === null) throw new Error("The ambiguous announcement did not retain its send claim.");
    expect(round.deadline_at).toBe((actualClaimAt === undefined ? claimedAt : start + actualClaimAt) + 60_000);

    expect(sendChat).toHaveBeenCalledTimes(2);
  });
});
