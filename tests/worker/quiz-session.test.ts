import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quizModule } from "../../src/modules/quiz";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { isModuleOverlayRealtimeEnvelope } from "../../src/realtime-contract";
import {
  clearPointObjectAlarms,
  deferPointAlarmWithin,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
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
  chatQuestions: false,
  answerSeconds: 30,
  revealSeconds: 8,
  questions: [{ text: "Capital?", options: ["A", "B"], correctIndex: 1 }],
});

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try { await clearPointObjectAlarms(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
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
      await target.markGameRoundAnnounced("quiz", roundId, openedAt + 30_000, "round:" + roundId);
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
});
