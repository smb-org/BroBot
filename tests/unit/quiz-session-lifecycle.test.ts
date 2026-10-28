import { describe, expect, it, vi } from "vitest";

import type { JsonObject, ModuleAlarmContext } from "../../src/modules/contract";
import { quizModule } from "../../src/modules/quiz";
import { onQuizRoundAnnounced, onQuizRoundDeadline, quizSessionControlAlarm } from "../../src/modules/quiz/lifecycle";
import { loadQuizOverlayState, mergeQuizOverlayRealtimeState } from "../../src/modules/quiz/overlay/state";

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
  const published: Array<{ type: string; elementKind: string; payload: Record<string, unknown> }> = [];
  let roundIsActive = true;
  let snapshot: {
    sequence: number;
    lastBroadcastSequence: number;
    pendingBroadcastSequence?: number | null;
    payload: Record<string, unknown>;
  } | null = null;
  const contextRef: { current: ModuleAlarmContext | null } = { current: null };
  const snapshotAccess = {
    read: () => Promise.resolve(snapshot),
    write: (payload: Readonly<Record<string, unknown>>, expectedCurrentSessionId?: string) => {
      if (expectedCurrentSessionId !== undefined && snapshot !== null && snapshot.payload.sessionId !== expectedCurrentSessionId) {
        return Promise.resolve(null);
      }
      const sequence = (snapshot?.sequence ?? 0) + 1;
      snapshot = {
        sequence,
        lastBroadcastSequence: snapshot?.lastBroadcastSequence ?? 0,
        pendingBroadcastSequence: sequence,
        payload: { ...payload, phaseSequence: sequence, serverNow: new Date().toISOString() },
      };
      return Promise.resolve(snapshot);
    },
    deliverPending: async () => {
      if (snapshot === null || snapshot.lastBroadcastSequence >= snapshot.sequence) return;
      const current = snapshot;
      const type = current.payload.phase === "idle" ? "cancel"
        : current.payload.phase === "results" ? "results" : "phase";
      try {
        const activeContext = contextRef.current;
        if (activeContext === null) throw new Error("Quiz alarm context was not initialized.");
        await activeContext.publishModuleOverlayMessage(type, "quiz.session", {
          ...current.payload,
          serverNow: new Date().toISOString(),
        });
        if (snapshot.sequence === current.sequence) {
          snapshot = { ...snapshot, lastBroadcastSequence: current.sequence, pendingBroadcastSequence: null };
        }
      } catch (error: unknown) {
        scheduled.push({ key: "overlay-retry", deadline: Date.now() + 5_000 });
        throw error;
      }
    },
  };
  const context = {
    channelId: "channel-one",
    DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(stream) }) }) },
    quizOverlaySnapshot: snapshotAccess,
    points: {
      rounds: {
        active: () => Promise.resolve(roundIsActive ? active : null),
        update: (_roundId: string, data: unknown, deadlineAt: number | null, overlayPayload?: Record<string, unknown>) => {
          active.data = data as Record<string, unknown>;
          active.deadlineAt = deadlineAt;
          if (overlayPayload === undefined) return Promise.resolve();
          return snapshotAccess.write(overlayPayload, _roundId).then((stored) => {
            if (stored === null) return undefined;
            active.data.phaseSequence = stored.sequence;
            return stored;
          });
        },
        cancel: (roundId: string, overlayPayload?: Record<string, unknown>) => {
          canceled.push(roundId);
          roundIsActive = false;
          if (overlayPayload === undefined) return Promise.resolve(1);
          return snapshotAccess.write(overlayPayload, roundId).then(() => 1);
        },
      },
    },
    schedule: (key: string, deadline: number) => { scheduled.push({ key, deadline }); return Promise.resolve(); },
    clear: (key: string) => { cleared.push(key); return Promise.resolve(); },
    sendChat: () => Promise.resolve({ sent: false, reason: null, retryable: false, delivery: "delivered" as const }),
    publishModuleOverlayMessage: (type: string, elementKind: string, payload: Record<string, unknown>) => {
      published.push({ type, elementKind, payload });
      return Promise.resolve();
    },
  } as unknown as ModuleAlarmContext;
  contextRef.current = context;
  return { context, active, scheduled, cleared, canceled, published };
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
      expect(fake.scheduled).toContainEqual({
        key: "offline-timeout:quiz-round",
        deadline: offlineObservedAt + 10 * 60_000,
      });
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
      expect(fake.scheduled).toContainEqual({
        key: "offline-timeout:quiz-round",
        deadline: offlineObservedAt + 10 * 60_000,
      });
      expect(fake.scheduled).toContainEqual({ key: "overlay-retry", deadline: offlineObservedAt + 5_000 });
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
      expect(fake.published.at(-1)?.payload).toMatchObject({
        sessionId: "quiz-round",
        phase: "idle",
        phaseSequence: 2,
      });
      expect(fake.cleared).toContain("offline-timeout:quiz-round");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes an idle cancellation when End cancels a pending start", async () => {
    const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() }, "quiz-round", "announcing");
    Object.assign(fake.active.data, { phase: "announce", phaseEndsAt: null, phaseSequence: 3 });

    await quizSessionControlAlarm.handle(fake.context, "quiz-round", Date.now(), undefined, {
      action: "end",
      sessionId: "quiz-round",
    });

    expect(fake.canceled).toEqual(["quiz-round"]);
    expect(fake.published.at(-1)?.payload).toMatchObject({
      sessionId: "quiz-round",
      phase: "idle",
      phaseSequence: 1,
    });
  });

  it("publishes settled results at a newer snapshot sequence after provisional bootstrap", async () => {
    const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
    const resolvedAt = "2030-01-01T00:00:05.000Z";
    const data = { ...sessionData("quiz-round"), phase: "results", phaseSequence: 4, sessionStartedAt: "2030-01-01T00:00:00.000Z" };
    const snapshotStore = fake.context.quizOverlaySnapshot;
    const stored = await snapshotStore.write({
      sessionId: "quiz-round",
      phase: "results",
      phaseSequence: 8,
      sessionStartedAt: "2030-01-01T00:00:00.000Z",
      questionIndex: 0,
      questionCount: 1,
      question: "Capital?",
      options: ["A", "B"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      ranking: [],
    });
    if (stored === null) throw new Error("Provisional result snapshot was not stored.");
    await snapshotStore.deliverPending();

    const handler = quizModule.onPointRoundResolved;
    if (handler === undefined) throw new Error("Quiz result handler is unavailable.");
    await handler(fake.context, {
      roundId: "quiz-round",
      data,
      result: { ranking: [{ login: "winner", correct: 1, rank: 1 }] },
      resolvedAt,
    });

    expect(fake.published.at(-1)).toMatchObject({
      type: "results",
      elementKind: "quiz.session",
      payload: {
        sessionId: "quiz-round",
        phase: "results",
        phaseSequence: stored.sequence + 1,
        sessionStartedAt: "2030-01-01T00:00:00.000Z",
        resultAt: resolvedAt,
        ranking: [{ login: "winner", correct: 1, rank: 1 }],
      },
    });
    expect(mergeQuizOverlayRealtimeState(stored.payload, fake.published.at(-1)?.payload ?? {})).toMatchObject({
      phase: "results",
      phaseSequence: stored.sequence + 1,
      ranking: [{ login: "winner", correct: 1 }],
    });
    await expect(fake.context.quizOverlaySnapshot.read()).resolves.toMatchObject({
      sequence: stored.sequence + 1,
      payload: { phase: "results", ranking: [{ login: "winner" }] },
    });
  });

  it("does not let a retried settled result replace a newer session snapshot", async () => {
    const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
    const current = await fake.context.quizOverlaySnapshot.write({
      sessionId: "new-session",
      phase: "open",
      sessionStartedAt: "2030-01-01T00:00:10.000Z",
      questionIndex: 0,
      questionCount: 1,
      question: "New question",
      options: ["One", "Two"],
      phaseEndsAt: "2030-01-01T00:01:00.000Z",
      paused: false,
      remainingMs: null,
    });
    if (current === null) throw new Error("Current session snapshot was not stored.");
    await fake.context.quizOverlaySnapshot.deliverPending();
    const handler = quizModule.onPointRoundResolved;
    if (handler === undefined) throw new Error("Quiz result handler is unavailable.");

    await handler(fake.context, {
      roundId: "old-session",
      data: { ...sessionData("old-session"), phaseSequence: 4, phase: "results" },
      result: { ranking: [{ login: "winner", correct: 1, rank: 1 }] },
      resolvedAt: "2030-01-01T00:00:05.000Z",
    });

    await expect(fake.context.quizOverlaySnapshot.read()).resolves.toMatchObject({
      sequence: current.sequence,
      payload: { sessionId: "new-session", phase: "open" },
    });
  });

  it("refreshes server clock calibration when a pending snapshot is delivered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() });
      const resultAt = new Date(Date.now()).toISOString();
      await fake.context.quizOverlaySnapshot.write({
        sessionId: "quiz-round",
        phase: "results",
        sessionStartedAt: new Date(Date.now() - 60_000).toISOString(),
        questionIndex: 0,
        questionCount: 1,
        question: "Question",
        options: ["One", "Two"],
        phaseEndsAt: null,
        paused: false,
        remainingMs: null,
        resultAt,
        ranking: [{ login: "winner", correct: 1, rank: 1 }],
      });
      fake.published.length = 0;
      vi.setSystemTime(Date.now() + 75_000);

      await quizSessionControlAlarm.handle(fake.context, "overlay-retry", Date.now());

      const delivered = fake.published.at(-1)?.payload;
      expect(delivered).toMatchObject({
        serverNow: new Date(Date.now()).toISOString(),
        resultAt,
      });
      const hydratedSnapshot = delivered as unknown as JsonObject | null;
      const hydrated = await loadQuizOverlayState({ now: Date.now(), readSnapshot: () => Promise.resolve(hydratedSnapshot) });
      expect(hydrated).toMatchObject({ phase: "idle" });
      expect(hydrated).not.toHaveProperty("resultAt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a failed cancellation broadcast from the snapshot when End is retried", async () => {
    const fake = lifecycleContext({ state: "online", changed_at: new Date(Date.now()).toISOString() }, "quiz-round", "announcing");
    Object.assign(fake.active.data, { phase: "announce", phaseEndsAt: null, phaseSequence: 3 });
    fake.context.publishModuleOverlayMessage = () => Promise.reject(new Error("overlay publish failed"));

    await expect(quizSessionControlAlarm.handle(fake.context, "quiz-round", Date.now(), undefined, {
      action: "end",
      sessionId: "quiz-round",
    })).rejects.toThrow("overlay publish failed");
    await expect(fake.context.quizOverlaySnapshot.read()).resolves.toMatchObject({
      payload: { sessionId: "quiz-round", phase: "idle" },
      lastBroadcastSequence: 0,
    });

    fake.context.publishModuleOverlayMessage = (type: string, elementKind: string, payload: Record<string, unknown>) => {
      fake.published.push({ type, elementKind, payload });
      return Promise.resolve();
    };
    await expect(quizSessionControlAlarm.handle(fake.context, "quiz-round", Date.now(), undefined, {
      action: "end",
      sessionId: "quiz-round",
    })).resolves.toBeUndefined();

    expect(fake.published.at(-1)).toMatchObject({ type: "cancel", payload: { sessionId: "quiz-round", phase: "idle" } });
    await expect(fake.context.quizOverlaySnapshot.read()).resolves.toMatchObject({ lastBroadcastSequence: 1 });
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
