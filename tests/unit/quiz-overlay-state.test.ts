import { describe, expect, it, vi } from "vitest";

import {
  loadQuizOverlayState,
  mergeQuizOverlayRealtimeState,
  parseQuizOverlayConfig,
  parseQuizOverlayState,
} from "../../src/modules/quiz/overlay/state";
import { quizPhasePayload } from "../../src/modules/quiz/overlay/payload";
import type { QuizSessionRoundData } from "../../src/modules/quiz/contracts";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const sessionStartedAt = "2029-12-31T23:59:00.000Z";

describe("quiz overlay state", () => {
  it("includes the quiz set name in every overlay phase payload", () => {
    const data: QuizSessionRoundData = {
      sessionId: "quiz-session",
      phaseSequence: 1,
      sessionStartedAt,
      setId: "set-one",
      setName: "General knowledge",
      language: "en",
      chatQuestions: false,
      pot: 10,
      answerSeconds: 30,
      revealSeconds: 8,
      questions: [{ text: "Question", options: ["One", "Two"], correctIndex: 0 }],
      phase: "results",
      questionIndex: 0,
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseOpenedAt: null,
      offlineSince: null,
    };

    expect(quizPhasePayload(data)).toMatchObject({ setName: "General knowledge" });
  });

  it("applies defaults and rejects unknown or unsafe style values", () => {
    expect(parseQuizOverlayConfig({ showPercent: false })).toMatchObject({
      showQuestionProgress: true,
      showPercent: false,
      backgroundColor: "#10141b",
    });
    expect(parseQuizOverlayConfig({ textColor: "url(javascript:alert(1))" })).toBeNull();
    expect(parseQuizOverlayConfig({ unsafe: true })).toBeNull();
  });

  it("drops answer data from open phases while keeping reveal distribution and answer key", () => {
    const open = parseQuizOverlayState({
      sessionId: "quiz-session",
      phase: "open",
      questionIndex: 0,
      questionCount: 1,
      question: "Which city sits on the Spree?",
      options: ["Berlin", "Bonn"],
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
      paused: false,
      remainingMs: null,
      phaseSequence: 0,
      sessionStartedAt,
      correctIndex: 0,
      answerDistribution: [5, 1],
    });
    const reveal = parseQuizOverlayState({
      ...open,
      phase: "reveal",
      correctIndex: 0,
      answerDistribution: [5, 1],
    });

    expect(open).not.toHaveProperty("correctIndex");
    expect(open).not.toHaveProperty("answerDistribution");
    expect(reveal).toMatchObject({ phase: "reveal", correctIndex: 0, answerDistribution: [5, 1] });
  });

  it("hydrates the current phase, freezes paused time, and returns null while idle", async () => {
    const readSnapshot = vi.fn().mockResolvedValue({
      sessionId: "quiz-session",
      phaseSequence: 0,
      sessionStartedAt,
      phase: "open",
      questionIndex: 0,
      questionCount: 1,
      question: "Which city sits on the Spree?",
      options: ["Berlin", "Bonn"],
      phaseEndsAt: null,
      paused: true,
      remainingMs: 12_500,
    });
    const context = { now, readSnapshot };

    await expect(loadQuizOverlayState(context)).resolves.toMatchObject({
      phase: "open",
      paused: true,
      remainingMs: 12_500,
      phaseEndsAt: null,
      serverNow: new Date(now).toISOString(),
      phaseSequence: 0,
      sessionStartedAt,
    });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("hydrates a cancelled session as idle from the latest snapshot", async () => {
    const readSnapshot = vi.fn().mockResolvedValue({
      sessionId: "cancelled-session",
      phaseSequence: 9,
      sessionStartedAt: new Date(now - 5_000).toISOString(),
      phase: "idle",
      serverNow: new Date(now - 4_000).toISOString(),
    });

    await expect(loadQuizOverlayState({ now, readSnapshot })).resolves.toMatchObject({
      sessionId: "cancelled-session",
      phase: "idle",
      phaseSequence: 9,
      serverNow: new Date(now).toISOString(),
    });
  });

  it("expires hydrated results from the stored resolution time", async () => {
    const resultAt = new Date(now - 60_001).toISOString();
    const readSnapshot = vi.fn().mockResolvedValue({
      sessionId: "resolved-session",
      phaseSequence: 12,
      sessionStartedAt,
      phase: "results",
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

    await expect(loadQuizOverlayState({ now, readSnapshot })).resolves.toMatchObject({
      sessionId: "resolved-session",
      phase: "idle",
      phaseSequence: 12,
      serverNow: new Date(now).toISOString(),
    });
  });

  it("hydrates results without a resolution timestamp as idle", async () => {
    const readSnapshot = vi.fn().mockResolvedValue({
      sessionId: "unresolved-session",
      phaseSequence: 12,
      sessionStartedAt,
      phase: "results",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      ranking: [],
    });

    await expect(loadQuizOverlayState({ now, readSnapshot })).resolves.toMatchObject({
      sessionId: "unresolved-session",
      phase: "idle",
      phaseSequence: 12,
      serverNow: new Date(now).toISOString(),
    });
  });

  it("accepts set-valid Unicode question and option lengths", () => {
    const question = `${"a".repeat(199)}😀`;
    const option = `${"b".repeat(79)}😀`;

    expect(parseQuizOverlayState({
      sessionId: "unicode-session",
      phaseSequence: 1,
      sessionStartedAt,
      phase: "open",
      questionIndex: 0,
      questionCount: 1,
      question,
      options: [option, "Other"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
    })).toMatchObject({ question, options: [option, "Other"] });
  });

  it("keeps answer data only in reveal and limits snapshot rankings to ten", () => {
    const reveal = parseQuizOverlayState({
      sessionId: "quiz-session",
      phaseSequence: 1,
      sessionStartedAt,
      phase: "reveal",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two", "Three"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      correctIndex: 0,
      answerDistribution: [5, 2, 1],
    });
    const results = parseQuizOverlayState({
      sessionId: "quiz-session",
      phaseSequence: 2,
      sessionStartedAt,
      phase: "results",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      resultAt: new Date(now).toISOString(),
      ranking: Array.from({ length: 12 }, (_, index) => ({
        login: `viewer${String(index + 1)}`,
        correct: 12 - index,
        rank: index + 1,
      })),
    });
    const open = parseQuizOverlayState({
      sessionId: "quiz-session",
      phaseSequence: 0,
      sessionStartedAt,
      phase: "open",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      correctIndex: 0,
      answerDistribution: [5, 2],
    });

    expect(reveal).toMatchObject({ correctIndex: 0, answerDistribution: [5, 2, 1] });
    expect(open).not.toHaveProperty("correctIndex");
    expect(open).not.toHaveProperty("answerDistribution");
    const ranking = results?.ranking as readonly Record<string, unknown>[] | undefined;
    expect(ranking).toHaveLength(10);
    expect(ranking?.[9]).toMatchObject({ login: "viewer10", correct: 3 });
    expect(results).toMatchObject({ resultAt: new Date(now).toISOString() });
  });

  it("replaces stale reveal state when the next open phase arrives", () => {
    const current = {
      sessionId: "quiz-session",
      phase: "reveal",
      questionIndex: 0,
      questionCount: 2,
      question: "First question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      serverNow: "2030-01-01T00:00:03.000Z",
      phaseSequence: 2,
      sessionStartedAt,
      correctIndex: 1,
      answerDistribution: [1, 6],
    };
    const incoming = {
      sessionId: "quiz-session",
      phase: "open",
      questionIndex: 1,
      questionCount: 2,
      question: "Second question",
      options: ["One", "Two"],
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
      paused: false,
      remainingMs: null,
      serverNow: "2030-01-01T00:00:04.000Z",
      phaseSequence: 3,
      sessionStartedAt,
    };

    const merged = mergeQuizOverlayRealtimeState(current, incoming);
    expect(merged).toMatchObject({ phase: "open", questionIndex: 1 });
    expect(merged).not.toHaveProperty("correctIndex");
    expect(merged).not.toHaveProperty("answerDistribution");
  });

  it("ignores a phase event older than the reconnect bootstrap snapshot", () => {
    const current = {
      sessionId: "quiz-session",
      phase: "reveal",
      questionIndex: 1,
      questionCount: 2,
      question: "Current question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      serverNow: "2030-01-01T00:00:08.000Z",
      phaseSequence: 4,
      sessionStartedAt,
      correctIndex: 0,
      answerDistribution: [4, 1],
    };
    const olderOpen = {
      ...current,
      phase: "open",
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
      serverNow: "2030-01-01T00:00:06.000Z",
      phaseSequence: 3,
    };

    expect(mergeQuizOverlayRealtimeState(current, olderOpen)).toMatchObject({
      phase: "reveal",
      serverNow: "2030-01-01T00:00:08.000Z",
      correctIndex: 0,
    });
  });

  it("keeps a newer phase when a delayed bootstrap carries a later clock calibration", () => {
    const current = {
      sessionId: "quiz-session",
      phase: "reveal",
      questionIndex: 0,
      questionCount: 1,
      question: "Current question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 2,
      sessionStartedAt,
      serverNow: "2030-01-01T00:00:11.000Z",
      correctIndex: 1,
      answerDistribution: [1, 4],
    };
    const delayedSnapshot = {
      ...current,
      phase: "open",
      phaseSequence: 1,
      serverNow: "2030-01-01T00:00:12.000Z",
      phaseEndsAt: "2030-01-01T00:00:30.000Z",
    };

    expect(mergeQuizOverlayRealtimeState(current, delayedSnapshot)).toMatchObject({
      phase: "reveal",
      phaseSequence: 2,
      serverNow: "2030-01-01T00:00:12.000Z",
      correctIndex: 1,
    });
  });

  it("rejects a retried result from an older session even when its envelope time is newer", () => {
    const current = {
      sessionId: "new-session",
      phase: "open",
      questionIndex: 0,
      questionCount: 1,
      question: "New question",
      options: ["One", "Two"],
      phaseEndsAt: "2030-01-01T00:01:00.000Z",
      paused: false,
      remainingMs: null,
      phaseSequence: 9,
      sessionStartedAt: "2030-01-01T00:00:10.000Z",
      serverNow: "2030-01-01T00:00:20.000Z",
    };
    const retriedOldResult = {
      ...current,
      sessionId: "old-session",
      phase: "results",
      phaseSequence: 8,
      sessionStartedAt: "2030-01-01T00:00:00.000Z",
      resultAt: "2030-01-01T00:00:05.000Z",
      serverNow: "2030-01-01T00:02:00.000Z",
      ranking: [{ login: "winner", correct: 1, rank: 1 }],
    };

    expect(mergeQuizOverlayRealtimeState(current, retriedOldResult)).toMatchObject({
      sessionId: "new-session",
      phase: "open",
      sessionStartedAt: "2030-01-01T00:00:10.000Z",
      serverNow: "2030-01-01T00:02:00.000Z",
    });
  });

  it("orders a later session by channel sequence even when its start timestamp is earlier", () => {
    const current = {
      sessionId: "finished-session",
      phase: "idle",
      questionIndex: 0,
      questionCount: 1,
      question: "",
      options: [],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 12,
      sessionStartedAt: "2030-01-01T00:00:10.000Z",
      serverNow: "2030-01-01T00:00:20.000Z",
    };
    const delayedStart = {
      sessionId: "delayed-session",
      phase: "announce",
      questionIndex: 0,
      questionCount: 1,
      question: "Delayed question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 13,
      sessionStartedAt: "2030-01-01T00:00:00.000Z",
      serverNow: "2030-01-01T00:00:21.000Z",
    };

    expect(mergeQuizOverlayRealtimeState(current, delayedStart)).toMatchObject({
      sessionId: "delayed-session",
      phase: "announce",
      phaseSequence: 13,
    });
    expect(mergeQuizOverlayRealtimeState(delayedStart, {
      ...delayedStart,
      phase: "open",
      phaseSequence: 14,
      sessionStartedAt: "2029-12-31T23:59:59.000Z",
    })).toMatchObject({ sessionId: "delayed-session", phase: "open", phaseSequence: 14 });
  });

  it("does not restart a results window when the same persisted result is retried", () => {
    const current = {
      sessionId: "quiz-session",
      phase: "results",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 5,
      sessionStartedAt,
      resultAt: "2030-01-01T00:00:05.000Z",
      serverNow: "2030-01-01T00:00:55.000Z",
      ranking: [{ login: "winner", correct: 1, rank: 1 }],
    };
    const retriedResult = {
      ...current,
      serverNow: "2030-01-01T00:02:00.000Z",
      resolvedAt: current.resultAt,
      resultAt: undefined,
    };

    expect(mergeQuizOverlayRealtimeState(current, retriedResult)).toMatchObject({
      phase: "results",
      phaseSequence: 5,
      resultAt: "2030-01-01T00:00:05.000Z",
      serverNow: "2030-01-01T00:02:00.000Z",
    });
  });

  it("uses the persisted resolved time when parsing a retried results event", () => {
    expect(parseQuizOverlayState({
      sessionId: "quiz-session",
      phase: "results",
      questionIndex: 0,
      questionCount: 1,
      question: "Question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 5,
      sessionStartedAt,
      resolvedAt: "2030-01-01T00:00:05.000Z",
      serverNow: "2030-01-01T00:02:00.000Z",
      ranking: [],
    })).toMatchObject({ resultAt: "2030-01-01T00:00:05.000Z" });
  });
});
