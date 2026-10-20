import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ModuleAlarmContext } from "../../src/modules/contract";
import { createBlitzQuestionRepository } from "../../src/modules/blitz_round/adapters/d1";
import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";
import { openBlitzRound, processBlitzMessage } from "../../src/modules/blitz_round/service";
import { modulePoints } from "../../src/worker/module-points";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blitzRoundModule } from "../../src/modules/blitz_round";
import {
  capturePointError,
  clearPointObjectAlarms,
  deferPointAlarmWithin,
  forcePointAlarm,
  insertPointChannel,
  openAnnouncedRound,
  pointObject,
  pointTestModule,
  runPointObject,
  runMigrations,
  stubPointRoundChat,
  type PointsWorkerObject,
} from "./points-test-helpers";

interface BlitzPointRoundObject extends PointsWorkerObject {
  answerGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    graceS: number,
  ): Promise<{ status: "recorded" | "already_answered" | "round_closed"; replayed: boolean; first: boolean }>;
  activeGameRound(moduleId: string): Promise<{
    roundId: string;
    state: "announcing" | "open";
    data: unknown;
    deadlineAt: number | null;
  } | null>;
}

const blitzObject = (object: PointsWorkerObject): BlitzPointRoundObject => object as BlitzPointRoundObject;
const testSettlement = { kind: "test", params: { payouts: [] } };
const openAnswerRound = async (
  object: BlitzPointRoundObject,
  roundId: string,
  moduleId = pointTestModule,
  deadlineAt = Date.now() + 60_000,
): Promise<void> => openAnnouncedRound(object, moduleId, roundId, {
  durationS: 60,
  announceText: "The round starts",
  settlement: testSettlement,
}, deadlineAt);

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try {
    await clearPointObjectAlarms();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("blitz answers in the channel Durable Object", () => {
  it("records the first zero-stake answer and shortens the deadline to five seconds [protects=the first correct answer starts the grace window without escrow; fails_when=the answer is charged points or the deadline remains longer than five seconds; no_claim=does not verify chat matching or result delivery]", async () => {
    const channelId = `blitz-first-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-first");

    const result = await object.answerGameRound(pointTestModule, "blitz-first", "msg:first", "viewer_one", "frostfern", 5);
    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ deadline_at: number }>(
        "SELECT deadline_at FROM game_rounds WHERE round_id = ?", "blitz-first",
      ).one(),
      participant: durableState.storage.sql.exec<{ stake: number }>(
        "SELECT stake FROM game_round_participants WHERE round_id = ? AND account_id = ?", "blitz-first", "viewer_one",
      ).one(),
    }));

    expect(result).toEqual({ status: "recorded", replayed: false, first: true });
    expect(state.round.deadline_at).toBe(Date.now() + 5_000);
    expect(state.participant.stake).toBe(0);
  });

  it("keeps the earlier timeout when an answer arrives near the end [protects=grace never extends the existing deadline; fails_when=an answer with two seconds left adds five seconds; no_claim=does not test network arrival latency]", async () => {
    const channelId = `blitz-near-timeout-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const deadline = Date.now() + 2_000;
    await openAnswerRound(object, "blitz-near-timeout", pointTestModule, deadline);
    await expect(object.answerGameRound(pointTestModule, "blitz-near-timeout", "msg:near", "viewer_one", "frostfern", 5))
      .resolves.toMatchObject({ status: "recorded", first: true });
    await expect(object.activeGameRound(pointTestModule)).resolves.toMatchObject({ deadlineAt: deadline });
  });

  it("cancels zero-stake answers on disable without a refund booking [protects=disabling closes free-entry rounds without creating escrow or refund movements; fails_when=cancellation fails on zero stakes or leaves a live round; no_claim=does not test the dashboard toggle request]", async () => {
    const channelId = `blitz-cancel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-cancel");
    await object.answerGameRound(pointTestModule, "blitz-cancel", "msg:cancel", "viewer_one", "frostfern", 5);
    await object.setGameModuleGate(pointTestModule, true, 1);
    await expect(object.cancelOpenGameRounds(pointTestModule, 1)).resolves.toBe(1);
    await expect(object.cancelOpenGameRounds(pointTestModule, 1)).resolves.toBe(0);
    await expect(object.activeGameRound(pointTestModule)).resolves.toBeNull();
    const rows = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", "blitz-cancel").one().state,
      operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations").one().count,
    }));
    expect(rows).toEqual({ round: "cancelled", operations: 0 });
  });

  it("records simultaneous correct viewers and replays the same message only once [protects=distinct viewers can answer concurrently while an exact message replay is idempotent; fails_when=one simultaneous viewer is dropped or the replay adds another participant; no_claim=does not stress cross-isolate throughput]", async () => {
    const channelId = `blitz-concurrent-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-concurrent");

    const results = await Promise.all([
      object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:one", "viewer_one", "frostfern", 5),
      object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:two", "viewer_two", "moonmoss", 5),
    ]);
    const replay = await object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:one", "viewer_one", "frostfern", 5);
    const participantCount = await runPointObject(object, (_target, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "blitz-concurrent",
      ).one().count);

    expect(results.map(({ status }) => status)).toEqual(["recorded", "recorded"]);
    expect(results.filter(({ first }) => first)).toHaveLength(1);
    expect(replay).toEqual({ status: "recorded", replayed: true, first: results[0].first });
    expect(participantCount).toBe(2);
  });

  it("rejects a second message from the same account without adding another answer [protects=one viewer can count only once per round; fails_when=a second operation inserts another participant; no_claim=does not verify Twitch account merge behavior]", async () => {
    const channelId = `blitz-duplicate-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-duplicate");
    await object.answerGameRound(pointTestModule, "blitz-duplicate", "msg:first", "viewer_one", "frostfern", 5);

    const second = await object.answerGameRound(pointTestModule, "blitz-duplicate", "msg:second", "viewer_one", "frostfern", 5);
    const participantCount = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "blitz-duplicate",
    ).one().count);

    expect(second).toEqual({ status: "already_answered", replayed: false, first: false });
    expect(participantCount).toBe(1);
  });

  it("returns and replays round_closed after the shortened deadline [protects=answers after the five-second grace deadline are ignored and their status is stable; fails_when=a late answer joins or its replay changes status; no_claim=does not test clock skew between Twitch and the DO]", async () => {
    const channelId = `blitz-closed-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-closed");
    await object.answerGameRound(pointTestModule, "blitz-closed", "msg:first", "viewer_one", "frostfern", 5);
    await runPointObject(object, async (target, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, "blitz-closed");
      await deferPointAlarmWithin(state);
      void target;
    });

    const late = await object.answerGameRound(pointTestModule, "blitz-closed", "msg:late", "viewer_two", "moonmoss", 5);
    const replay = await object.answerGameRound(pointTestModule, "blitz-closed", "msg:late", "viewer_two", "moonmoss", 5);
    const participantCount = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", "blitz-closed",
    ).one().count);

    expect(late).toEqual({ status: "round_closed", replayed: false, first: false });
    expect(replay).toEqual({ status: "round_closed", replayed: true, first: false });
    expect(participantCount).toBe(1);
  });

  it("keeps one active round per module and returns its stored snapshot [protects=the DO serializes same-module starts and active reads survive from persisted round data; fails_when=two starts for one module are active or the snapshot is lost; no_claim=does not establish a channel-wide lock across different modules]", async () => {
    const channelId = `blitz-active-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-active", pointTestModule, Date.now() + 20_000);

    const active = await object.activeGameRound(pointTestModule);
    const sameModuleError = await capturePointError(object, (target) => target.openGameRound(pointTestModule, "blitz-second", {
      durationS: 60,
      announceText: "Another round",
      settlement: testSettlement,
    }));
    const otherModuleError = await capturePointError(object, (target) => target.openGameRound("other_game", "other-active", {
      durationS: 60,
      announceText: "A different game",
      settlement: testSettlement,
    }));

    expect(active).toMatchObject({
      roundId: "blitz-active",
      state: "open",
      data: { announceText: "The round starts" },
      deadlineAt: Date.now() + 20_000,
    });
    expect(sameModuleError).toBe("round_active");
    expect(otherModuleError).toBeNull();
  });

  it("books an ordered prize split once and updates monthly wins [protects=the blitz resolution operation pays ordered winners and records each positive win once; fails_when=a replay moves points again or monthly net is missing; no_claim=does not verify result-line delivery]", async () => {
    const channelId = `blitz-settlement-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await object.openGameRound("blitz_round", "blitz-settlement", {
      durationS: 60,
      announceText: "Blitz round starts",
      answer: "CLOUD",
      settlement: { kind: "blitz", params: { prize: 50 } },
    });
    await object.markGameRoundAnnounced("blitz_round", "blitz-settlement", Date.now() + 60_000, "round:blitz-settlement");
    await object.answerGameRound("blitz_round", "blitz-settlement", "msg:first", "viewer_one", "frostfern", 5);
    await object.answerGameRound("blitz_round", "blitz-settlement", "msg:second", "viewer_two", "moonmoss", 5);

    const first = await object.resolveGameRound("blitz_round", "blitz-settlement", { kind: "blitz", params: { prize: 50 } });
    const replay = await object.resolveGameRound("blitz_round", "blitz-settlement", { kind: "blitz", params: { prize: 50 } });
    const rows = await runPointObject(object, (_target, state) => ({
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:blitz-settlement:resolve",
      ).one().count,
      movementSum: state.storage.sql.exec<{ total: number }>(
        "SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger WHERE operation_id = ?", "round:blitz-settlement:resolve",
      ).one().total,
    }));
    const month = new Date().toISOString().slice(0, 7);

    expect(first).toMatchObject({
      replayed: false,
      result: { answer: "CLOUD", winners: [
        { accountId: "viewer_one", login: "frostfern" },
        { accountId: "viewer_two", login: "moonmoss" },
      ], share: 25 },
    });
    expect(replay).toMatchObject({ replayed: true, result: first.result });
    expect(rows).toEqual({ operationCount: 1, movementSum: 0 });
    await expect(object.pointRanking("blitz_round", month, 10)).resolves.toEqual([
      { accountId: "viewer_one", login: "frostfern", net: 25 },
      { accountId: "viewer_two", login: "moonmoss", net: 25 },
    ]);
  });

  it("resolves a no-answer round with an empty zero-sum ledger entry [protects=no-winner rounds can commit an empty settlement; fails_when=resolve rejects the round or records a nonzero movement; no_claim=does not verify localized timeout output]", async () => {
    const channelId = `blitz-no-winners-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await object.openGameRound("blitz_round", "blitz-no-winners", {
      durationS: 60,
      announceText: "Blitz round starts",
      answer: "LANTERN",
      settlement: { kind: "blitz", params: { prize: 50 } },
    });
    await object.markGameRoundAnnounced("blitz_round", "blitz-no-winners", Date.now() + 60_000, "round:blitz-no-winners");

    const result = await object.resolveGameRound("blitz_round", "blitz-no-winners", { kind: "blitz", params: { prize: 50 } });
    const operation = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ result_json: string; count: number }>(
      `SELECT result_json, (SELECT COUNT(*) FROM point_ledger WHERE operation_id = point_operations.operation_id) AS count
         FROM point_operations WHERE operation_id = ?`, "round:blitz-no-winners:resolve",
    ).one());

    expect(result).toMatchObject({ replayed: false, result: { answer: "LANTERN", winners: [], share: 0 } });
    expect(JSON.parse(operation.result_json)).toEqual(result.result);
    expect(operation.count).toBe(0);
  });

  it("runs the actual module from pool selection through both alarm-delivered lines [protects=post-open question writes reconcile and answer and result delivery complete; fails_when=templates stay unrendered or settlement fails; no_claim=only the external sendChat transport is mocked]", async () => {
    const channelId = `blitz-flow-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const worker = env as unknown as { DB: D1Database; CHANNEL: Env["CHANNEL"] };
    const settings = blitzRoundDefaultsForLanguage("en");
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(settings)).run();
    const repository = createBlitzQuestionRepository(worker.DB);
    await repository.create(channelId, { kind: "quiz", prompt: "Which star?", answers: ["Sun"], enabled: true }, new Date().toISOString());
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" }));
    await runPointObject(object, (target) => {
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(runtime);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
    });
    const points = modulePoints(worker.CHANNEL, channelId, "blitz_round");
    vi.spyOn(repository, "markUsed").mockRejectedValueOnce(new Error("fictional question write outage"));
    const opened = await openBlitzRound({ channelId, repository, points, settings, language: "en" });
    await expect(points.rounds.active()).resolves.toMatchObject({ state: "announcing", deadlineAt: null });
    await forcePointAlarm(object, opened.roundId);
    await expect(points.rounds.active()).resolves.toMatchObject({ state: "open", deadlineAt: Date.now() + 60_000 });
    expect(sendChat.mock.calls[0]?.[0]).toBe("Blitz round! Quiz: Which star? · First correct answers share 50. (60 s)");
    await processBlitzMessage({ channelId, subscriptionType: "channel.chat.message", triggerId: "fictional-trigger",
      receivedAt: new Date().toISOString(), actor: null, chatStatus: ["viewer"], settings,
      payload: { message_id: "fictional-answer", chatter_user_id: "viewer_one", chatter_user_login: "frostfern", message: { text: "S.un!!" } },
    }, { points, botUserId: () => Promise.resolve("fictional_bot") });
    await forcePointAlarm(object, opened.roundId, (_target, state) => {
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, opened.roundId);
    });
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]?.[0]).toBe("Correct: Sun · frostfern · +50 each");
    await expect(points.balance("viewer_one")).resolves.toBe(50);
    await expect(points.rounds.active()).resolves.toBeNull();
    expect((await repository.list(channelId, 1)).questions[0]?.lastUsedAt).toBe(opened.data.openedAt);
    const audits = await worker.DB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?")
      .bind(channelId, "blitz_round.started").first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it("retries failed preparation without claiming an unseen announcement [protects=formatter failure cannot begin answer time even after the send ambiguity window; fails_when=preparation failure is mistaken for an attempted chat send; no_claim=the formatter and external transport are deliberately fault-injected]", async () => {
    const channelId = `blitz-prepare-${crypto.randomUUID()}`;
    const roundId = "fictional-prepare";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, delivery: "delivered" as const }));
    const formatter = vi.spyOn(blitzRoundModule, "formatPointRoundAnnouncement")
      .mockRejectedValue(new Error("fictional template outage"));
    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, { durationS: 60, announceText: "Round starts", settlement: testSettlement });
      await deferPointAlarmWithin(state);
    });
    await forcePointAlarm(object, roundId);
    vi.setSystemTime(Date.now() + 60_000);
    await forcePointAlarm(object, roundId);
    const row = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      state: string; deadline_at: number | null; announce_attempts: number;
    }>("SELECT state, deadline_at, announce_attempts FROM game_rounds WHERE round_id = ?", roundId).one());
    expect(row).toEqual({ state: "announcing", deadline_at: null, announce_attempts: 0 });
    expect(sendChat).not.toHaveBeenCalled();
    formatter.mockResolvedValue({ text: "Prepared round starts" });
    await forcePointAlarm(object, roundId);
    expect(sendChat).toHaveBeenCalledOnce();
    await expect(object.activeGameRound("blitz_round")).resolves.toMatchObject({ state: "open", deadlineAt: Date.now() + 60_000 });
  });

  it("keeps pre-transport exceptions unopened across the ambiguity window [protects=only a persisted transport claim permits ambiguous opening; fails_when=a pre-send exception starts the answer clock on recovery; no_claim=the transport boundary is fault-injected without a Twitch request]", async () => {
    const channelId = `blitz-before-send-${crypto.randomUUID()}`;
    const roundId = "fictional-before-send";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.reject(new Error("fictional pre-send database outage")));
    vi.spyOn(blitzRoundModule, "formatPointRoundAnnouncement").mockResolvedValue({ text: "Round starts" });
    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, { durationS: 60, announceText: "Round starts", settlement: testSettlement });
      await deferPointAlarmWithin(state);
    });
    await forcePointAlarm(object, roundId);
    vi.setSystemTime(Date.now() + 60_000);
    await forcePointAlarm(object, roundId);
    expect(sendChat).toHaveBeenCalledTimes(2);
    await expect(object.activeGameRound("blitz_round")).resolves.toMatchObject({ state: "announcing", deadlineAt: null });
    await runPointObject(object, (target) => {
      stubPointRoundChat(target, () => Promise.resolve({ sent: true, delivery: "delivered" }));
    });
    await forcePointAlarm(object, roundId);
    await expect(object.activeGameRound("blitz_round")).resolves.toMatchObject({ state: "open", deadlineAt: Date.now() + 60_000 });
  });

  it.each(["sent", "sending"] as const)("recovers a %s transport claim at its actual timestamp [protects=confirmed sends open immediately and uncertain sends use the transport claim clock; fails_when=recovery waits after confirmation or anchors answer time to earlier preparation; no_claim=the persisted send receipt is a crash fixture without external transport]", async (status) => {
    const channelId = `blitz-claim-clock-${crypto.randomUUID()}`;
    const roundId = "fictional-claim-clock";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const claimAt = Date.now();
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, delivery: "delivered" as const }));
    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound(pointTestModule, roundId, { durationS: 60, announceText: "Round starts", settlement: testSettlement });
      state.storage.sql.exec("UPDATE game_rounds SET announce_attempts = 1, last_attempt_at = ? WHERE round_id = ?", claimAt - 60_000, roundId);
      state.storage.kv.put("module_alarm:send_claims", { [`round:${roundId}:announce`]: { status, at: claimAt } });
      await deferPointAlarmWithin(state);
    });
    await forcePointAlarm(object, roundId);
    if (status === "sending") {
      await expect(object.activeGameRound(pointTestModule)).resolves.toMatchObject({ state: "announcing", deadlineAt: null });
      vi.setSystemTime(claimAt + 31_000);
      await forcePointAlarm(object, roundId);
    }
    await expect(object.activeGameRound(pointTestModule)).resolves.toMatchObject({ state: "open", deadlineAt: claimAt + 60_000 });
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("preserves preparation reconciliation through a rapid disable and re-enable [protects=a pending preparation alarm survives re-enable cancellation and reconciles accepted start metadata after restart; fails_when=the re-enable cancellation clears the pending alarm before the question-use write and start audit are reconciled; no_claim=directly drives durable gate revisions without exercising the dashboard toggle endpoint]", async () => {
    const channelId = `blitz-cancel-prepare-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const worker = env as unknown as { DB: D1Database; CHANNEL: Env["CHANNEL"] };
    const settings = blitzRoundDefaultsForLanguage("en");
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(settings)).run();
    const repository = createBlitzQuestionRepository(worker.DB);
    await repository.create(channelId, { kind: "quiz", prompt: "Which star?", answers: ["Sun"], enabled: true }, new Date().toISOString());
    vi.spyOn(repository, "markUsed").mockRejectedValueOnce(new Error("fictional question write outage"));
    const object = blitzObject(pointObject(channelId));
    const points = modulePoints(worker.CHANNEL, channelId, "blitz_round");
    const opened = await openBlitzRound({ channelId, repository, points, settings, language: "en" });
    await worker.DB.prepare("UPDATE channel_modules SET enabled = 0, revision = 2 WHERE channel_id = ? AND module_id = 'blitz_round'")
      .bind(channelId).run();
    await points.rounds.setGate(true, 2);
    await worker.DB.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = 'blitz_round'")
      .bind(channelId).run();
    await points.rounds.setGate(false, 3, 2);
    const pending = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ state: string; prepare_state: string }>(
        "SELECT state, prepare_state FROM game_rounds WHERE round_id = ?", opened.roundId,
      ).one(),
      alarm: state.storage.kv.get<Record<string, { deadline: number }>>("channel:alarm_schedule")?.[`points:round:${opened.roundId}`] ?? null,
    }));
    expect(pending.round).toEqual({ state: "cancelled", prepare_state: "pending" });
    expect(pending.alarm).not.toBeNull();
    await evictDurableObject(object as unknown as DurableObjectStub);
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" }));
    await runPointObject(object, async (target, state) => {
      await target.getPanelResourceRevisions();
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(runtime);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
      await deferPointAlarmWithin(state);
    });
    await forcePointAlarm(object, opened.roundId);
    expect(sendChat).not.toHaveBeenCalled();
    expect((await repository.list(channelId, 1)).questions[0]?.lastUsedAt).toBe(opened.data.openedAt);
    const audit = await worker.DB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = 'blitz_round.started'")
      .bind(channelId).first<{ count: number }>();
    expect(audit?.count).toBe(1);
    await expect(points.rounds.active()).resolves.toBeNull();
  });

  it("recovers a booked but undelivered result after eviction without booking again [protects=restart recovery includes resolved rounds whose delivery intent remains pending; fails_when=an unrelated wake leaves the result alarm missing or recovery pays twice; no_claim=the external result send and module formatter are mocked]", async () => {
    const channelId = `blitz-recover-result-${crypto.randomUUID()}`;
    const roundId = "fictional-recovery";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await openAnnouncedRound(object, "blitz_round", roundId, { durationS: 60, announceText: "Round starts", answer: "CLOUD", settlement }, Date.now() + 60_000);
    await evictDurableObject(object as unknown as DurableObjectStub);
    await expect(object.activeGameRound("blitz_round")).resolves.toMatchObject({ roundId, state: "open", data: { answer: "CLOUD" } });
    await object.answerGameRound("blitz_round", roundId, "msg:recover", "viewer_one", "frostfern", 5);
    await object.resolveGameRound("blitz_round", roundId, settlement);
    await runPointObject(object, async (_target, state) => {
      await state.storage.deleteAlarm();
      const schedule = state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule") ?? {};
      Reflect.deleteProperty(schedule, `points:round:${roundId}`);
      state.storage.kv.put("channel:alarm_schedule", schedule);
    });
    await evictDurableObject(object as unknown as DurableObjectStub);
    await runPointObject(object, async (target, state) => {
      await target.getPanelResourceRevisions();
      const schedule = state.storage.kv.get<Record<string, { handler: string }>>("channel:alarm_schedule");
      expect(schedule?.[`points:round:${roundId}`]?.handler).toBe("host:points_round");
      await deferPointAlarmWithin(state);
      stubPointRoundChat(target, () => Promise.resolve({ sent: true, delivery: "delivered" }));
    });
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });
    await forcePointAlarm(object, roundId);
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
    const row = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ resolve_delivery_state: string; operation_count: number }>(
      `SELECT resolve_delivery_state, (SELECT COUNT(*) FROM point_operations WHERE operation_id = ?) AS operation_count
       FROM game_rounds WHERE round_id = ?`, `round:${roundId}:resolve`, roundId,
    ).one());
    expect(row).toEqual({ resolve_delivery_state: "delivered", operation_count: 1 });
  });

  it("retries the stored result line without booking the prize twice [protects=resolution delivery retries send the committed result while the ledger operation remains singular; fails_when=the stored line is not retried or the payout repeats; no_claim=sendChat is mocked]", async () => {
    const channelId = `blitz-delivery-${crypto.randomUUID()}`;
    const roundId = "blitz-delivery-retry";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    let sendAttempts = 0;
    const sendChat = vi.fn(() => {
      sendAttempts += 1;
      return Promise.resolve(sendAttempts === 1
        ? { sent: false, retryable: false, reason: "network_error", delivery: "failed" as const }
        : { sent: true, retryable: false, reason: null, delivery: "delivered" as const });
    });
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD · frostfern · +50 each" });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement: { kind: "blitz", params: { prize: 50 } },
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:result-winner", "viewer_one", "frostfern", 5);
      await deferPointAlarmWithin(state);
    });

    await object.resolveGameRound("blitz_round", roundId, { kind: "blitz", params: { prize: 50 } });
    await forcePointAlarm(object, roundId);
    const afterFirstAttempt = await runPointObject(object, (_target, state) => ({
      deliveryState: state.storage.sql.exec<{ resolve_delivery_state: string }>(
        "SELECT resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId,
      ).one().resolve_delivery_state,
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
    }));
    expect(afterFirstAttempt).toEqual({ deliveryState: "pending", operationCount: 1 });
    expect(sendChat).toHaveBeenCalledOnce();

    await forcePointAlarm(object, roundId);
    const afterRetry = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      resolve_delivery_state: string;
      resolve_delivery_attempts: number;
      operation_count: number;
    }>(
      `SELECT resolve_delivery_state, resolve_delivery_attempts,
              (SELECT COUNT(*) FROM point_operations WHERE operation_id = ?) AS operation_count
         FROM game_rounds WHERE round_id = ?`,
      `round:${roundId}:resolve`,
      roundId,
    ).one());

    expect(afterRetry).toEqual({ resolve_delivery_state: "delivered", resolve_delivery_attempts: 2, operation_count: 1 });
    expect(sendChat).toHaveBeenCalledTimes(2);
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });
});
