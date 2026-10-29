import type { QuizSessionRoundData } from "../contracts";

export const quizPhasePayload = (data: QuizSessionRoundData): Record<string, unknown> => {
  const question = data.questions[data.questionIndex];
  return {
    sessionId: data.sessionId,
    setName: data.setName,
    phaseSequence: data.phaseSequence ?? 0,
    sessionStartedAt: data.sessionStartedAt ?? new Date().toISOString(),
    questionIndex: data.questionIndex,
    questionCount: data.questions.length,
    question: question?.text ?? "",
    options: question === undefined ? [] : [...question.options],
    phase: data.phase,
    phaseEndsAt: data.phaseEndsAt === null ? null : new Date(data.phaseEndsAt).toISOString(),
    paused: data.paused,
    remainingMs: data.paused ? data.remainingMs : null,
  };
};
