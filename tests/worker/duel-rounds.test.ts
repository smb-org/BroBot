import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pointObject, insertPointChannel, clearPointObjectAlarms, runMigrations, runPointObject, capturePointError, deferPointAlarmWithin, forcePointAlarm, type PointsWorkerObject } from "./points-test-helpers";
const testSettlement = { kind: "test", params: { payouts: [] } };
const worker = env as unknown as { DB: D1Database; CHANNEL: Env["CHANNEL"]; TOKEN_ENCRYPTION_KEYS?: string; SESSION_ENCRYPTION_KEYS?: string };

interface DuelRoundObject extends PointsWorkerObject {
  activeGameRound(moduleId: string): Promise<{ roundId: string; state: "announcing" | "open"; data: unknown; deadlineAt: number | null } | null>;
  markGameRoundAnnounced(moduleId: string, roundId: string, deadlineAt: number, alarmKey: string): Promise<void>;
  answerGameRound?: never;
}

const duelObject = (channelId: string): DuelRoundObject => pointObject(channelId);

const duelRoundData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const challengerId = typeof overrides.challengerId === "string" ? overrides.challengerId : "viewer_anna";
  const targetId = overrides.targetId === undefined ? null : overrides.targetId;
  const targetLockKeys = typeof targetId === "string" ? [`target:${targetId}`] : [];
  return {
    challengerId,
    challengerLogin: "frostfern",
    targetId,
    targetLogin: targetId === null ? null : "moonmoss",
    stake: 100,
    botEnabled: true,
    acceptCommand: "!ja",
    language: "de",
    chatTarget: null,
    sourceBroadcasterUserId: null,
    challengeMessageId: "fictional-challenge-message",
    fightText: "{winnerLogin} gewinnt {net}.",
    botFightText: "{winnerLogin} gegen BroBot: {net}.",
    lockKeys: [
      `challenger:${challengerId}`,
      ...targetLockKeys,
    ],
    durationS: 60,
    announceText: "A duel is open.",
    settlement: { kind: "duel", params: { mode: "expire" } },
    ...overrides,
  };
};

const createViewer = async (object: DuelRoundObject, accountId: string, login: string, balance = 500): Promise<void> => {
  await object.touchPointAccount("duel", accountId, login, balance);
};

const openWithStake = async (object: DuelRoundObject, roundId: string, data: Record<string, unknown>, operationId: string,
  accountId = "viewer_anna", login = "frostfern", stake = 100): Promise<void> => {
  await object.openGameRoundWithStake("duel", roundId, data, operationId, accountId, login, stake);
};

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try { await clearPointObjectAlarms(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe("generic point round lock keys", () => {
  it("rejects a second round with a conflicting target lock [protects=one targeted duel can hold each target lock; fails_when=a second round obtains the same lock or leaves its round row behind; no_claim=the service maps the lock error to localized chat copy]", async () => {
    const channelId = `duel-lock-conflict-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await object.openGameRound("test_game", "lock-first", {
      durationS: 60, announceText: "Open", lockKeys: ["challenger:viewer_anna", "target:viewer_ben"], settlement: testSettlement,
    });
    const error = await capturePointError(object, (target) => target.openGameRound("test_game", "lock-second", {
      durationS: 60, announceText: "Open", lockKeys: ["challenger:viewer_cara", "target:viewer_ben"], settlement: testSettlement,
    }));
    const rows = await runPointObject(object, (_target, state) => ({
      rounds: state.storage.sql.exec<{ round_id: string }>("SELECT round_id FROM game_rounds ORDER BY round_id").toArray().map(({ round_id }) => round_id),
      locks: state.storage.sql.exec<{ lock_key: string }>("SELECT lock_key FROM game_round_locks ORDER BY lock_key").toArray().map(({ lock_key }) => lock_key),
    }));
    expect(error).toBe("round_locked");
    expect(rows).toEqual({ rounds: ["lock-first"], locks: ["challenger:viewer_anna", "target:viewer_ben"] });
  });

  it("releases locks in the same transaction as resolution [protects=resolved rounds stop blocking their challenger and target; fails_when=any lock remains after resolve; no_claim=the next challenge is accepted by the module service in a separate worker test]", async () => {
    const channelId = `duel-lock-resolve-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await object.openGameRound("test_game", "lock-resolve", {
      durationS: 60, announceText: "Open", lockKeys: ["challenger:viewer_anna", "target:viewer_ben"], settlement: testSettlement,
    });
    await object.markGameRoundAnnounced("test_game", "lock-resolve", Date.now() + 60_000, "round:lock-resolve");
    await object.resolveGameRound("test_game", "lock-resolve", testSettlement);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_locks WHERE module_id = ? AND round_id = ?", "test_game", "lock-resolve",
    ).one().count)).resolves.toBe(0);
  });

  it("releases locks on module cancellation after refunding the stake [protects=cancelled open rounds release their locks with the refund; fails_when=the lock blocks reuse or the escrow remains funded; no_claim=the dashboard module-disable request is a route-level concern]", async () => {
    const channelId = `duel-lock-cancel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await openWithStake(object, "lock-cancel", duelRoundData(), "msg:lock-cancel");
    await object.setGameModuleGate("duel", true, 1, 1);
    await object.cancelOpenGameRounds("duel", 1);
    const state = await runPointObject(object, (_target, durableState) => ({
      locks: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_locks").one().count,
      escrow: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "__escrow:lock-cancel").toArray()[0]?.balance ?? 0,
      participant: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_anna").one().balance,
    }));
    expect(state).toEqual({ locks: 0, escrow: 0, participant: 500 });
  });

  it("keeps the one-round limit for Blitz [protects=Blitz still has at most one announcing or open round; fails_when=a lockless second Blitz round succeeds or returns round_locked; no_claim=Blitz answer and prize behavior are covered in its own suite]", async () => {
    const channelId = `duel-blitz-regression-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify({ prize: 50, answerTimeSeconds: 60, chatTarget: null, startText: "Open", solvedText: "Solved", timeoutText: "Timeout" })).run();
    const object = duelObject(channelId);
    const blitzData = { durationS: 60, announceText: "Open", answer: "CLOUD", settlement: { kind: "blitz", params: { prize: 50 } } };
    await object.openGameRound("blitz_round", "blitz-first", blitzData);
    await expect(capturePointError(object, (target) => target.openGameRound("blitz_round", "blitz-second", blitzData))).resolves.toBe("round_active");
  });
});

describe("atomic duel opening and acceptance", () => {
  it("escrows the challenger stake and locks before announcement [protects=one openWithStake call books the first stake with its round and locks; fails_when=the balance is unchanged or a separate join is needed; no_claim=chat formatting and delivery are covered by module-flow tests]", async () => {
    const channelId = `duel-open-stake-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await openWithStake(object, "duel-open", duelRoundData(), "msg:duel-open");
    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", "duel-open").one().state,
      viewer: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_anna").one().balance,
      escrow: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "__escrow:duel-open").one().balance,
      locks: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_locks WHERE round_id = ?", "duel-open").one().count,
    }));
    expect(state).toEqual({ round: "announcing", viewer: 400, escrow: 100, locks: 1 });
  });

  it("writes nothing when the challenger cannot fund the stake [protects=insufficient challenge funds leave no round, operation, escrow, lock, or cooldown; fails_when=any durable state changes despite the rejected stake; no_claim=localized throttled error delivery is checked in the service suite]", async () => {
    const channelId = `duel-open-insufficient-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern", 50);
    const error = await capturePointError(object, (target) => target.openGameRoundWithStake(
      "duel", "duel-no-funds", duelRoundData(), "msg:duel-no-funds", "viewer_anna", "frostfern", 100,
      { key: "challenge:viewer_anna", seconds: 30 },
    ));
    const state = await runPointObject(object, (_target, durableState) => ({
      balance: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_anna").one().balance,
      rounds: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_rounds WHERE module_id = 'duel'").one().count,
      operations: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "msg:duel-no-funds").one().count,
      locks: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_locks WHERE module_id = 'duel'").one().count,
      cooldowns: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_cooldowns WHERE key = ?", "duel:challenge:viewer_anna").one().count,
    }));
    expect(error).toBe("insufficient_points");
    expect(state).toEqual({ balance: 50, rounds: 0, operations: 0, locks: 0, cooldowns: 0 });
  });

  it("enforces fifty open duels per channel [protects=a channel cannot exceed fifty concurrently locked duel rounds; fails_when=the fifty-first round opens; no_claim=multiple Durable Object processes are not involved in this single-channel cap test]", async () => {
    const channelId = `duel-round-limit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    for (let index = 0; index < 50; index += 1) {
      const accountId = `viewer_${String(index)}`;
      await createViewer(object, accountId, `fictional_${String(index)}`);
      await object.openGameRoundWithStake("duel", `duel-cap-${String(index)}`, duelRoundData({
        challengerId: accountId,
        lockKeys: [`challenger:${accountId}`],
      }), `msg:duel-cap-${String(index)}`, accountId, `fictional_${String(index)}`, 100);
    }
    await createViewer(object, "viewer_extra", "fictional_extra");
    const error = await capturePointError(object, (target) => target.openGameRoundWithStake("duel", "duel-cap-overflow", duelRoundData({
      challengerId: "viewer_extra", lockKeys: ["challenger:viewer_extra"],
    }), "msg:duel-cap-overflow", "viewer_extra", "fictional_extra", 100));
    const count = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_rounds WHERE module_id = 'duel' AND state IN ('announcing', 'open')",
    ).one().count);
    expect(error).toBe("round_limit");
    expect(count).toBe(50);
  });

  it("rejects self and wrong-target accepts before debiting the acceptor [protects=DO round data controls who may accept; fails_when=self or an unrelated viewer is charged or inserted; no_claim=role badge authorization is checked by the chat module before this API]", async () => {
    const channelId = `duel-accept-eligibility-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await createViewer(object, "viewer_cara", "starling");
    await openWithStake(object, "duel-targeted", duelRoundData({ targetId: "viewer_ben" }), "msg:duel-targeted");
    await object.markGameRoundAnnounced("duel", "duel-targeted", Date.now() + 60_000, "round:duel-targeted");
    await expect(capturePointError(object, (target) => target.acceptGameRound("duel", "duel-targeted", "msg:self-accept", "viewer_anna", "frostfern")))
      .resolves.toBe("not_eligible");
    await expect(capturePointError(object, (target) => target.acceptGameRound("duel", "duel-targeted", "msg:wrong-accept", "viewer_cara", "starling")))
      .resolves.toBe("not_eligible");
    const state = await runPointObject(object, (_target, durableState) => ({
      participants: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "duel-targeted").one().count,
      wrongOperation: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "msg:wrong-accept").one().count,
      wrongBalance: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_cara").one().balance,
    }));
    expect(state).toEqual({ participants: 1, wrongOperation: 0, wrongBalance: 500 });
  });

  it("keeps an open duel untouched when an acceptor lacks points [protects=an underfunded accept cannot charge, resolve, release locks, or close the challenge; fails_when=the challenge is no longer open or acceptor stake is written; no_claim=the throttled service reply is exercised separately]", async () => {
    const channelId = `duel-accept-insufficient-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss", 50);
    await openWithStake(object, "duel-insufficient", duelRoundData(), "msg:duel-insufficient");
    await object.markGameRoundAnnounced("duel", "duel-insufficient", Date.now() + 60_000, "round:duel-insufficient");
    await expect(capturePointError(object, (target) => target.acceptGameRound("duel", "duel-insufficient", "msg:accept-poor", "viewer_ben", "moonmoss")))
      .resolves.toBe("insufficient_points");
    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", "duel-insufficient").one().state,
      participantCount: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "duel-insufficient").one().count,
      acceptOperationCount: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "msg:accept-poor").one().count,
      locks: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_locks WHERE round_id = ?", "duel-insufficient").one().count,
    }));
    expect(state).toEqual({ round: "open", participantCount: 1, acceptOperationCount: 0, locks: 1 });
  });

  it("charges only the first of twenty concurrent acceptors [protects=the atomic accept race settles one winner and one acceptor stake; fails_when=two viewers are charged or more than one resolve operation exists; no_claim=network result-line delivery is tested by the module flow]", async () => {
    const channelId = `duel-accept-race-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await openWithStake(object, "duel-race", duelRoundData(), "msg:duel-race");
    await object.markGameRoundAnnounced("duel", "duel-race", Date.now() + 60_000, "round:duel-race");
    const viewers = Array.from({ length: 20 }, (_, index) => ({ id: `viewer_${String(index)}`, login: `fictional_${String(index)}` }));
    for (const viewer of viewers) await createViewer(object, viewer.id, viewer.login);
    const results = await Promise.allSettled(viewers.map((viewer) => object.acceptGameRound("duel", "duel-race", `msg:accept-${viewer.id}`, viewer.id, viewer.login)));
    const state = await runPointObject(object, (_target, durableState) => ({
      charged: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_ledger WHERE operation_id LIKE 'msg:accept-%' AND delta = -100").one().count,
      resolveCount: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:duel-race:resolve").one().count,
      acceptors: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "duel-race").one().count - 1,
      balances: viewers.map(({ id }) => durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", id).one().balance),
    }));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(state.charged).toBe(1);
    expect(state.resolveCount).toBe(1);
    expect(state.acceptors).toBe(1);
    expect(state.balances.filter((balance) => balance !== 500)).toHaveLength(1);
    expect([400, 600]).toContain(state.balances.find((balance) => balance !== 500));
  });

  it("replays an accepted message without a second stake or payout [protects=the message operation identity makes a duplicate accept a replay; fails_when=an exact replay charges either account twice; no_claim=EventSub delivery duplication outside this DO boundary]", async () => {
    const channelId = `duel-accept-replay-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await openWithStake(object, "duel-replay", duelRoundData(), "msg:duel-replay");
    await object.markGameRoundAnnounced("duel", "duel-replay", Date.now() + 60_000, "round:duel-replay");
    const first = await object.acceptGameRound("duel", "duel-replay", "msg:accept-replay", "viewer_ben", "moonmoss");
    const afterFirst = await object.pointBalance("duel", "viewer_ben");
    const replay = await object.acceptGameRound("duel", "duel-replay", "msg:accept-replay", "viewer_ben", "moonmoss");
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    await expect(object.pointBalance("duel", "viewer_ben")).resolves.toBe(afterFirst);
    const operations = await runPointObject(object, (_target, state) => ({
      acceptStake: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "msg:accept-replay").one().count,
      resolution: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:duel-replay:resolve").one().count,
    }));
    expect(operations).toEqual({ acceptStake: 1, resolution: 1 });
  });

  it("settles once when acceptance races the expiry alarm [protects=accept and expiry share one transactional resolution operation; fails_when=both paths book a result or the house and human both pay twice; no_claim=real alarm scheduling latency and Twitch delivery are controlled by the worker harness]", async () => {
    const channelId = `duel-accept-expiry-race-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = duelObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await object.openGameRoundWithStake("test_game", "duel-expiry-race", duelRoundData(), "msg:duel-expiry-race", "viewer_anna", "frostfern", 100);
    await object.markGameRoundAnnounced("test_game", "duel-expiry-race", Date.now(), "round:duel-expiry-race");
    await runPointObject(object, (target, state) => {
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => unknown };
      const original = runtime.moduleAlarmContext.bind(target);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({
        ...(original(...args) as object),
        sendChat: () => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" as const }),
      }));
      return deferPointAlarmWithin(state);
    });
    const outcomes = await Promise.allSettled([
      object.acceptGameRound("test_game", "duel-expiry-race", "msg:accept-expiry-race", "viewer_ben", "moonmoss"),
      forcePointAlarm(object, "duel-expiry-race"),
    ]);
    const ledger = await runPointObject(object, (_target, state) => ({
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:duel-expiry-race:resolve",
      ).one().count,
      balanceSum: state.storage.sql.exec<{ balance_sum: number }>("SELECT COALESCE(SUM(balance), 0) AS balance_sum FROM point_accounts").one().balance_sum,
    }));
    expect(ledger).toEqual({ operationCount: 1, balanceSum: 0 });
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  });
});
