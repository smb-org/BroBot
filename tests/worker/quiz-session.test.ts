import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSendResult, sendChatMessage } from "../../src/worker/chat";

type HostChatSender = (...args: Parameters<typeof sendChatMessage>) => Promise<ChatSendResult>;
const hostChatMock = vi.hoisted(() => ({ send: vi.fn<HostChatSender>() }));

vi.mock("../../src/worker/chat", () => ({
  sendChatMessage: (...args: Parameters<typeof sendChatMessage>) => hostChatMock.send(...args),
}));

import { quizModule } from "../../src/modules/quiz";
import type { ModuleAlarmContext } from "../../src/modules/contract";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { isModuleOverlayRealtimeEnvelope } from "../../src/realtime-contract";
import {
  clearPointObjectAlarms,
  capturePointError,
  deferPointAlarmWithin,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
  scheduleAlarmKeyWithin,
} from "./points-test-helpers";

const worker = env as unknown as Env;

const session = (roundId: string) => ({
  durationS: 30,
  announceText: "",
  silentAnnouncement: true,
  settlement: { kind: "quiz", params: {} },
  sessionId: roundId,
  resolveOperationId: `quiz:${roundId}:resolve`,
  language: "en",
  setId: "set-1",
  setName: "Example",
  pot: 10,
  phase: "open",
  questionIndex: 0,
  paused: false,
  remainingMs: null,
  phaseEndsAt: Date.now() + 30_000,
  phaseOpenedAt: Date.now(),
  pauseIntervals: [],
  chatQuestions: false,
  answerSeconds: 30,
  revealSeconds: 8,
  questions: [{ text: "Capital?", options: ["A", "B"], correctIndex: 1 }],
});

const openAnnouncedQuiz = async (object: ReturnType<typeof pointObject>, roundId: string, data: unknown): Promise<void> => {
  await runPointObject(object, async (target, state) => {
    await target.openGameRound("quiz", roundId, data);
    await target.markGameRoundAnnounced("quiz", roundId, Date.now() + 30_000, `round:${roundId}`);
    await deferPointAlarmWithin(state);
  });
};

const quizAlarmContext = (object: ReturnType<typeof pointObject>): ModuleAlarmContext => {
  const registration = quizModule.alarms?.find(({ key }) => key === "session-control");
  if (registration === undefined) throw new Error("Quiz session alarm is unavailable.");
  const runtime = object as unknown as {
    moduleAlarmContext: (moduleId: string, alarm: NonNullable<typeof quizModule.alarms>[number]) => ModuleAlarmContext;
  };
  return runtime.moduleAlarmContext("quiz", registration);
};

const quizStreamEvent = (
  channelId: string,
  state: "online" | "offline",
  timestamp: string,
): Parameters<NonNullable<typeof quizModule.handleEvent>>[0] => ({
  channelId,
  subscriptionType: state === "online" ? "stream.online" : "stream.offline",
  triggerId: crypto.randomUUID(),
  payload: {},
  settings: quizModule.defaultSettings,
  receivedAt: timestamp,
  eventSubTimestamp: timestamp,
  actor: null,
  chatStatus: null,
});

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
  hostChatMock.send.mockReset();
  hostChatMock.send.mockImplementation(() => Promise.resolve({
    sent: true,
    truncated: false,
    delivery: "sent",
    reason: null,
    detail: {},
  }));
});
afterEach(async () => {
  try { await clearPointObjectAlarms(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); hostChatMock.send.mockReset(); }
});

describe("quiz answers in the shared point round", () => {
  it("replaces a viewer's answer idempotently and deletes answer data after settlement", async () => {
    const channelId = `quiz-answer-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const openedAt = Date.now();

    await runPointObject(object, async (target, state) => {
      await target.openGameRound("quiz", roundId, session(roundId));
      await target.markGameRoundAnnounced("quiz", roundId, openedAt + 30_000, `round:${roundId}`);
      await deferPointAlarmWithin(state);
    });

    await expect(object.answerGameRoundChoice("quiz", roundId, `quiz:${roundId}:q0:message-1`,
      "viewer_one", "moonmoss", 0, 0, openedAt + 1_000)).resolves.toEqual({ status: "recorded", replayed: false });
    await expect(object.answerGameRoundChoice("quiz", roundId, `quiz:${roundId}:q0:message-2`,
      "viewer_one", "moonmoss", 0, 1, openedAt + 2_000)).resolves.toEqual({ status: "recorded", replayed: false });
    await expect(object.answerGameRoundChoice("quiz", roundId, `quiz:${roundId}:q0:message-2`,
      "viewer_one", "moonmoss", 0, 1, openedAt + 2_000)).resolves.toEqual({ status: "recorded", replayed: true });
    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toEqual([
      { accountId: "viewer_one", login: "moonmoss", stake: 0, data: { answers: [1], answerTimes: [openedAt + 2_000] } },
    ]);

    await object.resolveGameRound("quiz", roundId, { kind: "quiz", params: {} });

    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toEqual([
      { accountId: "viewer_one", login: "moonmoss", stake: 0, data: {} },
    ]);
  });

  it("dispatches a chat answer and runs reveal and settlement through the shared alarms", async () => {
    const channelId = "quiz-flow-" + crypto.randomUUID();
    const roundId = "quiz-" + crypto.randomUUID();
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, ?, 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, JSON.stringify({ ...pointsDefaultSettingsForLanguage("en"), startBonus: 0, activityAmount: 0 }),
      channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: false })).run();
    await worker.DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
    const overlayId = "overlay-" + roundId;
    await worker.DB.prepare(
      "INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at) VALUES (?, ?, 'Quiz overlay', ?, ?)",
    ).bind(overlayId, channelId, new Date(openedAt).toISOString(), new Date(openedAt).toISOString()).run();
    await worker.DB.prepare(
      "INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind) VALUES (?, ?, ?, 'quiz.session')",
    ).bind("element-" + roundId, channelId, overlayId).run();

    const object = pointObject(channelId);
    const accountId = "quiz_viewer";
    await object.touchPointAccount("points", accountId, "moonmoss", 0);

    const answerSpy = vi.spyOn(ChannelObject.prototype, "answerGameRoundChoice");
    const publishSpy = vi.spyOn(ChannelObject.prototype, "publish");
    await runPointObject(object, async (target, state) => {
      await target.openGameRound("quiz", roundId, { ...session(roundId), phase: "announce" });
      await deferPointAlarmWithin(state);
    });

    await forcePointAlarm(object, roundId);
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { phase: "open" } });
    const messageId = "quiz-message-" + crypto.randomUUID();
    const timestamp = new Date(openedAt + 1_000).toISOString();
    await dispatchEventSubNotification(worker, {
      channelId,
      subscriptionType: "channel.chat.message",
      triggerId: messageId,
      payload: {
        broadcaster_user_id: channelId,
        broadcaster_user_login: channelId,
        chatter_user_id: accountId,
        chatter_user_login: "moonmoss",
        message_id: messageId,
        message: { text: "2", fragments: [{ type: "text", text: "2" }] },
        badges: [],
      },
      receivedAt: timestamp,
      eventSubTimestamp: timestamp,
    }, vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))), [quizModule]);

    expect(answerSpy).toHaveBeenCalledWith("quiz", roundId, "quiz:" + roundId + ":q0:message:" + messageId,
      accountId, "moonmoss", 0, 1, openedAt + 1_000);
    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toMatchObject([
      { accountId, data: { answers: [1] } },
    ]);

    vi.setSystemTime(openedAt + 30_000);
    await forcePointAlarm(object, roundId);
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { phase: "reveal", aggregates: { answerDistribution: [[0, 1]] } } });

    vi.setSystemTime(openedAt + 38_000);
    await forcePointAlarm(object, roundId);
    await expect(object.activeGameRound("quiz")).resolves.toBeNull();
    await expect(object.pointBalance("quiz", accountId)).resolves.toBe(10);
    await expect(object.pointHistory("quiz", accountId)).resolves.toMatchObject({ rows: [
      { operationId: "quiz:" + roundId + ":resolve", kind: "resolve", delta: 10 },
    ] });
    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toEqual([
      { accountId, login: "moonmoss", stake: 0, data: {} },
    ]);

    const quizEvents = publishSpy.mock.calls.flatMap(([messages]) => messages)
      .filter(isModuleOverlayRealtimeEnvelope)
      .filter((message) => message.type.startsWith("modul.quiz."));
    // The resolved hook runs once on resolve and again when the result delivery starts, so results may repeat.
    const quizEventTypes: string[] = quizEvents.map((message) => message.type);
    expect(quizEventTypes.slice(0, 4)).toEqual([
      "modul.quiz.phase", "modul.quiz.phase", "modul.quiz.phase", "modul.quiz.results",
    ]);
    expect(quizEventTypes.slice(4).every((type) => type === "modul.quiz.results")).toBe(true);
    expect(quizEvents[2]?.payload).toMatchObject({ phase: "reveal", correctIndex: 1, answerDistribution: [0, 1] });
    expect(quizEvents[3]?.payload).toMatchObject({ phase: "results", ranking: [{ login: "moonmoss", correct: 1, payout: 10 }] });
  });

  it.each(["end", "next"] as const)("settles the final reveal with %s and releases later lifecycle work", async (action) => {
    const channelId = `quiz-settle-${action}-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(Date.now()).toISOString()).run();
    const object = pointObject(channelId);
    const resolveSpy = vi.spyOn(ChannelObject.prototype, "resolveGameRound");
    await openAnnouncedQuiz(object, roundId, {
      ...session(roundId),
      phase: "reveal",
      phaseEndsAt: Date.now(),
    });

    await expect(object.runModuleAlarm("quiz", "session-control", roundId, { action })).resolves.toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledOnce();
    await expect(object.activeGameRound("quiz")).resolves.toBeNull();

    const nextRoundId = `quiz-${crypto.randomUUID()}`;
    await openAnnouncedQuiz(object, nextRoundId, session(nextRoundId));
    await expect(object.runModuleAlarm("quiz", "session-control", nextRoundId, { action: "pause" })).resolves.toBeUndefined();
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true } });
  });

  it("keeps a results deadline armed until settlement commits", async () => {
    const channelId = `quiz-recovery-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    vi.spyOn(ChannelObject.prototype, "resolveGameRound").mockResolvedValueOnce({
      replayed: false,
      result: {},
      balances: {},
    });

    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "end" });
    const retry = await object.activeGameRound("quiz");
    expect(retry).toMatchObject({ data: { phase: "results" } });
    expect(retry?.deadlineAt).toBe(Date.now() + 5_000);

    vi.setSystemTime(Date.now() + 5_000);
    await forcePointAlarm(object, roundId);

    await expect(object.activeGameRound("quiz")).resolves.toBeNull();
    await expect(object.recentlyResolvedGameRound("quiz", 60_000)).resolves.toMatchObject({
      roundId,
      data: { phase: "results" },
    });
  });

  it("preserves a failed results settlement retry deadline across stream changes and Pause", async () => {
    const channelId = `quiz-results-stream-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt).toISOString()).run();
    const object = pointObject(channelId);
    const resolveSpy = vi.spyOn(ChannelObject.prototype, "resolveGameRound").mockRejectedValueOnce(new Error("settlement failed"));
    await openAnnouncedQuiz(object, roundId, session(roundId));

    await expect(capturePointError(object, (target) => target.runModuleAlarm("quiz", "session-control", roundId, { action: "end" })))
      .resolves.toBe("settlement failed");
    const retryAt = (await object.activeGameRound("quiz"))?.deadlineAt;
    expect(retryAt).toBe(openedAt + 5_000);

    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'eventsub' WHERE channel_id = ?",
    ).bind(new Date(openedAt + 1_000).toISOString(), channelId).run();
    await object.runModuleAlarm("quiz", "session-control", "stream-state");
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { phase: "results" }, deadlineAt: retryAt });

    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'online', changed_at = ?, source = 'eventsub' WHERE channel_id = ?",
    ).bind(new Date(openedAt + 2_000).toISOString(), channelId).run();
    await object.runModuleAlarm("quiz", "session-control", "stream-state");
    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "pause" });
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { phase: "results" }, deadlineAt: retryAt });

    vi.setSystemTime(retryAt as number);
    await forcePointAlarm(object, roundId);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    await expect(object.activeGameRound("quiz")).resolves.toBeNull();
  });

  it("serializes a deadline announcement before Pause so its continuation cannot undo the pause", async () => {
    const channelId = `quiz-pause-race-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: true })).run();
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    let releaseDelivery!: () => void;
    let reportDeliveryStarted!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStarted = new Promise<void>((resolve) => { reportDeliveryStarted = resolve; });
    hostChatMock.send.mockImplementation(async (...args) => {
      const validateOutput = args[5];
      const claimBeforePost = args[6];
      const afterPost = args[8];
      if (validateOutput === undefined || claimBeforePost === undefined || afterPost === undefined) {
        throw new Error("Quiz question send omitted its delivery guards.");
      }
      if (!await validateOutput()) return { sent: false, truncated: false, delivery: "not_attempted", reason: "stale_before_send", detail: {} };
      if (await claimBeforePost() !== true) return { sent: false, truncated: false, delivery: "not_attempted", reason: "already_attempted", detail: {} };
      if (args[2].includes("Second question")) {
        reportDeliveryStarted();
        await deliveryGate;
      }
      await afterPost("sent", null);
      return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
    });
    const data = {
      ...session(roundId),
      chatQuestions: true,
      questions: [
        { text: "First question", options: ["A", "B"], correctIndex: 0 },
        { text: "Second question", options: ["A", "B"], correctIndex: 1 },
      ],
    };
    await openAnnouncedQuiz(object, roundId, data);

    vi.setSystemTime(openedAt + 30_000);
    await forcePointAlarm(object, roundId);
    vi.setSystemTime(openedAt + 38_000);
    await runPointObject(object, async (target, state) => {
      await scheduleAlarmKeyWithin(state, `points:round:${roundId}`);
      const deadline = target.alarm();
      await deliveryStarted;
      const pause = target.runModuleAlarm("quiz", "session-control", roundId, { action: "pause" });
      releaseDelivery();
      await Promise.all([deadline, pause]);
    });

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({
      data: { phase: "open", questionIndex: 1, paused: true, remainingMs: 30_000 },
    });
  });

  it("pauses on stream offline, stays paused after stream online, and resumes only on operator action", async () => {
    const channelId = `quiz-stream-state-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: false })).run();
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at) VALUES (?, 'online', ?, 'eventsub', 'stream-one', ?)",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString(), new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    vi.setSystemTime(openedAt + 5_000);
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'eventsub' WHERE channel_id = ?",
    ).bind(new Date(Date.now()).toISOString(), channelId).run();
    await object.runModuleAlarm("quiz", "session-control", "stream-state");
    const paused = await object.activeGameRound("quiz");
    expect(paused).toMatchObject({ data: { paused: true, remainingMs: 25_000, offlineSince: Date.now() } });

    await expect(capturePointError(object, (target) => target.runModuleAlarm("quiz", "session-control", roundId, { action: "resume" })))
      .resolves.toBe("stream_offline");
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true, offlineSince: Date.now() } });

    vi.setSystemTime(openedAt + 20_000);
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'online', changed_at = ?, source = 'eventsub', stream_id = 'stream-two', started_at = ? WHERE channel_id = ?",
    ).bind(new Date(Date.now()).toISOString(), new Date(Date.now()).toISOString(), channelId).run();
    await object.runModuleAlarm("quiz", "session-control", "stream-state");

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true, offlineSince: null } });
    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "resume" });
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: false } });
  });

  it("preserves queued offline and online transitions so the session still needs Resume", async () => {
    const channelId = `quiz-queued-stream-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = new Date(openedAt + 1_000).toISOString();
    const onlineAt = new Date(openedAt + 2_000).toISOString();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: false })).run();
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));

    const queuedInvocations: unknown[] = [];
    const eventContext = {
      streamStateTransitionAccepted: true,
      runModuleAlarm: (_handler: string, _key: string, invocation?: unknown) => {
        queuedInvocations.push(invocation);
        return Promise.resolve();
      },
    } as Parameters<NonNullable<typeof quizModule.handleEvent>>[1];
    await quizModule.handleEvent?.(quizStreamEvent(channelId, "offline", offlineAt), eventContext);
    await quizModule.handleEvent?.(quizStreamEvent(channelId, "online", onlineAt), eventContext);
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'online', changed_at = ?, source = 'eventsub' WHERE channel_id = ?",
    ).bind(onlineAt, channelId).run();

    for (const invocation of queuedInvocations) {
      await object.runModuleAlarm("quiz", "session-control", "stream-state", invocation);
    }

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({
      data: { phase: "open", paused: true, offlineSince: null, phaseEndsAt: null },
    });
    expect(queuedInvocations).toEqual([
      { streamSnapshot: { state: "offline", since: Date.parse(offlineAt) } },
      { streamSnapshot: { state: "online", since: Date.parse(onlineAt) } },
    ]);
  });

  it("reconciles a Helix-only offline observation and arms settlement", async () => {
    const channelId = `quiz-helix-offline-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = openedAt + 5_000;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'helix' WHERE channel_id = ?",
    ).bind(new Date(offlineAt).toISOString(), channelId).run();

    const registration = quizModule.alarms?.find(({ key }) => key === "session-control");
    const settlementDeadline = await runPointObject(object, async (target) => {
      const context = quizAlarmContext(target);
      await registration?.onScheduleInputsChanged?.(context, "stream_state");
      return context.getAlarmDeadline?.(`offline-timeout:${roundId}`);
    });

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({
      data: { paused: true, offlineSince: offlineAt },
    });
    expect(settlementDeadline).toBe(offlineAt + 10 * 60_000);
  });

  it("reconciles an offline observation before rejecting a quiz control", async () => {
    const channelId = `quiz-control-offline-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = openedAt + 4_000;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'helix' WHERE channel_id = ?",
    ).bind(new Date(offlineAt).toISOString(), channelId).run();

    await expect(capturePointError(object, (target) => target.runModuleAlarm("quiz", "session-control", roundId, { action: "next" })))
      .resolves.toBe("stream_offline");

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true, offlineSince: offlineAt } });
    await expect(quizAlarmContext(object).getAlarmDeadline?.(`offline-timeout:${roundId}`)).resolves.toBe(offlineAt + 10 * 60_000);
  });

  it("reconciles offline state before advancing a due quiz deadline", async () => {
    const channelId = `quiz-deadline-offline-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = openedAt + 25_000;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'helix' WHERE channel_id = ?",
    ).bind(new Date(offlineAt).toISOString(), channelId).run();
    vi.setSystemTime(openedAt + 30_000);

    await forcePointAlarm(object, roundId);

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({
      data: { phase: "open", paused: true, remainingMs: 5_000, offlineSince: offlineAt },
    });
  });

  it("arms offline recovery before publishing the pause update", async () => {
    const channelId = `quiz-publish-recovery-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = openedAt + 5_000;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'helix' WHERE channel_id = ?",
    ).bind(new Date(offlineAt).toISOString(), channelId).run();
    const registration = quizModule.alarms?.find(({ key }) => key === "session-control");
    if (registration === undefined) throw new Error("Quiz session alarm is unavailable.");
    await expect(runPointObject(object, async (target) => {
      const context = quizAlarmContext(target);
      vi.spyOn(context, "publishModuleOverlayMessage").mockRejectedValueOnce(new Error("overlay publish failed"));
      const result = await registration.handle(context, "stream-state", Date.now());
      return result;
    })).rejects.toThrow("overlay publish failed");

    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true, offlineSince: offlineAt } });
    const settlementDeadline = await runPointObject(object, (target) =>
      quizAlarmContext(target).getAlarmDeadline?.(`offline-timeout:${roundId}`));
    expect(settlementDeadline).toBe(offlineAt + 10 * 60_000);
  });

  it("rejects Next while paused until the operator resumes the session", async () => {
    const channelId = `quiz-next-paused-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(Date.now()).toISOString()).run();
    const object = pointObject(channelId);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "pause" });

    await expect(capturePointError(object, (target) => target.runModuleAlarm("quiz", "session-control", roundId, { action: "next" })))
      .resolves.toBe("quiz_session_paused");
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { phase: "open", paused: true } });
  });

  it("rejects delayed chat answers timestamped during a pause and after the resumed deadline", async () => {
    const channelId = `quiz-answer-pause-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: false })).run();
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id, started_at) VALUES (?, 'online', ?, 'eventsub', 'stream-one', ?)",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString(), new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    const accountId = "quiz_pause_viewer";
    await object.touchPointAccount("points", accountId, "moonmoss", 0);
    const answerSpy = vi.spyOn(ChannelObject.prototype, "answerGameRoundChoice");
    await openAnnouncedQuiz(object, roundId, {
      ...session(roundId),
      phaseOpenedAt: openedAt,
      phaseEndsAt: openedAt + 30_000,
    });

    vi.setSystemTime(openedAt + 5_000);
    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "pause" });
    vi.setSystemTime(openedAt + 20_000);
    await object.runModuleAlarm("quiz", "session-control", roundId, { action: "resume" });

    const dispatchAnswer = async (messageId: string, messageAt: number): Promise<void> => {
      const timestamp = new Date(messageAt).toISOString();
      await dispatchEventSubNotification(worker, {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: messageId,
        payload: {
          broadcaster_user_id: channelId,
          broadcaster_user_login: channelId,
          chatter_user_id: accountId,
          chatter_user_login: "moonmoss",
          message_id: messageId,
          message: { text: "2", fragments: [{ type: "text", text: "2" }] },
          badges: [],
        },
        receivedAt: timestamp,
        eventSubTimestamp: timestamp,
      }, vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))), [quizModule]);
    };

    vi.setSystemTime(openedAt + 21_000);
    await dispatchAnswer("quiz-paused-answer", openedAt + 10_000);
    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toEqual([]);
    expect(answerSpy).toHaveBeenCalledWith("quiz", roundId, `quiz:${roundId}:q0:message:quiz-paused-answer`,
      accountId, "moonmoss", 0, 1, openedAt + 10_000);

    await expect(object.answerGameRoundChoice("quiz", roundId, "quiz:after-effective-deadline", accountId,
      "moonmoss", 0, 1, openedAt + 46_000)).resolves.toEqual({ status: "round_closed", replayed: false });
    await dispatchAnswer("quiz-resumed-answer", openedAt + 22_000);
    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toMatchObject([
      { accountId, data: { answers: [1], answerTimes: [openedAt + 22_000] } },
    ]);
  });

  it("keeps accepted blitz answer receipts replayable after cancellation", async () => {
    const channelId = `blitz-cancel-replay-${crypto.randomUUID()}`;
    const roundId = `blitz-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const blitzRound = object as unknown as Pick<ChannelObject, "answerGameRound">;
    await object.touchPointAccount("blitz_round", "blitz_viewer", "moonmoss", 0);
    await runPointObject(object, async (target, state) => {
      await target.openGameRound("blitz_round", roundId, {
        durationS: 30,
        announceText: "Blitz question",
        settlement: { kind: "blitz", params: {} },
      });
      await target.markGameRoundAnnounced("blitz_round", roundId, Date.now() + 30_000, `round:${roundId}`);
      await deferPointAlarmWithin(state);
    });
    const first = await blitzRound.answerGameRound("blitz_round", roundId, "blitz-answer-message", "blitz_viewer", "moonmoss", 0, Date.now());
    expect(first).toMatchObject({ status: "recorded", replayed: false });

    await object.cancelGameRound("blitz_round", roundId);

    await expect(blitzRound.answerGameRound("blitz_round", roundId, "blitz-answer-message", "blitz_viewer", "moonmoss", 0, Date.now()))
      .resolves.toMatchObject({ status: "recorded", replayed: true });
  });

  it("clears quiz answer data and receipts on cancellation through the quiz settlement opt-in", async () => {
    const channelId = `quiz-cancel-cleanup-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount("points", "quiz_cancel_viewer", "moonmoss", 0);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    const operationId = `quiz:${roundId}:q0:cancel-answer`;
    await expect(object.answerGameRoundChoice("quiz", roundId, operationId, "quiz_cancel_viewer", "moonmoss", 0, 1, openedAt + 1_000))
      .resolves.toEqual({ status: "recorded", replayed: false });

    await object.cancelGameRound("quiz", roundId);

    await expect(object.gameRoundParticipantData("quiz", roundId)).resolves.toEqual([
      { accountId: "quiz_cancel_viewer", login: "moonmoss", stake: 0, data: {} },
    ]);
    await expect(object.answerGameRoundChoice("quiz", roundId, operationId, "quiz_cancel_viewer", "moonmoss", 0, 1, openedAt + 1_000))
      .resolves.toEqual({ status: "round_closed", replayed: false });
  });

  it("settles offline sessions after ten minutes without scoring backdated answers", async () => {
    const channelId = `quiz-offline-timeout-${crypto.randomUUID()}`;
    const roundId = `quiz-${crypto.randomUUID()}`;
    const openedAt = Date.now();
    const offlineAt = openedAt + 5_000;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1), (?, 'quiz', 1, ?, 1)",
    ).bind(channelId, channelId, JSON.stringify({ pot: 10, answerSeconds: 30, revealSeconds: 8, chatQuestions: false })).run();
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, new Date(openedAt - 60_000).toISOString()).run();
    const object = pointObject(channelId);
    await object.touchPointAccount("quiz", "offline_viewer", "moonmoss", 0);
    await openAnnouncedQuiz(object, roundId, session(roundId));
    vi.setSystemTime(openedAt + 9_000);
    await object.answerGameRoundChoice("quiz", roundId, `quiz:${roundId}:answer`, "offline_viewer", "moonmoss", 0, 1, openedAt + 8_000);
    await worker.DB.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, source = 'helix' WHERE channel_id = ?",
    ).bind(new Date(offlineAt).toISOString(), channelId).run();
    await object.runModuleAlarm("quiz", "session-control", "stream-state");
    await expect(object.activeGameRound("quiz")).resolves.toMatchObject({ data: { paused: true, offlineSince: offlineAt } });

    vi.setSystemTime(offlineAt + 10 * 60_000);
    await object.runModuleAlarm("quiz", "session-control", `offline-timeout:${roundId}`);

    await expect(object.activeGameRound("quiz")).resolves.toBeNull();
    await expect(object.pointBalance("quiz", "offline_viewer")).resolves.toBe(0);
    await expect(object.recentlyResolvedGameRound("quiz", 60_000)).resolves.toMatchObject({
      roundId,
      result: { participants: 0, totalAnswers: 0, totalCorrect: 0, ranking: [] },
    });
  });
});
