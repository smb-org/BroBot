import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bossAttackOperationId } from "../../src/modules/boss_fight/service";
import { attackPointRoundSync } from "../../src/worker/durable/points";
import {
  clearPointObjectAlarms,
  forcePointAlarm,
  insertPointChannel,
  openAnnouncedRound,
  pointObject,
  runMigrations,
  runPointObject,
  type PointsWorkerObject,
} from "./points-test-helpers";

interface BossFightObject extends PointsWorkerObject {
  attackGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    damage: number,
    messageAt: number,
  ): Promise<{
    status: "hit" | "cooldown" | "round_closed";
    replayed: boolean;
    damage: number;
    defeated: boolean;
    currentHp: number;
    maxHp: number;
    attackers: number;
    damageDealt: number;
  }>;
  activeGameRound(moduleId: string): Promise<{ roundId: string; state: "announcing" | "open"; data: unknown; deadlineAt: number | null } | null>;
}

const bossObject = (object: PointsWorkerObject): BossFightObject => object as BossFightObject;
const bossRound = (roundId: string, durationS = 90) => ({
  durationS,
  announceText: "The boss appears.",
  settlement: { kind: "boss_fight", params: {} },
  baseHp: 300,
  hpPerAttacker: 80,
  damageMinimum: 20,
  damageMaximum: 40,
  attackCooldownSeconds: 10,
  lootPool: 101,
  defeated: false,
  damageDealt: 0,
  attackerCount: 0,
  maxHp: 300,
  currentHp: 300,
  roundId,
});

const attack = async (object: BossFightObject, roundId: string, user: string, login: string, messageId: string, damage = 40) =>
  object.attackGameRound("boss_fight", roundId, await bossAttackOperationId(roundId, user, messageId), user, login, damage, Date.now());

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});

afterEach(async () => {
  try { await clearPointObjectAlarms(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe("boss fight rounds in the channel Durable Object", () => {
  it("records free attacks once per cooldown and pays a proportional, zero-sum loot pool on defeat", async () => {
    const channelId = `boss-win-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    const data = bossRound("boss-win");
    await openAnnouncedRound(object, "boss_fight", "boss-win", data, Date.now() + 90_000);

    const first = await attack(object, "boss-win", "viewer_one", "frostfern", "message-a-0");
    const other = await attack(object, "boss-win", "viewer_two", "moonmoss", "message-b-0");
    const retry = await attack(object, "boss-win", "viewer_one", "frostfern", "message-a-0", 20);
    const cooldown = await attack(object, "boss-win", "viewer_one", "frostfern", "message-a-too-soon");

    expect(first).toMatchObject({ status: "hit", replayed: false, damage: 40, attackers: 1, damageDealt: 40 });
    expect(other).toMatchObject({ status: "hit", attackers: 2, maxHp: 460, damageDealt: 80 });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(cooldown).toMatchObject({ status: "cooldown", damage: 0, attackers: 2, damageDealt: 80 });

    for (let index = 1; index < 5; index += 1) {
      vi.setSystemTime(Date.now() + 10_000);
      await attack(object, "boss-win", "viewer_one", "frostfern", `message-a-${String(index)}`);
      await attack(object, "boss-win", "viewer_two", "moonmoss", `message-b-${String(index)}`);
    }
    vi.setSystemTime(Date.now() + 10_000);
    await attack(object, "boss-win", "viewer_one", "frostfern", "message-a-final");
    const finalAttack = await attack(object, "boss-win", "viewer_two", "moonmoss", "message-b-final");
    expect(finalAttack).toMatchObject({ status: "hit", defeated: true, damageDealt: 480 });
    await expect(attack(object, "boss-win", "viewer_two", "moonmoss", "after-defeat")).resolves.toMatchObject({ status: "round_closed" });

    const firstResolve = await object.resolveGameRound("boss_fight", "boss-win", { kind: "boss_fight", params: {} });
    const replayResolve = await object.resolveGameRound("boss_fight", "boss-win", { kind: "boss_fight", params: {} });
    const ledger = await runPointObject(object, (_target, state) => ({
      sum: state.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(balance), 0) AS total FROM point_accounts").one().total,
      negativeAccounts: state.storage.sql.exec<{ account_id: string }>("SELECT account_id FROM point_accounts WHERE balance < 0").toArray().map(({ account_id }) => account_id),
      resolveOperations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:boss-win:resolve").one().count,
      attackColumns: state.storage.sql.exec<{ name: string }>("PRAGMA table_info(game_round_attacks)").toArray().map(({ name }) => name),
      attackRows: state.storage.sql.exec<{ operation_id: string; payload_hash: string; result_json: string }>(
        "SELECT operation_id, payload_hash, result_json FROM game_round_attacks",
      ).toArray(),
    }));

    expect(firstResolve.result).toMatchObject({ defeated: true, distributed: 100, houseRemainder: 1 });
    expect(replayResolve.replayed).toBe(true);
    expect(await object.pointBalance("boss_fight", "viewer_one")).toBe(50);
    expect(await object.pointBalance("boss_fight", "viewer_two")).toBe(50);
    expect(ledger).toMatchObject({ sum: 0, negativeAccounts: ["__house"], resolveOperations: 1 });
    expect(ledger.attackColumns).not.toContain("account_id");
    expect(ledger.attackRows).toEqual([]);
  });

  it("keeps an open round and its end alarm across Durable Object eviction, then pays nothing on timeout", async () => {
    const channelId = `boss-timeout-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    await openAnnouncedRound(object, "boss_fight", "boss-timeout", bossRound("boss-timeout"), Date.now() + 90_000);
    await attack(object, "boss-timeout", "viewer_one", "frostfern", "message-timeout");

    await evictDurableObject(object as unknown as DurableObjectStub);
    await expect(object.activeGameRound("boss_fight")).resolves.toMatchObject({ roundId: "boss-timeout", state: "open" });
    vi.setSystemTime(Date.now() + 90_000);
    await forcePointAlarm(object, "boss-timeout");

    const roundState = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM game_rounds WHERE round_id = ?", "boss-timeout",
    ).one().state);
    expect(roundState).toBe("resolved");
    expect(await object.pointBalance("boss_fight", "viewer_one")).toBe(0);
    await expect(object.activeGameRound("boss_fight")).resolves.toBeNull();
  });

  it("cancels an active boss without payout when the module gate closes", async () => {
    const channelId = `boss-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    await openAnnouncedRound(object, "boss_fight", "boss-disable", bossRound("boss-disable"), Date.now() + 90_000);
    await attack(object, "boss-disable", "viewer_one", "frostfern", "message-disable");

    await object.setGameModuleGate("boss_fight", true, 1, 1);
    await expect(object.cancelOpenGameRounds("boss_fight", 1)).resolves.toBe(1);

    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", "boss-disable").one().state,
      pointOperations: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations").one().count,
    }));
    expect(state).toEqual({ round: "cancelled", pointOperations: 0 });
    await expect(object.pointBalance("boss_fight", "viewer_one")).resolves.toBe(0);
  });

  it("stores only accepted hits and leaves no attack rows or cooldown keys after a spammed round is cancelled [protects=rejected attacks write nothing and a finished round drops its attack rows and cooldown keys; fails_when=spam grows a table or anything survives cancel or resolve; no_claim=reply behaviour is covered by the chat tests]", async () => {
    const channelId = `boss-spam-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    await openAnnouncedRound(object, "boss_fight", "boss-spam", bossRound("boss-spam"), Date.now() + 90_000);
    await attack(object, "boss-spam", "viewer_one", "frostfern", "spam-hit");
    for (let index = 0; index < 25; index += 1) await attack(object, "boss-spam", "viewer_one", "frostfern", `spam-${String(index)}`);
    await attack(object, "unknown-round", "viewer_two", "moonmoss", "spam-unknown");

    const attackState = (target: BossFightObject) => runPointObject(target, (_target, state) => ({
      attacks: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_attacks").one().count,
      cooldowns: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_cooldowns WHERE key LIKE 'boss_fight:%'").one().count,
    }));
    await expect(attackState(object)).resolves.toEqual({ attacks: 1, cooldowns: 1 });
    const stored = await runPointObject(object, (_target, state) => JSON.stringify([
      ...state.storage.sql.exec("SELECT * FROM game_round_attacks").toArray(),
      ...state.storage.sql.exec("SELECT * FROM game_cooldowns WHERE key LIKE 'boss_fight:%'").toArray(),
    ]));
    expect(stored).not.toMatch(/viewer_one|frostfern/u);

    await object.setGameModuleGate("boss_fight", true, 1, 1);
    await expect(object.cancelOpenGameRounds("boss_fight", 1)).resolves.toBe(1);
    await expect(attackState(object)).resolves.toEqual({ attacks: 0, cooldowns: 0 });
  });

  it("drops attack rows and cooldown keys when the round resolves [protects=resolution cleans the per-round attack state; fails_when=rows or cooldown keys survive settlement; no_claim=payout amounts are covered by the first test]", async () => {
    const channelId = `boss-clean-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    await openAnnouncedRound(object, "boss_fight", "boss-clean", bossRound("boss-clean"), Date.now() + 90_000);
    await attack(object, "boss-clean", "viewer_one", "frostfern", "clean-hit");
    vi.setSystemTime(Date.now() + 90_000);
    await forcePointAlarm(object, "boss-clean");
    await expect(runPointObject(object, (_target, state) => ({
      attacks: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_attacks").one().count,
      cooldowns: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_cooldowns WHERE key LIKE 'boss_fight:%'").one().count,
    }))).resolves.toEqual({ attacks: 0, cooldowns: 0 });
  });

  it("does constant database work per hit however many attackers joined [protects=a hit reads the round aggregates instead of reloading all participants; fails_when=statements or rows read per hit grow with the attacker count; no_claim=the absolute numbers are a loose ceiling, not a benchmark]", async () => {
    const channelId = `boss-bounded-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = bossObject(pointObject(channelId));
    await openAnnouncedRound(object, "boss_fight", "boss-bounded", bossRound("boss-bounded"), Date.now() + 90_000);

    const work = await runPointObject(object, (_target, state) => {
      const measure = (index: number): { statements: number; rowsRead: number } => {
        const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
        const counting = {
          exec: (query: string, ...bindings: unknown[]) => {
            const cursor = state.storage.sql.exec(query, ...bindings);
            cursors.push(cursor);
            return cursor;
          },
        } as unknown as DurableObjectStorage["sql"];
        state.storage.transactionSync(() => attackPointRoundSync(
          counting, "boss_fight", "boss-bounded", `op-${String(index)}`, `viewer_${String(index)}`, `login${String(index)}`,
          30, Date.now(), `hash-${String(index)}`, `cooldown-${String(index)}`, Date.now(), new Date().toISOString(),
        ));
        return { statements: cursors.length, rowsRead: cursors.reduce((total, cursor) => total + cursor.rowsRead, 0) };
      };
      const results: { statements: number; rowsRead: number }[] = [];
      for (let index = 0; index < 60; index += 1) results.push(measure(index));
      return results;
    });

    const early = work[2];
    const late = work[59];
    expect(late?.statements).toBe(early?.statements);
    expect(late?.rowsRead).toBeLessThanOrEqual((early?.rowsRead ?? 0) + 2);
    expect(late?.rowsRead).toBeLessThan(40);
  });
});
