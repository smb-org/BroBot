import { describe, expect, it } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import { quizModule } from "../../src/modules/quiz";
import { onQuizRoundDeadline, quizSessionControlAlarm } from "../../src/modules/quiz/lifecycle";

interface ActiveQuiz {
  roundId: string;
  state: "open";
  deadlineAt: number | null;
  data: Record<string, unknown>;
}

const sessionData = (roundId: string): Record<string, unknown> => ({
  sessionId: roundId,
  setId: "set-one",
  setName: "Space",
  language: "en",
  chatQuestions: false,
  pot: 10,
  answerSeconds: 30,
  revealSeconds: 8,
  questions: [{ text: "Capital?", options: ["A", "B"], correctIndex: 1 }],
  phase: "open",
  questionIndex: 0,
  phaseOpenedAt: Date.now(),
  phaseEndsAt: Date.now() + 30_000,
  paused: false,
  remainingMs: null,
  pauseIntervals: [],
  offlineSince: null,
});

const lifecycleContext = (stream: { state: string; changed_at: string | null }, roundId = "quiz-round") => {
  const active: ActiveQuiz = {
    roundId,
    state: "open",
    deadlineAt: Date.now() + 30_000,
    data: sessionData(roundId),
  };
  const scheduled: Array<{ key: string; deadline: number }> = [];
  const cleared: string[] = [];
  const context = {
    channelId: "channel-one",
    DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(stream) }) }) },
    points: {
      rounds: {
        active: () => Promise.resolve(active),
        update: (_roundId: string, data: unknown, deadlineAt: number | null) => {
          active.data = data as Record<string, unknown>;
          active.deadlineAt = deadlineAt;
          return Promise.resolve();
        },
      },
    },
    schedule: (key: string, deadline: number) => { scheduled.push({ key, deadline }); return Promise.resolve(); },
    clear: (key: string) => { cleared.push(key); return Promise.resolve(); },
    publishModuleOverlayMessage: () => Promise.resolve(),
  } as unknown as ModuleAlarmContext;
  return { context, active, scheduled, cleared };
};

const streamEvent = (
  state: "online" | "offline",
  timestamp: string,
): Parameters<NonNullable<typeof quizModule.handleEvent>>[0] => ({
  channelId: "channel-one",
  subscriptionType: state === "online" ? "stream.online" : "stream.offline",
  triggerId: `trigger-${state}`,
  payload: {},
  settings: quizModule.defaultSettings,
  receivedAt: timestamp,
  eventSubTimestamp: timestamp,
  actor: null,
  chatStatus: null,
});

describe("quiz stream lifecycle reconciliation", () => {
  it("keeps the queued offline transition when the stored row is already online", async () => {
    const now = Date.now();
    const offlineAt = new Date(now + 1_000).toISOString();
    const onlineAt = new Date(now + 2_000).toISOString();
    const queuedInvocations: unknown[] = [];
    const eventContext = {
      streamStateTransitionAccepted: true,
      runModuleAlarm: (_handler: string, _key: string, invocation?: unknown) => {
        queuedInvocations.push(invocation);
        return Promise.resolve();
      },
    } as Parameters<NonNullable<typeof quizModule.handleEvent>>[1];
    if (quizModule.handleEvent === undefined) throw new Error("Quiz event handler is unavailable.");

    await quizModule.handleEvent(streamEvent("offline", offlineAt), eventContext);
    await quizModule.handleEvent(streamEvent("online", onlineAt), eventContext);

    const fake = lifecycleContext({ state: "online", changed_at: onlineAt });
    for (const invocation of queuedInvocations) {
      await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, invocation);
    }

    expect(queuedInvocations).toEqual([
      { streamSnapshot: { state: "offline", since: Date.parse(offlineAt) } },
      { streamSnapshot: { state: "online", since: Date.parse(onlineAt) } },
    ]);
    expect(fake.active.data).toMatchObject({ paused: true, offlineSince: null, phaseEndsAt: null });
    expect(fake.scheduled).toEqual([{
      key: "offline-timeout:quiz-round",
      deadline: Date.parse(offlineAt) + 10 * 60_000,
    }]);
    expect(fake.cleared).toContain("offline-timeout:quiz-round");
  });

  it("persists the pause and timeout before a failed overlay publication", async () => {
    const offlineAt = Date.now() - 5_000;
    const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
    fake.context.publishModuleOverlayMessage = () => Promise.reject(new Error("overlay publish failed"));

    await expect(quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, {
      streamSnapshot: { state: "offline", since: offlineAt },
    })).rejects.toThrow("overlay publish failed");

    expect(fake.active.data).toMatchObject({ paused: true, offlineSince: offlineAt });
    expect(fake.active.deadlineAt).toBeNull();
    expect(fake.scheduled).toEqual([{
      key: "offline-timeout:quiz-round",
      deadline: offlineAt + 10 * 60_000,
    }]);
  });

  it("keeps earlier pause intervals when advancing to another question", async () => {
    const now = Date.now();
    const fake = lifecycleContext({ state: "online", changed_at: new Date(now).toISOString() });
    const pauseIntervals = [{ startedAt: now - 30_000, endedAt: now - 20_000 }];
    Object.assign(fake.active.data, {
      questions: [
        { text: "Capital?", options: ["A", "B"], correctIndex: 1 },
        { text: "Ocean?", options: ["A", "B"], correctIndex: 0 },
      ],
      phase: "reveal",
      questionIndex: 0,
      phaseEndsAt: now - 1,
      pauseIntervals,
    });
    fake.active.deadlineAt = now - 1;

    await onQuizRoundDeadline(fake.context, { roundId: fake.active.roundId } as Parameters<typeof onQuizRoundDeadline>[1]);

    expect(fake.active.data).toMatchObject({ phase: "open", questionIndex: 1, pauseIntervals });
  });
});
