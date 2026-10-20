import { describe, expect, it } from "vitest";
import { validateBlitzQuestion } from "../../src/modules/blitz_round/domain/questions";

describe("blitz question validation", () => {
  it("canonicalizes scramble words and pins their only accepted answer [protects=scrambles display an uppercase solution with exactly one matching answer; fails_when=the saved answer differs from the solution; no_claim=does not test random shuffling]", () => {
    expect(validateBlitzQuestion({ kind: "scramble", prompt: " cloud ", answers: ["other"], enabled: true })).toEqual({
      ok: true,
      value: { kind: "scramble", prompt: "CLOUD", answers: ["CLOUD"], enabled: true },
    });
  });

  it("rejects invalid prompt and answer lengths [protects=question prompts cap at 120 characters and answers at 60; fails_when=overlong content is accepted; no_claim=does not check rendered template length]", () => {
    expect(validateBlitzQuestion({ kind: "quiz", prompt: "x".repeat(121), answers: ["yes"], enabled: true })).toMatchObject({ ok: false, code: "prompt_too_long" });
    expect(validateBlitzQuestion({ kind: "quiz", prompt: "Question?", answers: ["x".repeat(61)], enabled: true })).toMatchObject({ ok: false, code: "answer_invalid" });
  });

  it("requires a varied four-to-sixteen-letter scramble word [protects=scrambles can be rearranged and meet the configured length; fails_when=a repeated-only or out-of-range word is accepted; no_claim=does not prove every random shuffle is distinct]", () => {
    expect(validateBlitzQuestion({ kind: "scramble", prompt: "AAA A", answers: ["AAAA"], enabled: true })).toMatchObject({ ok: false, code: "scramble_word_invalid" });
    expect(validateBlitzQuestion({ kind: "scramble", prompt: "AAAA", answers: ["AAAA"], enabled: true })).toMatchObject({ ok: false, code: "scramble_word_repeated" });
    expect(validateBlitzQuestion({ kind: "scramble", prompt: "ABCDEFGHIJKLMNOPQ", answers: ["ABCDEFGHIJKLMNOPQ"], enabled: true })).toMatchObject({ ok: false, code: "scramble_word_invalid" });
  });

  it("normalizes and validates quiz answers [protects=quiz answers are trimmed and distinct without losing the displayed first answer; fails_when=duplicate answers differ only by case or the first answer is reordered; no_claim=does not verify answer matching against chat messages]", () => {
    expect(validateBlitzQuestion({ kind: "quiz", prompt: " Which cloud? ", answers: [" Cloud ", "Blue"], enabled: false })).toEqual({
      ok: true,
      value: { kind: "quiz", prompt: "Which cloud?", answers: ["Cloud", "Blue"], enabled: false },
    });
    expect(validateBlitzQuestion({ kind: "quiz", prompt: "Question?", answers: ["Cloud", "cloud"], enabled: true })).toMatchObject({ ok: false, code: "answer_invalid" });
  });
});
