import type { BlitzQuestionInput, BlitzQuestionValidationCode } from "../contracts";
import { normalizeBlitzAnswer } from "./round";

export type BlitzQuestionValidation =
  | { ok: true; value: BlitzQuestionInput }
  | { ok: false; code: BlitzQuestionValidationCode };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const length = (value: string): number => Array.from(value).length;

export const validateBlitzQuestion = (value: unknown): BlitzQuestionValidation => {
  if (!isRecord(value)) return { ok: false, code: "invalid_question" };
  if (value.kind !== "scramble" && value.kind !== "quiz") return { ok: false, code: "invalid_kind" };
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return { ok: false, code: "prompt_required" };
  const prompt = value.prompt.trim();
  if (length(prompt) > 120) return { ok: false, code: "prompt_too_long" };
  if (typeof value.enabled !== "boolean") return { ok: false, code: "invalid_question" };
  if (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 10) {
    return { ok: false, code: "answer_count_invalid" };
  }
  if (value.answers.some((answer) => typeof answer !== "string" || answer.trim().length === 0 || length(answer.trim()) > 60)) {
    return { ok: false, code: "answer_invalid" };
  }
  const answers = value.answers.map((answer) => (answer as string).trim());
  if (value.kind === "scramble") {
    const word = prompt.toLocaleUpperCase("de-DE");
    const letters = Array.from(word);
    if (letters.length < 4 || letters.length > 16 || !/^[A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df]+$/u.test(prompt)) {
      return { ok: false, code: "scramble_word_invalid" };
    }
    if (new Set(letters.map((letter) => letter.toLocaleLowerCase("de-DE"))).size === 1) {
      return { ok: false, code: "scramble_word_repeated" };
    }
    return { ok: true, value: { kind: "scramble", prompt: word, answers: [word], enabled: value.enabled } };
  }
  const seen = new Set<string>();
  for (const answer of answers) {
    if (normalizeBlitzAnswer(answer).length === 0) return { ok: false, code: "answer_invalid" };
    const key = answer.toLocaleLowerCase("de-DE");
    if (seen.has(key)) return { ok: false, code: "answer_invalid" };
    seen.add(key);
  }
  return { ok: true, value: { kind: "quiz", prompt, answers, enabled: value.enabled } };
};
