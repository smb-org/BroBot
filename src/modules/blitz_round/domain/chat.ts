import { normalizeBlitzAnswer } from "./round";

export const blitzAnswerMatches = (message: string, acceptedAnswers: readonly string[]): boolean => {
  const normalizedMessage = normalizeBlitzAnswer(message);
  if (normalizedMessage.length === 0) return false;
  return acceptedAnswers.some((answer) => normalizeBlitzAnswer(answer) === normalizedMessage);
};
