import {
  QUIZ_OPTION_MAXIMUM_COUNT,
  QUIZ_OPTION_MAXIMUM_LENGTH,
  QUIZ_OPTION_MINIMUM_COUNT,
  QUIZ_QUESTION_MAXIMUM_COUNT,
  QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH,
  type QuizSetInput,
  type QuizSetValidationCode,
} from "../contracts";

export type QuizSetValidation =
  | { ok: true; value: QuizSetInput }
  | { ok: false; code: QuizSetValidationCode };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const quizTextLength = (value: string): number => Array.from(value).length;

export const validateQuizSet = (value: unknown): QuizSetValidation => {
  if (!isRecord(value)) return { ok: false, code: "invalid_set" };
  if (typeof value.name !== "string" || value.name.trim().length === 0) return { ok: false, code: "set_name_required" };
  const name = value.name.trim();
  if (!Array.isArray(value.questions) || value.questions.length > QUIZ_QUESTION_MAXIMUM_COUNT) {
    return { ok: false, code: "question_count_invalid" };
  }

  const questions: QuizSetInput["questions"][number][] = [];
  for (const candidate of value.questions) {
    if (!isRecord(candidate) || typeof candidate.enabled !== "boolean") return { ok: false, code: "question_invalid" };
    if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
      return { ok: false, code: "question_text_required" };
    }
    const text = candidate.text.trim();
    if (quizTextLength(text) > QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH) return { ok: false, code: "question_too_long" };
    if (!Array.isArray(candidate.options) || candidate.options.length < QUIZ_OPTION_MINIMUM_COUNT || candidate.options.length > QUIZ_OPTION_MAXIMUM_COUNT) {
      return { ok: false, code: "option_count_invalid" };
    }
    if (candidate.options.some((option) => typeof option !== "string" || option.trim().length === 0)) {
      return { ok: false, code: "option_invalid" };
    }
    const options = candidate.options.map((option) => (option as string).trim());
    if (options.some((option) => quizTextLength(option) > QUIZ_OPTION_MAXIMUM_LENGTH)) return { ok: false, code: "option_too_long" };
    if (!Number.isSafeInteger(candidate.correctIndex) || (candidate.correctIndex as number) < 0 || (candidate.correctIndex as number) >= options.length) {
      return { ok: false, code: "correct_index_invalid" };
    }
    questions.push({ text, options, correctIndex: candidate.correctIndex as number, enabled: candidate.enabled });
  }

  return { ok: true, value: { name, questions } };
};
