import { describe, expect, it } from "vitest";

import { validateQuizSet } from "../../src/modules/quiz/domain/sets";

const question = {
  text: "Which planet has rings?",
  options: ["Mars", "Saturn", "Venus"],
  correctIndex: 1,
  enabled: true,
};

describe("quiz set validation", () => {
  it("trims set text and accepts a 200-character question with up to four options", () => {
    const result = validateQuizSet({
      name: "  Space  ",
      questions: [{ ...question, text: "x".repeat(200), options: ["A", "B", "C", "D"] }],
    });

    expect(result).toEqual({
      ok: true,
      value: { name: "Space", questions: [{ ...question, text: "x".repeat(200), options: ["A", "B", "C", "D"] }] },
    });
  });

  it("rejects a question over 200 characters", () => {
    expect(validateQuizSet({ name: "Space", questions: [{ ...question, text: "x".repeat(201) }] }))
      .toEqual({ ok: false, code: "question_too_long" });
  });

  it("rejects option text over 80 characters", () => {
    expect(validateQuizSet({ name: "Space", questions: [{ ...question, options: ["x".repeat(81), "B"] }] }))
      .toEqual({ ok: false, code: "option_too_long" });
  });

  it("requires between two and four options and a matching correct index", () => {
    expect(validateQuizSet({ name: "Space", questions: [{ ...question, options: ["Only one"] }] }))
      .toEqual({ ok: false, code: "option_count_invalid" });
    expect(validateQuizSet({ name: "Space", questions: [{ ...question, correctIndex: 3 }] }))
      .toEqual({ ok: false, code: "correct_index_invalid" });
  });

  it("caps each set at one hundred questions", () => {
    expect(validateQuizSet({ name: "Space", questions: Array.from({ length: 101 }, () => question) }))
      .toEqual({ ok: false, code: "question_count_invalid" });
  });
});
