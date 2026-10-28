import { describe, expect, it, vi } from "vitest";

import type { PointActiveRound, PointResolvedRound } from "../../src/modules/contract";
import { QUIZ_RESULTS_DISPLAY_MS } from "../../src/modules/quiz/overlay/state";
import {
  loadQuizOverlayState,
  mergeQuizOverlayRealtimeState,
  parseQuizOverlayConfig,
  parseQuizOverlayState,
  quizOverlayStateForPointRound,
} from "../../src/modules/quiz/overlay/state";

const now = Date.parse("2030-01-01T00:00:00.000Z");

const sessionData = (phase: "announce" | "open" | "reveal" | "results", overrides: Record<string, unknown> = {}) => ({
  sessionId: "quiz-session",
  phase,
  questionIndex: 0,
  questions: [{ text: "Which city sits on the Spree?", options: ["Berlin", "Bonn", "Bremen"], correctIndex: 0 }],
  phaseEndsAt: now + 20_000,
  paused: false,
  remainingMs: null,
  aggregates: { answerDistribution: [[5, 2, 1]] },
  ...overrides,
});

const activeRound = (phase: "announce" | "open" | "reveal" | "results", overrides: Record<string, unknown> = {}): PointActiveRound => ({
  roundId: "quiz-session",
  state: "open",
  data: sessionData(phase, overrides),
  deadlineAt: now + 20_000,
});

describe("quiz overlay state", () => {
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
    const readPointRound = vi.fn().mockResolvedValue(activeRound("open", {
      paused: true,
      phaseEndsAt: null,
      remainingMs: 12_500,
    }));
    const context = { now, readPointRound } as never;

    await expect(loadQuizOverlayState(context)).resolves.toMatchObject({
      phase: "open",
      paused: true,
      remainingMs: 12_500,
      phaseEndsAt: null,
      serverNow: new Date(now).toISOString(),
    });
    expect(readPointRound).toHaveBeenCalledWith(QUIZ_RESULTS_DISPLAY_MS);
    expect(quizOverlayStateForPointRound(null, now)).toBeNull();
  });

  it("hydrates reveal answers only in reveal and limits resolved rankings to ten", () => {
    const reveal = quizOverlayStateForPointRound(activeRound("reveal"), now);
    const resolvedRound: PointResolvedRound = {
      roundId: "quiz-session",
      data: sessionData("results"),
      result: {
        ranking: Array.from({ length: 12 }, (_, index) => ({
          login: `viewer${String(index + 1)}`,
          correct: 12 - index,
          rank: index + 1,
          payout: 10,
        })),
      },
      resolvedAt: new Date(now).toISOString(),
    };
    const results = quizOverlayStateForPointRound(resolvedRound, now + 5_000);
    const open = quizOverlayStateForPointRound(activeRound("open"), now);

    expect(reveal).toMatchObject({ correctIndex: 0, answerDistribution: [5, 2, 1] });
    expect(open).not.toHaveProperty("correctIndex");
    expect(open).not.toHaveProperty("answerDistribution");
    const ranking = results?.ranking as readonly Record<string, unknown>[] | undefined;
    expect(ranking).toHaveLength(10);
    expect(ranking?.[9]).toMatchObject({ login: "viewer10", correct: 3 });
    expect(results).toMatchObject({
      serverNow: new Date(now + 5_000).toISOString(),
      resultAt: new Date(now).toISOString(),
    });
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
      correctIndex: 0,
      answerDistribution: [4, 1],
    };
    const olderOpen = {
      ...current,
      phase: "open",
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
      serverNow: "2030-01-01T00:00:06.000Z",
    };

    expect(mergeQuizOverlayRealtimeState(current, olderOpen)).toMatchObject({
      phase: "reveal",
      serverNow: "2030-01-01T00:00:08.000Z",
      correctIndex: 0,
    });
  });
});
