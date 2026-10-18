import { beforeAll, describe, expect, it, vi } from "vitest";
import { evictDurableObject } from "cloudflare:test";

import {
  insertPointChannel,
  pointObject,
  pointTestModule,
  capturePointError,
  forcePointAlarmWithin,
  openAnnouncedRound,
  runPointObject,
  stubPointRoundChat,
  runMigrations,
  testCard,
} from "./points-test-helpers";

beforeAll(runMigrations);

describe("game rounds in the worker Durable Object", () => {
  it(`rejects a join after the stored deadline without booking a stake (${testCard("join checks the round deadline inside the DO transaction", "a late participant loses points or appears in the round")})`, async () => {
    const channelId = `round-deadline-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 40);
    const joinResult = await runPointObject(object, async (target) => {
      stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited" }));
      await target.openGameRound(pointTestModule, "round-late", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      await target.markGameRoundAnnounced(pointTestModule, "round-late", Date.now() - 1, "round:late");
      return target.joinGameRound(pointTestModule, "round-late", "msg:late", "viewer-a", "nachtfalke", 10, {});
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

    await expect(object.cancelOpenGameRounds(pointTestModule)).resolves.toBe(1);
    await expect(object.cancelOpenGameRounds(pointTestModule)).resolves.toBe(0);
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

  it(`reconciles an expired open round through the Durable Object alarm (${testCard("a delivered round deadline survives a DO wake and resolves", "an open round has no outcome after its deadline")})`, async () => {
    const channelId = `round-recovery-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited" }));
      await target.openGameRound(pointTestModule, "round-recovery", {
      durationS: 1,
      announceText: "The round starts",
      settlement: { kind: "test", params: { payouts: [{ accountId: "viewer-a", amount: 5 }], result: { recovered: true } } },
      });
      await target.markGameRoundAnnounced(pointTestModule, "round-recovery", Date.now() + 500, "round:recovery");
      await target.joinGameRound(pointTestModule, "round-recovery", "msg:stake", "viewer-a", "nachtfalke", 5, {});
      await state.storage.deleteAlarm();
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    await evictDurableObject(object as unknown as DurableObjectStub);
    const alarmAfterRestart = await runPointObject(object, async (target, state) => {
      const alarm = await state.storage.getAlarm();
      await (target as unknown as { alarm(): Promise<void> }).alarm();
      return alarm;
    });
    expect(alarmAfterRestart).not.toBeNull();

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(20);
    await expect(object.pointRanking(pointTestModule, new Date().toISOString().slice(0, 7), 10)).resolves.toEqual([
      { accountId: "viewer-a", login: "nachtfalke", net: 0 },
    ]);
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
    await expect(object.cancelOpenGameRounds(pointTestModule)).resolves.toBe(1);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(25);
  });

  it(`cancels a start line after six definite rate limits (${testCard("the announcing state retries six times and reaches cancelled", "a seventh line is sent or the round remains accepting", "the alarm transport mock supplies definite rate-limit responses")})`, async () => {
    const channelId = `round-rate-limit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited" }));

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 10);
      await target.openGameRound(pointTestModule, "round-rate-limit", {
        durationS: 60,
        announceText: "The round starts",
        settlement: { kind: "test", params: { payouts: [] } },
      });
      let round = state.storage.sql.exec<{ state: string; announce_attempts: number }>(
        "SELECT state, announce_attempts FROM game_rounds WHERE round_id = ?",
        "round-rate-limit",
      ).one();
      while (round.state !== "cancelled" && round.announce_attempts < 6) {
        await forcePointAlarmWithin(target, state, "round-rate-limit");
        round = state.storage.sql.exec<{ state: string; announce_attempts: number }>(
          "SELECT state, announce_attempts FROM game_rounds WHERE round_id = ?",
          "round-rate-limit",
        ).one();
      }
      expect(round).toEqual({ state: "cancelled", announce_attempts: 6 });
    });

    expect(sendChat).toHaveBeenCalledTimes(6);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(10);
  });

  it(`treats a persisted attempt older than thirty seconds as delivered without resending (${testCard("the next alarm opens an ambiguous announcement from its recorded attempt time", "a lost send acknowledgement emits a duplicate start line", "a persisted attempt row stands in for a crash after the POST and before its state update")})`, async () => {
    const channelId = `round-ambiguous-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const sendChat = vi.fn(() => Promise.resolve({ sent: true }));
    const attemptedAt = Date.now();
    const roundId = "round-ambiguous";
    const alarmKey = `points:round:${roundId}`;

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 10);
      const internal = target as unknown as { recordPointRoundAnnouncement: (...args: unknown[]) => Promise<void> };
      const recordAnnouncement = internal.recordPointRoundAnnouncement;
      Object.assign(target, {
        recordPointRoundAnnouncement: () => Promise.reject(new Error("simulated_crash_after_send")),
      });
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
        state.storage.kv.put("channel:alarm_schedule", {
          [alarmKey]: { deadline: Date.now(), handler: "host:points_round", revision: 1 },
        });
      });
      await state.storage.setAlarm(Date.now());
      await (target as unknown as { alarm(): Promise<void> }).alarm();
      expect(sendChat).toHaveBeenCalledOnce();
      Object.assign(target, { recordPointRoundAnnouncement: recordAnnouncement });
      const attemptAt = Date.now() - 31_000;
      state.storage.sql.exec("UPDATE game_rounds SET last_attempt_at = ? WHERE round_id = ?", attemptAt, roundId);
      await forcePointAlarmWithin(target, state, roundId);
      const recovered = state.storage.sql.exec<{
        state: string;
        announce_state: string;
        announce_attempts: number;
        deadline_at: number | null;
      }>(
        "SELECT state, announce_state, announce_attempts, deadline_at FROM game_rounds WHERE round_id = ?",
        roundId,
      ).one();
      expect(recovered).toEqual({
        state: "open",
        announce_state: "ambiguous",
        announce_attempts: 1,
        deadline_at: attemptAt + 60_000,
      });
    });

    expect(sendChat).toHaveBeenCalledOnce();
  });
});
