import { describe, expect, it } from "vitest";
import {
  endQuizPhase,
  pauseQuizPhase,
  resumeQuizPhase,
  scoreQuizSession,
  transitionQuizPhase,
  type QuizPhaseState,
} from "../../src/modules/quiz/domain/session";

const questions = [
  { text: "Capital?", options: ["A", "B", "C"], correctIndex: 1 },
  { text: "Sky?", options: ["Blue", "Green"], correctIndex: 0 },
];

describe("quiz session scoring", () => {
  it("ranks by correct answers and gives tied participants the same rank", () => {
    const result = scoreQuizSession(questions, [
      { accountId: "viewer-a", login: "moonmoss", answers: [1, 0] },
      { accountId: "viewer-b", login: "frostfern", answers: [1, 1] },
      { accountId: "viewer-c", login: "starling", answers: [1, 1] },
    ], 12);

    expect(result.ranking.map(({ login, correct, rank, payout }) => ({ login, correct, rank, payout }))).toEqual([
      { login: "moonmoss", correct: 2, rank: 1, payout: 6 },
      { login: "frostfern", correct: 1, rank: 2, payout: 3 },
      { login: "starling", correct: 1, rank: 2, payout: 3 },
    ]);
    expect(result.correctCounts).toEqual([3, 1]);
    expect(result.answerDistribution).toEqual([[0, 3, 0], [1, 2]]);
  });

  it("leaves the indivisible remainder with the house and pays nothing for a zero pot", () => {
    const participants = [
      { accountId: "viewer-a", login: "moonmoss", answers: [1, 0] },
      { accountId: "viewer-b", login: "frostfern", answers: [1, 1] },
    ];

    expect(scoreQuizSession(questions, participants, 10)).toMatchObject({
      totalCorrect: 3,
      distributed: 9,
      houseRemainder: 1,
      ranking: [
        { accountId: "viewer-a", correct: 2, payout: 6 },
        { accountId: "viewer-b", correct: 1, payout: 3 },
      ],
    });
    expect(scoreQuizSession(questions, participants, 0)).toMatchObject({ distributed: 0, houseRemainder: 0 });
  });
});

describe("quiz session phases", () => {
  it("opens after announce, reveals after open, then announces the next question", () => {
    const announced: QuizPhaseState = { phase: "announce", questionIndex: 0, phaseEndsAt: null, paused: false, remainingMs: null };

    expect(transitionQuizPhase(announced, 2, 10_000, 30, 8)).toEqual({
      phase: "open", questionIndex: 0, phaseEndsAt: 40_000, paused: false, remainingMs: null,
    });
    expect(transitionQuizPhase({ ...announced, phase: "open" }, 2, 40_000, 30, 8)).toEqual({
      phase: "reveal", questionIndex: 0, phaseEndsAt: 48_000, paused: false, remainingMs: null,
    });
    expect(transitionQuizPhase({ ...announced, phase: "reveal" }, 2, 48_000, 30, 8)).toEqual({
      phase: "announce", questionIndex: 1, phaseEndsAt: null, paused: false, remainingMs: null,
    });
    expect(transitionQuizPhase({ ...announced, phase: "reveal", questionIndex: 1 }, 2, 56_000, 30, 8).phase).toBe("results");
  });

  it("freezes the remaining time on pause, resumes from it, and ends immediately", () => {
    const open: QuizPhaseState = { phase: "open", questionIndex: 0, phaseEndsAt: 40_000, paused: false, remainingMs: null };
    const paused = pauseQuizPhase(open, 27_500);

    expect(paused).toEqual({ phase: "open", questionIndex: 0, phaseEndsAt: null, paused: true, remainingMs: 12_500 });
    expect(resumeQuizPhase(paused, 100_000)).toEqual({
      phase: "open", questionIndex: 0, phaseEndsAt: 112_500, paused: false, remainingMs: null,
    });
    expect(endQuizPhase(paused)).toEqual({
      phase: "results", questionIndex: 0, phaseEndsAt: null, paused: false, remainingMs: null,
    });
  });
});
