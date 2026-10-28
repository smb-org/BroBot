import { describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import { quizModule } from "../../src/modules/quiz";
import { onQuizRoundAnnounced, onQuizRoundDeadline, quizSessionControlAlarm } from "../../src/modules/quiz/lifecycle";

interface ActiveQuiz {
  roundId: string;
  state: "announcing" | "open";
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
  offlineSince: null,
});

const lifecycleContext = (
  stream: { state: string; changed_at: string | null },
  roundId = "quiz-round",
  state: ActiveQuiz["state"] = "open",
) => {
  const active: ActiveQuiz = {
    roundId,
    state,
    deadlineAt: Date.now() + 30_000,
    data: sessionData(roundId),
  };
  const scheduled: Array<{ key: string; deadline: number }> = [];
  const cleared: string[] = [];
  const canceled: string[] = [];
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
        cancel: (roundId: string) => { canceled.push(roundId); return Promise.resolve(1); },
      },
    },
    schedule: (key: string, deadline: number) => { scheduled.push({ key, deadline }); return Promise.resolve(); },
    clear: (key: string) => { cleared.push(key); return Promise.resolve(); },
    sendChat: () => Promise.resolve({ sent: false, reason: null, retryable: false, delivery: "delivered" as const }),
    publishModuleOverlayMessage: () => Promise.resolve(),
  } as unknown as ModuleAlarmContext;
  return { context, active, scheduled, cleared, canceled };
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
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
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
      const offlineObservedAt = Date.now();
      for (const invocation of queuedInvocations) {
        await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, invocation);
      }

      expect(queuedInvocations).toEqual([
        { streamSnapshot: { state: "offline" } },
        { streamSnapshot: { state: "online" } },
      ]);
      expect(fake.active.data).toMatchObject({ paused: true, offlineSince: null, phaseEndsAt: null });
      expect(fake.scheduled).toEqual([{
        key: "offline-timeout:quiz-round",
        deadline: offlineObservedAt + 10 * 60_000,
      }]);
      expect(fake.cleared).toContain("offline-timeout:quiz-round");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the pause and timeout before a failed overlay publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
      const offlineObservedAt = Date.now();
      fake.context.publishModuleOverlayMessage = () => Promise.reject(new Error("overlay publish failed"));

      await expect(quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, {
        streamSnapshot: { state: "offline" },
      })).rejects.toThrow("overlay publish failed");

      expect(fake.active.data).toMatchObject({ paused: true, offlineSince: offlineObservedAt });
      expect(fake.active.deadlineAt).toBeNull();
      expect(fake.scheduled).toEqual([{
        key: "offline-timeout:quiz-round",
        deadline: offlineObservedAt + 10 * 60_000,
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists an offline observation for an announcing pending start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const offlineObservedAt = Date.now();
      const fake = lifecycleContext({ state: "offline", changed_at: new Date(offlineObservedAt).toISOString() }, "quiz-round", "announcing");
      Object.assign(fake.active.data, { phase: "announce", phaseEndsAt: null, phaseOpenedAt: null });

      await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, {
        streamSnapshot: { state: "offline" },
      });

      expect(fake.active.data).toMatchObject({ paused: true, offlineSince: offlineObservedAt, remainingMs: 0 });
      expect(fake.active.deadlineAt).toBeNull();
      expect(fake.scheduled).toContainEqual({
        key: "offline-timeout:quiz-round",
        deadline: offlineObservedAt + 10 * 60_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an announcing start after ten minutes offline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const offlineObservedAt = Date.now();
      const fake = lifecycleContext({ state: "offline", changed_at: new Date(offlineObservedAt).toISOString() }, "quiz-round", "announcing");
      Object.assign(fake.active.data, { phase: "announce", phaseEndsAt: null, phaseOpenedAt: null });
      await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now(), undefined, {
        streamSnapshot: { state: "offline" },
      });

      vi.setSystemTime(offlineObservedAt + 10 * 60_000);
      await quizSessionControlAlarm.handle(fake.context, "offline-timeout:quiz-round", Date.now());

      expect(fake.canceled).toEqual(["quiz-round"]);
      expect(fake.cleared).toContain("offline-timeout:quiz-round");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the original offline observation time across Helix refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const firstObservedAt = Date.now();
      const stream = { state: "offline", changed_at: new Date(firstObservedAt - 5_000).toISOString() };
      const fake = lifecycleContext(stream);

      await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now());

      expect(fake.active.data.offlineSince).toBe(firstObservedAt);
      vi.setSystemTime(firstObservedAt + 9 * 60_000);
      stream.changed_at = new Date(Date.now()).toISOString();

      await quizSessionControlAlarm.handle(fake.context, "stream-state", Date.now());

      expect(fake.active.data.offlineSince).toBe(firstObservedAt);
      expect(fake.scheduled.filter(({ key }) => key === "offline-timeout:quiz-round").map(({ deadline }) => deadline))
        .toEqual([firstObservedAt + 10 * 60_000, firstObservedAt + 10 * 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a muted question pending and retries its announcement on the next tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
      Object.assign(fake.active.data, { phase: "announce", phaseEndsAt: null, phaseOpenedAt: null, chatQuestions: true });
      const results = [
        { sent: false, reason: "channel_muted", retryable: false, delivery: "not_attempted" as const },
        { sent: true, reason: null, retryable: false, delivery: "delivered" as const },
      ];
      fake.context.sendChat = () => Promise.resolve(results.shift() ?? {
        sent: false, reason: null, retryable: false, delivery: "not_attempted",
      });
      const announced = { roundId: fake.active.roundId } as Parameters<typeof onQuizRoundAnnounced>[1];

      await onQuizRoundAnnounced(fake.context, announced);

      expect(fake.active.data).toMatchObject({ phase: "announce", phaseEndsAt: null });
      expect(fake.active.deadlineAt).toBe(Date.now() + 5_000);

      vi.setSystemTime(fake.active.deadlineAt ?? Date.now());
      await onQuizRoundDeadline(fake.context, { roundId: fake.active.roundId } as Parameters<typeof onQuizRoundDeadline>[1]);

      expect(fake.active.data).toMatchObject({ phase: "open", phaseEndsAt: Date.now() + 30_000 });
    } finally {
      vi.useRealTimers();
    }
  });

});
