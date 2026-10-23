import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ModuleAlarmContext, ModuleAlarmPlan } from "../../src/modules/contract";
import { createBlitzQuestionRepository } from "../../src/modules/blitz_round/adapters/d1";
import { reconcileBlitzAutoStart } from "../../src/modules/blitz_round/auto-start";
import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";
import { loadBlitzAutoStartBaseline, openBlitzRound, processBlitzMessage } from "../../src/modules/blitz_round/service";
import { modulePoints } from "../../src/worker/module-points";
import { POINTS_ANNOUNCE_MAX_ATTEMPTS, POINTS_ANNOUNCE_RETRY_MS } from "../../src/worker/durable/points";
import { claimAutomatedChatOutput } from "../../src/worker/durable/automated-chat-output";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { sendChatMessage } from "../../src/worker/chat";
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
  getModuleAlarmPlan(moduleId: string, alarmKey: string): Promise<ModuleAlarmPlan | null>;
  answerGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    graceS: number,
    messageAt: number,
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
const testBlitzTokenEncryptionKeys = JSON.stringify({
  active: {
    id: "blitz-test-token-encryption",
    key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url"),
  },
  retired: [],
});
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

    const result = await object.answerGameRound(pointTestModule, "blitz-first", "msg:first", "viewer_one", "frostfern", 5, Date.now());
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
    await expect(object.answerGameRound(pointTestModule, "blitz-near-timeout", "msg:near", "viewer_one", "frostfern", 5, Date.now()))
      .resolves.toMatchObject({ status: "recorded", first: true });
    await expect(object.activeGameRound(pointTestModule)).resolves.toMatchObject({ deadlineAt: deadline });
  });

  it("cancels zero-stake answers on disable without a refund booking [protects=disabling closes free-entry rounds without creating escrow or refund movements; fails_when=cancellation fails on zero stakes or leaves a live round; no_claim=does not test the dashboard toggle request]", async () => {
    const channelId = `blitz-cancel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    await openAnswerRound(object, "blitz-cancel");
    await object.answerGameRound(pointTestModule, "blitz-cancel", "msg:cancel", "viewer_one", "frostfern", 5, Date.now());
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
      object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:one", "viewer_one", "frostfern", 5, Date.now()),
      object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:two", "viewer_two", "moonmoss", 5, Date.now()),
    ]);
    const replay = await object.answerGameRound(pointTestModule, "blitz-concurrent", "msg:one", "viewer_one", "frostfern", 5, Date.now());
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
    await object.answerGameRound(pointTestModule, "blitz-duplicate", "msg:first", "viewer_one", "frostfern", 5, Date.now());

    const second = await object.answerGameRound(pointTestModule, "blitz-duplicate", "msg:second", "viewer_one", "frostfern", 5, Date.now());
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
    await object.answerGameRound(pointTestModule, "blitz-closed", "msg:first", "viewer_one", "frostfern", 5, Date.now());
    await runPointObject(object, async (target, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, "blitz-closed");
      await deferPointAlarmWithin(state);
      void target;
    });

    const late = await object.answerGameRound(pointTestModule, "blitz-closed", "msg:late", "viewer_two", "moonmoss", 5, Date.now());
    const replay = await object.answerGameRound(pointTestModule, "blitz-closed", "msg:late", "viewer_two", "moonmoss", 5, Date.now());
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
    await object.answerGameRound("blitz_round", "blitz-settlement", "msg:first", "viewer_one", "frostfern", 5, Date.now());
    await object.answerGameRound("blitz_round", "blitz-settlement", "msg:second", "viewer_two", "moonmoss", 5, Date.now());

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

  it("keeps the committed interval when a resolution resumes after reading stale settings", async () => {
    const channelId = `blitz-settings-resolution-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const worker = env as unknown as { DB: D1Database; CHANNEL: Env["CHANNEL"] };
    const settings = { ...blitzRoundDefaultsForLanguage("en"), autoStart: true, autoStartIntervalMinutes: 15 };
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(settings)).run();
    await worker.DB.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'helix')")
      .bind(channelId, new Date().toISOString()).run();
    const repository = createBlitzQuestionRepository(worker.DB);
    await repository.create(channelId, { kind: "quiz", prompt: "Which star is nearest?", answers: ["Sun"], enabled: true }, new Date().toISOString());
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" }));
    let releaseResolution!: () => void;
    let resolutionReadConfig!: () => void;
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    const resolutionEntered = new Promise<void>((resolve) => { resolutionReadConfig = resolve; });
    let pauseResolution = false;
    await runPointObject(object, (target) => {
      stubPointRoundChat(target, sendChat);
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(runtime);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => {
        const context = original(...args);
        const registration = args[1] as { key?: string } | undefined;
        if (!pauseResolution || args[0] !== "blitz_round" || registration?.key !== "auto-start") return context;
        pauseResolution = false;
        let firstStreamRead = true;
        return {
          ...context,
          streamState: async () => {
            if (firstStreamRead) {
              firstStreamRead = false;
              resolutionReadConfig();
              await resolutionGate;
            }
            return context.streamState();
          },
        };
      });
    });
    const points = modulePoints(worker.CHANNEL, channelId, "blitz_round");
    const opened = await openBlitzRound({ channelId, autoStartBaseline: await loadBlitzAutoStartBaseline(worker.DB, channelId),
      repository, points, settings, language: "en" });
    await forcePointAlarm(object, opened.roundId);
    const savedSettings = { ...settings, autoStartIntervalMinutes: 30 };
    const registration = blitzRoundModule.alarms?.[0];
    if (registration === undefined) throw new Error("The Blitz automatic-start alarm is not registered.");
    await runPointObject(object, async (target, durableState) => {
      const runtime = target as unknown as {
        moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext;
        resolveGameRound: (moduleId: string, roundId: string, settlement: { kind: string; params: unknown }) => Promise<unknown>;
      };
      pauseResolution = true;
      const pendingResolution = runtime.resolveGameRound("blitz_round", opened.roundId, { kind: "blitz", params: { prize: 50 } });
      await resolutionEntered;
      const context = runtime.moduleAlarmContext("blitz_round", registration, undefined);
      await context.DB.prepare("UPDATE channel_modules SET settings = ?, revision = revision + 1, settings_revision = settings_revision + 1 WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(JSON.stringify(savedSettings), channelId).run();
      await reconcileBlitzAutoStart(context, "settings");
      releaseResolution();
      await pendingResolution;
      return durableState.storage.get<{ baseline: string; intervalMinutes: number; awaitingRoundId: string | null; deadlineAt: number }>(
        "module:blitz_round:storage:auto-start-state",
      );
    });

    const state = await runPointObject(object, (_target, durableState) =>
      durableState.storage.get<{ baseline: string; intervalMinutes: number; awaitingRoundId: string | null; deadlineAt: number }>(
        "module:blitz_round:storage:auto-start-state"));
    expect(state).toMatchObject({ baseline: "0:2", intervalMinutes: 30, awaitingRoundId: null });
    expect(state?.deadlineAt).toBeGreaterThan(Date.now() + 30 * 60_000 - 1_000);
    expect(state?.deadlineAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    const plan = await object.getModuleAlarmPlan("blitz_round", "auto-start");
    expect(plan).toMatchObject({
      identity: { triggerType: "interval", deadline: state?.deadlineAt },
    });
    expect(plan?.planSequence).toBeTypeOf("number");
  });

  it("rejects a matching message timestamped before the start line was delivered [protects=answers sent before the persisted announcement timestamp are recorded as round_closed without adding a participant; fails_when=a delayed pre-round EventSub message wins the open round; no_claim=sendChat delivery is mocked and EventSub signature verification is outside this module worker test]", async () => {
    const channelId = `blitz-pre-announcement-${crypto.randomUUID()}`;
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
    const opened = await openBlitzRound({ channelId, repository, points, settings, language: "en" });
    await forcePointAlarm(object, opened.roundId);

    await processBlitzMessage({ channelId, subscriptionType: "channel.chat.message", triggerId: "fictional-trigger",
      receivedAt: new Date().toISOString(), eventSubTimestamp: new Date(Date.now() - 5_000).toISOString(),
      actor: null, chatStatus: ["viewer"], settings,
      payload: { message_id: "fictional-pre-announcement-answer", chatter_user_id: "viewer_one", chatter_user_login: "frostfern", message: { text: "Sun" } },
    }, { points, botUserId: () => Promise.resolve("fictional_bot") });

    const answer = await runPointObject(object, (_target, state) => ({
      row: state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM game_round_answers WHERE operation_id = ?", "msg:fictional-pre-announcement-answer",
      ).toArray()[0] ?? null,
      participants: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?", opened.roundId,
      ).one().count,
    }));

    expect(answer).toEqual({ row: { status: "round_closed" }, participants: 0 });
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
    await object.answerGameRound("blitz_round", roundId, "msg:recover", "viewer_one", "frostfern", 5, Date.now());
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

  it("retries the stored result line after a transient rate limit without booking the prize twice [protects=resolution delivery retries a rate-limited committed result while the ledger operation remains singular; fails_when=the stored line is not retried or the payout repeats; no_claim=sendChat is mocked and no Twitch delivery is claimed]", async () => {
    const channelId = `blitz-delivery-${crypto.randomUUID()}`;
    const roundId = "blitz-delivery-retry";
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    let sendAttempts = 0;
    const sendChat = vi.fn(() => {
      sendAttempts += 1;
      return Promise.resolve(sendAttempts === 1
        ? { sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" as const }
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
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:result-winner", "viewer_one", "frostfern", 5, Date.now());
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

    vi.setSystemTime(Date.now() + POINTS_ANNOUNCE_RETRY_MS);
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

  it("retries the result after a transient bot identity lookup outage through the production adapter [protects=a retryable pre-transport identity outage keeps result delivery pending for one bounded retry and the committed result reaches chat once; fails_when=the outage marks delivery failed, consumes no retry attempt, leaves no alarm, or emits the result more than once; no_claim=uses the real ChannelObject and production module alarm chat adapter with a one-shot D1 identity lookup failure and mocked Helix fetch, without claiming Twitch delivery]", async () => {
    const channelId = `blitz-identity-outage-${crypto.randomUUID()}`;
    const roundId = "blitz-identity-outage";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    const worker = env as unknown as Env;
    await insertPointChannel(channelId);
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(blitzRoundDefaultsForLanguage("en"))).run();
    const now = new Date().toISOString();
    await upsertBotIdentity(worker.DB, {
      id: 1,
      userId: "test-bot-identity-outage",
      login: "brobot",
      scopesJson: "[]",
      accessTokenCiphertext: "unused-bot-token",
      refreshTokenCiphertext: "unused-bot-refresh-token",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    const appTokenCiphertext = await encryptJson(
      { token: "test-app-token" },
      parseKeyRing(testBlitzTokenEncryptionKeys),
    );
    await worker.DB.prepare(
      `INSERT INTO twitch_app_access_token (id, access_token_ciphertext, expires_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token_ciphertext = excluded.access_token_ciphertext,
         expires_at = excluded.expires_at, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).bind(appTokenCiphertext, new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(), now, now).run();

    let identityLookupOutageInjected = false;
    const flakyDatabase = new Proxy(worker.DB, {
      get(database, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (!identityLookupOutageInjected && query.includes("FROM bot_identity")) {
              return {
                first: () => {
                  identityLookupOutageInjected = true;
                  throw new Error("injected transient bot identity lookup outage");
                },
              } as unknown as D1PreparedStatement;
            }
            return database.prepare(query);
          };
        }
        return Reflect.get(database, property, database) as unknown;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "test-result-message" }],
    }), { status: 200 }));
    const productionChat: typeof sendChatMessage = (...args) => {
      const productionArgs = [...args] as Parameters<typeof sendChatMessage>;
      productionArgs[0] = {
        ...args[0],
        DB: flakyDatabase,
        TOKEN_ENCRYPTION_KEYS: testBlitzTokenEncryptionKeys,
      };
      productionArgs[4] = fetcher;
      return sendChatMessage(...productionArgs);
    };
    const object = blitzObject(pointObject(channelId));
    const formatResult = vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(target);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => {
        const productionArgs = [...args];
        while (productionArgs.length < 6) productionArgs.push(undefined);
        productionArgs.push(productionChat);
        return original(...productionArgs);
      });
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:identity-outage", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);

    const firstAttemptAt = Date.now();
    await forcePointAlarm(object, roundId);
    const afterOutage = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      alarm: state.storage.kv.get<Record<string, { deadline: number }>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
    }));

    expect(identityLookupOutageInjected).toBe(true);
    expect(afterOutage).toMatchObject({
      round: { resolve_delivery_state: "pending", resolve_delivery_attempts: 1 },
      alarm: { deadline: firstAttemptAt + POINTS_ANNOUNCE_RETRY_MS },
      operationCount: 1,
    });
    expect(fetcher).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + POINTS_ANNOUNCE_RETRY_MS);
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
    expect(fetcher).toHaveBeenCalledOnce();
    expect(formatResult).toHaveBeenCalledTimes(2);
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("retries a result after a formatter-side D1 failure without marking it delivered [protects=a formatting failure remains pending, consumes one bounded attempt, and the next alarm sends the committed result once; fails_when=delivery becomes delivered before transport, the retry is not sent once, or settlement is lost; no_claim=uses the real ChannelObject with an injected D1-style formatter rejection and mocked chat transport, without claiming Twitch delivery]", async () => {
    const channelId = `blitz-format-failure-${crypto.randomUUID()}`;
    const roundId = "blitz-format-failure";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" as const }));
    const formatResult = vi.spyOn(blitzRoundModule, "formatPointRoundResult")
      .mockRejectedValueOnce(new Error("injected_d1_failure_during_result_formatting"))
      .mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:format-failure", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);

    const failedAt = Date.now();
    await expect(forcePointAlarm(object, roundId)).resolves.toBe(true);
    const afterFailure = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ resolve_delivery_state: string; resolve_delivery_attempts: number; data_json: string }>(
        "SELECT resolve_delivery_state, resolve_delivery_attempts, data_json FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      settlement: (JSON.parse(state.storage.sql.exec<{ data_json: string }>(
        "SELECT data_json FROM game_rounds WHERE round_id = ?", roundId,
      ).one().data_json) as { settlement: unknown }).settlement,
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      alarm: state.storage.kv.get<Record<string, { deadline: number; handler: string; revision: number }>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));
    expect(afterFailure).toMatchObject({
      round: { resolve_delivery_state: "pending", resolve_delivery_attempts: 1 },
      settlement,
      operationCount: 1,
      alarm: { deadline: failedAt + POINTS_ANNOUNCE_RETRY_MS, handler: "host:points_round" },
    });
    expect(afterFailure.alarm?.revision).toBeGreaterThan(0);
    expect(sendChat).not.toHaveBeenCalled();

    vi.setSystemTime(failedAt + POINTS_ANNOUNCE_RETRY_MS);
    await forcePointAlarm(object, roundId);
    const afterRetry = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      resolve_delivery_state: string;
      resolve_delivery_attempts: number;
      operation_count: number;
    }>(
      `SELECT resolve_delivery_state, resolve_delivery_attempts,
              (SELECT COUNT(*) FROM point_operations WHERE operation_id = ?) AS operation_count
         FROM game_rounds WHERE round_id = ?`,
      `round:${roundId}:resolve`, roundId,
    ).one());

    expect(afterRetry).toEqual({ resolve_delivery_state: "delivered", resolve_delivery_attempts: 2, operation_count: 1 });
    expect(formatResult).toHaveBeenCalledTimes(2);
    expect(sendChat).toHaveBeenCalledOnce();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("retries stale result delivery when its transport claim is absent [protects=an expired sending row without a persisted transport claim returns to bounded retry and sends after recovery; fails_when=recovery marks the result delivered without a claim or settlement is lost; no_claim=uses the real ChannelObject with a manually persisted SQLite sending row, confirms the send through a mock, and creates no transport claim fixture]", async () => {
    const channelId = `blitz-result-no-claim-${crypto.randomUUID()}`;
    const roundId = "blitz-result-no-claim";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" as const }));
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:no-claim", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);
    await runPointObject(object, (_target, state) => {
      state.storage.sql.exec(
        `UPDATE game_rounds SET resolve_delivery_state = 'sending', resolve_delivery_attempts = 1,
                resolve_delivery_last_attempt_at = ? WHERE round_id = ?`,
        Date.now() - 60_000, roundId,
      );
    });

    const recoveredAt = Date.now();
    await forcePointAlarm(object, roundId);
    const afterRecovery = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      alarm: state.storage.kv.get<Record<string, { deadline: number }>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));
    expect(afterRecovery).toMatchObject({
      round: { resolve_delivery_state: "pending" },
      operationCount: 1,
      alarm: { deadline: recoveredAt + POINTS_ANNOUNCE_RETRY_MS, handler: "host:points_round" },
    });
    expect(sendChat).not.toHaveBeenCalled();

    vi.setSystemTime(recoveredAt + POINTS_ANNOUNCE_RETRY_MS);
    await forcePointAlarm(object, roundId);
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{
      resolve_delivery_state: string;
      resolve_delivery_attempts: number;
      operation_count: number;
    }>(
      `SELECT resolve_delivery_state, resolve_delivery_attempts,
              (SELECT COUNT(*) FROM point_operations WHERE operation_id = ?) AS operation_count
         FROM game_rounds WHERE round_id = ?`,
      `round:${roundId}:resolve`, roundId,
    ).one())).resolves.toEqual({ resolve_delivery_state: "delivered", resolve_delivery_attempts: 2, operation_count: 1 });
    expect(sendChat).toHaveBeenCalledOnce();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("treats only a stale persisted result transport claim as ambiguous delivery [protects=a persisted sending transport claim may complete stale result delivery while retaining settlement; fails_when=a stale row without a transport claim is treated as delivered or a claimed ambiguous send is duplicated; no_claim=uses a real ChannelObject and SQLite row with an explicit send-claim fixture and no second transport call]", async () => {
    const channelId = `blitz-result-stale-claim-${crypto.randomUUID()}`;
    const roundId = "blitz-result-stale-claim";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" as const }));
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:stale-claim", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);
    await runPointObject(object, (_target, state) => {
      const claimAt = Date.now() - 60_000;
      state.storage.sql.exec(
        `UPDATE game_rounds SET resolve_delivery_state = 'sending', resolve_delivery_attempts = 1,
                resolve_delivery_last_attempt_at = ? WHERE round_id = ?`,
        claimAt, roundId,
      );
      state.storage.kv.put("module_alarm:send_claims", {
        [`round:${roundId}:resolve`]: { status: "sending", at: claimAt },
      });
    });

    await forcePointAlarm(object, roundId);
    const recovered = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      alarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));
    expect(recovered).toEqual({
      round: { resolve_delivery_state: "delivered", resolve_delivery_attempts: 1 },
      operationCount: 1,
      alarm: null,
    });
    expect(sendChat).not.toHaveBeenCalled();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("parks a permanently rejected result after one attempt so competing automated output can proceed [protects=an AutoMod-style result rejection is parked with its settlement and alarm cleared so the next automated output can claim the shared allowance; fails_when=the result remains pending, retries, loses its settlement, retains an alarm, or blocks the next allowance claim; no_claim=uses a real ChannelObject and DO storage with a mocked chat transport and does not claim Twitch delivered either line]", async () => {
    const channelId = `blitz-permanent-result-${crypto.randomUUID()}`;
    const roundId = "blitz-permanent-result";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    let claimOutput: (() => Promise<boolean>) | null = null;
    const sendChat = vi.fn(async () => {
      if (claimOutput === null || !await claimOutput()) throw new Error("The first result did not claim the automated output allowance.");
      return { sent: false, retryable: false, reason: "automod_drop", delivery: "failed" as const };
    });
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      claimOutput = () => claimAutomatedChatOutput(state.storage, Date.now());
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:permanent-result", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);

    await forcePointAlarm(object, roundId);
    const parked = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ state: string; resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT state, resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      alarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));
    expect(parked).toEqual({
      round: { state: "resolved", resolve_delivery_state: "failed", resolve_delivery_attempts: 1 },
      operationCount: 1,
      alarm: null,
    });
    expect(sendChat).toHaveBeenCalledOnce();

    await runPointObject(object, async (_target, state) => state.storage.deleteAlarm());
    await object.resolveGameRound("blitz_round", roundId, settlement);
    const afterReplay = await runPointObject(object, async (_target, state) => ({
      round: state.storage.sql.exec<{ state: string; resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT state, resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      scheduledAlarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
      platformAlarm: await state.storage.getAlarm(),
    }));
    expect(afterReplay).toEqual({
      round: { state: "resolved", resolve_delivery_state: "failed", resolve_delivery_attempts: 1 },
      operationCount: 1,
      scheduledAlarm: null,
      platformAlarm: null,
    });
    expect(sendChat).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + POINTS_ANNOUNCE_RETRY_MS);
    await runPointObject(object, async (target) => {
      const internal = target as unknown as { handlePointRoundAlarm: (alarmKey: string, now: number) => Promise<void> };
      await internal.handlePointRoundAlarm(`points:round:${roundId}`, Date.now());
    });
    const competingOutputClaimed = await runPointObject(object, (_target, state) =>
      claimAutomatedChatOutput(state.storage, Date.now()));
    expect(competingOutputClaimed).toBe(true);
    expect(sendChat).toHaveBeenCalledOnce();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("backs off transient result failures and parks after six attempts [protects=rate-limited result sends retry at the shared five-second interval for at most six attempts while retaining settlement; fails_when=the retry deadline differs, a seventh attempt is possible, settlement changes, or the final alarm remains; no_claim=uses a real ChannelObject with mocked rate-limit responses and does not claim Twitch delivery]", async () => {
    const channelId = `blitz-transient-result-${crypto.randomUUID()}`;
    const roundId = "blitz-transient-result";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(() => Promise.resolve({
      sent: false,
      retryable: true,
      reason: "rate_limited",
      delivery: "rate_limited" as const,
    }));
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:transient-result", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);

    for (let attempt = 1; attempt <= POINTS_ANNOUNCE_MAX_ATTEMPTS; attempt += 1) {
      const attemptedAt = Date.now();
      await forcePointAlarm(object, roundId);
      const state = await runPointObject(object, (_target, durableState) => ({
        round: durableState.storage.sql.exec<{ resolve_delivery_state: string; resolve_delivery_attempts: number }>(
          "SELECT resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", roundId,
        ).one(),
        operationCount: durableState.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
        ).one().count,
        alarm: durableState.storage.kv.get<Record<string, { deadline: number }>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
      }));
      if (attempt < POINTS_ANNOUNCE_MAX_ATTEMPTS) {
        expect(state).toMatchObject({
          round: { resolve_delivery_state: "pending", resolve_delivery_attempts: attempt },
          operationCount: 1,
          alarm: { deadline: attemptedAt + POINTS_ANNOUNCE_RETRY_MS },
        });
        vi.setSystemTime(Date.now() + POINTS_ANNOUNCE_RETRY_MS);
      } else {
        expect(state).toEqual({
          round: { resolve_delivery_state: "failed", resolve_delivery_attempts: POINTS_ANNOUNCE_MAX_ATTEMPTS },
          operationCount: 1,
          alarm: null,
        });
      }
    }

    expect(sendChat).toHaveBeenCalledTimes(POINTS_ANNOUNCE_MAX_ATTEMPTS);
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("terminates result delivery suppressed by a disabled module [protects=a committed result suppressed while disabled is marked suppressed with no alarm and is never announced after re-enable; fails_when=the disabled result leaves a retry alarm or is announced after re-enable; no_claim=the persisted worker gate suppresses before transport while the settlement remains real]", async () => {
    const channelId = `blitz-disabled-result-${crypto.randomUUID()}`;
    const roundId = "blitz-disabled-result";
    const worker = env as unknown as { DB: D1Database };
    await insertPointChannel(channelId);
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(blitzRoundDefaultsForLanguage("en"))).run();
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn(async () => {
      const module = await worker.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(channelId).first<{ enabled: number }>();
      return module?.enabled === 1
        ? { sent: true, retryable: false, reason: null, delivery: "delivered" as const }
        : { sent: false, retryable: false, reason: "module_disabled", delivery: "failed" as const };
    });
    const formatResult = vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });
    const settlement = { kind: "blitz", params: { prize: 50 } };

    await runPointObject(object, async (target, state) => {
      stubPointRoundChat(target, sendChat);
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:disabled-result", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });

    await object.resolveGameRound("blitz_round", roundId, settlement);
    await worker.DB.prepare("UPDATE channel_modules SET enabled = 0, revision = 2 WHERE channel_id = ? AND module_id = 'blitz_round'")
      .bind(channelId).run();
    await forcePointAlarm(object, roundId);

    const afterSuppression = await runPointObject(object, (_target, state) => ({
      deliveryState: state.storage.sql.exec<{ resolve_delivery_state: string }>(
        "SELECT resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId,
      ).one().resolve_delivery_state,
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      roundAlarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));
    expect(afterSuppression).toEqual({ deliveryState: "suppressed", operationCount: 1, roundAlarm: null });
    expect(sendChat).not.toHaveBeenCalled();

    await worker.DB.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = 'blitz_round'")
      .bind(channelId).run();
    await evictDurableObject(object as unknown as DurableObjectStub);
    await object.getPanelResourceRevisions();
    const afterReEnable = await runPointObject(object, (_target, state) => ({
      deliveryState: state.storage.sql.exec<{ resolve_delivery_state: string }>(
        "SELECT resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId,
      ).one().resolve_delivery_state,
      roundAlarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));

    expect(afterReEnable).toEqual({ deliveryState: "suppressed", roundAlarm: null });
    expect(formatResult).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("reconciles D1 activation before result delivery after formatting [protects=D1 last_disabled_revision is reconciled after result formatting while the real DO retains the resolved round and settlement; fails_when=the stale result reaches chat or delivery remains pending or delivered after disable revision 2 and re-enable revision 3; no_claim=uses real D1 and ChannelObject with activation toggles inside the awaited formatter and a mocked chat transport]", async () => {
    const channelId = `blitz-stale-result-${crypto.randomUUID()}`;
    const roundId = "blitz-stale-result";
    const worker = env as unknown as { DB: D1Database };
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(blitzRoundDefaultsForLanguage("en"))).run();
    const object = blitzObject(pointObject(channelId));
    const postedTexts: string[] = [];
    const formatResult = vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockImplementation(async (context) => {
      await context.DB.prepare("UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(channelId).run();
      await context.DB.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(channelId).run();
      return { text: "Correct: CLOUD" };
    });
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(async (text, _idempotencyKey, _attributions, stillValid) => {
      if (stillValid !== undefined && !await stillValid()) {
        return { sent: false, retryable: false, reason: "module_disabled", delivery: "failed" };
      }
      postedTexts.push(text);
      return { sent: true, retryable: false, reason: null, delivery: "delivered" };
    });

    await runPointObject(object, async (target, state) => {
      await target.setGameModuleGate("blitz_round", false, 1);
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(target);
      Object.assign(target, {
        moduleAlarmContext: (...args: unknown[]) => ({ ...original(...args), sendChat }),
      });
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:stale-result", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });
    await object.resolveGameRound("blitz_round", roundId, settlement);

    await forcePointAlarm(object, roundId);

    const finalState = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ gate_revision: number; state: string; resolve_delivery_state: string }>(
        "SELECT gate_revision, state, resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId,
      ).one(),
      gate: state.storage.sql.exec<{ closed: number; revision: number; last_disabled_revision: number }>(
        "SELECT closed, revision, last_disabled_revision FROM module_gates WHERE module_id = 'blitz_round'",
      ).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      alarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
    }));

    expect(finalState).toEqual({
      round: { gate_revision: 1, state: "resolved", resolve_delivery_state: "suppressed" },
      gate: { closed: 0, revision: 3, last_disabled_revision: 2 },
      operationCount: 1,
      alarm: null,
    });
    expect(postedTexts).toEqual([]);
    expect(sendChat).toHaveBeenCalledOnce();
    expect(formatResult).toHaveBeenCalledOnce();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });

  it("opens Blitz after the re-enable gate RPC fails [protects=round start reconciles enabled revision 3 and last_disabled_revision 2 from D1 after its gate RPC fails with no active rounds; fails_when=the stale closed revision-2 gate rejects the start or remains closed; no_claim=the injected RPC failure is local to a real ChannelObject method in the worker harness rather than a transport outage]", async () => {
    const channelId = `blitz-reenable-start-${crypto.randomUUID()}`;
    const worker = env as unknown as { DB: D1Database };
    await insertPointChannel(channelId);
    await worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)")
      .bind(channelId, JSON.stringify(blitzRoundDefaultsForLanguage("en"))).run();
    const object = blitzObject(pointObject(channelId));
    const roundData = {
      durationS: 60,
      announceText: "Blitz round starts",
      settlement: { kind: "blitz", params: { prize: 50 } },
    };

    await runPointObject(object, async (target) => {
      await target.setGameModuleGate("blitz_round", false, 1);
      await target.setGameModuleGate("blitz_round", true, 2, 2);
      await worker.DB.prepare("UPDATE channel_modules SET enabled = 0, revision = 2, last_disabled_revision = 2 WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(channelId).run();
      await worker.DB.prepare("UPDATE channel_modules SET enabled = 1, revision = 3 WHERE channel_id = ? AND module_id = 'blitz_round'")
        .bind(channelId).run();

      const gateRpc = vi.spyOn(target, "setGameModuleGate").mockRejectedValueOnce(new Error("injected_gate_rpc_failure"));
      await expect(target.setGameModuleGate("blitz_round", false, 3, 2)).rejects.toThrow("injected_gate_rpc_failure");
      gateRpc.mockRestore();

      await target.openGameRound("blitz_round", "blitz-reenabled", roundData);
    });

    await expect(object.activeGameRound("blitz_round")).resolves.toMatchObject({ roundId: "blitz-reenabled", state: "announcing" });
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ closed: number; revision: number; last_disabled_revision: number }>(
      "SELECT closed, revision, last_disabled_revision FROM module_gates WHERE module_id = 'blitz_round'",
    ).one())).resolves.toEqual({ closed: 0, revision: 3, last_disabled_revision: 2 });
  });

  it("suppresses a pending result across a rapid disable and re-enable [protects=disable revision 2 terminates retries for a round opened at revision 1 while retaining its single settlement; fails_when=re-enable revives the stale result announcement, leaves its alarm scheduled, or changes the committed payout; no_claim=gate revisions and sendChat are driven through a real ChannelObject with mocked transport]", async () => {
    const channelId = `blitz-disable-result-${crypto.randomUUID()}`;
    const roundId = "blitz-disabled-result-retry";
    const settlement = { kind: "blitz", params: { prize: 50 } };
    await insertPointChannel(channelId);
    const object = blitzObject(pointObject(channelId));
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>()
      .mockResolvedValueOnce({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" })
      .mockResolvedValue({ sent: true, retryable: false, reason: null, delivery: "delivered" });
    vi.spyOn(blitzRoundModule, "formatPointRoundResult").mockResolvedValue({ text: "Correct: CLOUD" });

    await runPointObject(object, async (target, state) => {
      await target.setGameModuleGate("blitz_round", false, 1);
      stubPointRoundChat(target, () => sendChat("fictional result", "fictional-result-key"));
      await target.openGameRound("blitz_round", roundId, {
        durationS: 60,
        announceText: "Blitz round starts",
        answer: "CLOUD",
        settlement,
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 60_000, `round:${roundId}`);
      await blitzObject(target).answerGameRound("blitz_round", roundId, "msg:disable-result-retry", "viewer_one", "frostfern", 5, Date.now());
      await deferPointAlarmWithin(state);
    });

    await object.resolveGameRound("blitz_round", roundId, settlement);
    await forcePointAlarm(object, roundId);
    expect(sendChat).toHaveBeenCalledOnce();
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);

    await object.setGameModuleGate("blitz_round", true, 2);
    await object.setGameModuleGate("blitz_round", false, 3, 2);
    const suppressed = await runPointObject(object, async (_target, state) => ({
      round: state.storage.sql.exec<{
        gate_revision: number;
        state: string;
        resolve_delivery_state: string;
      }>("SELECT gate_revision, state, resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId).one(),
      operationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${roundId}:resolve`,
      ).one().count,
      scheduledAlarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
      platformAlarm: await state.storage.getAlarm(),
    }));

    expect(suppressed).toEqual({
      round: { gate_revision: 1, state: "resolved", resolve_delivery_state: "suppressed" },
      operationCount: 1,
      scheduledAlarm: null,
      platformAlarm: null,
    });
    expect(sendChat).toHaveBeenCalledOnce();
    await object.resolveGameRound("blitz_round", roundId, settlement);
    const afterReplay = await runPointObject(object, async (_target, state) => ({
      deliveryState: state.storage.sql.exec<{ resolve_delivery_state: string }>(
        "SELECT resolve_delivery_state FROM game_rounds WHERE round_id = ?", roundId,
      ).one().resolve_delivery_state,
      scheduledAlarm: state.storage.kv.get<Record<string, unknown>>("channel:alarm_schedule")?.[`points:round:${roundId}`] ?? null,
      platformAlarm: await state.storage.getAlarm(),
    }));
    expect(afterReplay).toEqual({ deliveryState: "suppressed", scheduledAlarm: null, platformAlarm: null });
    await expect(object.pointBalance("blitz_round", "viewer_one")).resolves.toBe(50);
  });
});
