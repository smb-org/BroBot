export interface QuizPhaseState {
  phase: "announce" | "open" | "reveal" | "results";
  questionIndex: number;
  phaseEndsAt: number | null;
  paused: boolean;
  remainingMs: number | null;
}

export interface QuizScoringQuestion {
  text: string;
  options: readonly string[];
  correctIndex: number;
}

export interface QuizScoringParticipant {
  accountId: string;
  login: string;
  answers: readonly (number | null)[];
  answerTimes: readonly (number | null)[];
}

export interface QuizScoringPauseInterval {
  startedAt: number;
  endedAt: number | null;
}

interface QuizRankingEntry {
  accountId: string;
  login: string;
  correct: number;
  rank: number;
  payout: number;
}

export interface QuizSessionScore {
  ranking: QuizRankingEntry[];
  correctCounts: number[];
  answerDistribution: number[][];
  participants: number;
  totalAnswers: number;
  totalCorrect: number;
  distributed: number;
  houseRemainder: number;
  correctRate: number;
}

export const scoreQuizSession = (
  questions: readonly QuizScoringQuestion[],
  participants: readonly QuizScoringParticipant[],
  pot: number,
  pauseIntervals: readonly QuizScoringPauseInterval[] = [],
): QuizSessionScore => {
  if (!Number.isSafeInteger(pot) || pot < 0) throw new RangeError("invalid_quiz_pot");
  const correctCounts = questions.map(() => 0);
  const answerDistribution = questions.map((question) => question.options.map(() => 0));
  const scored = participants.map((participant) => {
    let correct = 0;
    let acceptedAnswers = 0;
    for (const [questionIndex, question] of questions.entries()) {
      const choice = participant.answers[questionIndex];
      const answerAt = participant.answerTimes[questionIndex];
      if (typeof answerAt !== "number" || !Number.isSafeInteger(answerAt) || pauseIntervals.some(({ startedAt, endedAt }) =>
        answerAt >= startedAt && (endedAt === null || answerAt < endedAt))) continue;
      if (typeof choice !== "number" || !Number.isSafeInteger(choice) || choice < 0 || choice >= question.options.length) continue;
      acceptedAnswers += 1;
      const distribution = answerDistribution[questionIndex];
      if (distribution !== undefined) distribution[choice] = (distribution[choice] ?? 0) + 1;
      if (choice === question.correctIndex) {
        correct += 1;
        correctCounts[questionIndex] = (correctCounts[questionIndex] ?? 0) + 1;
      }
    }
    return acceptedAnswers === 0 ? null : { accountId: participant.accountId, login: participant.login, correct };
  }).filter((participant): participant is NonNullable<typeof participant> => participant !== null)
    .sort((left, right) => right.correct - left.correct || left.accountId.localeCompare(right.accountId));

  const totalCorrect = correctCounts.reduce((total, count) => total + count, 0);
  const totalAnswers = answerDistribution.reduce((total, counts) => total + counts.reduce((sum, count) => sum + count, 0), 0);
  const sharePerCorrectAnswer = totalCorrect === 0 ? 0 : Math.floor(pot / totalCorrect);
  let rank = 0;
  let previousCorrect: number | null = null;
  const ranking = scored.map((participant, index) => {
    if (participant.correct !== previousCorrect) rank = index + 1;
    previousCorrect = participant.correct;
    return { ...participant, rank, payout: participant.correct * sharePerCorrectAnswer };
  });
  const distributed = ranking.reduce((total, participant) => total + participant.payout, 0);
  return {
    ranking,
    correctCounts,
    answerDistribution,
    participants: scored.length,
    totalAnswers,
    totalCorrect,
    distributed,
    houseRemainder: pot - distributed,
    correctRate: totalAnswers === 0 ? 0 : totalCorrect / totalAnswers,
  };
};

export const transitionQuizPhase = (
  state: QuizPhaseState,
  questionCount: number,
  now: number,
  answerSeconds: number,
  revealSeconds: number,
): QuizPhaseState => {
  const base = { ...state, paused: false, remainingMs: null };
  if (state.phase === "announce") {
    return { ...base, phase: "open", phaseEndsAt: now + answerSeconds * 1_000 };
  }
  if (state.phase === "open") {
    return { ...base, phase: "reveal", phaseEndsAt: now + revealSeconds * 1_000 };
  }
  if (state.phase === "reveal") {
    return state.questionIndex + 1 < questionCount
      ? { ...base, phase: "announce", questionIndex: state.questionIndex + 1, phaseEndsAt: null }
      : { ...base, phase: "results", phaseEndsAt: null };
  }
  return state;
};

export const pauseQuizPhase = (state: QuizPhaseState, now: number): QuizPhaseState => {
  if (state.phase === "results" || state.paused) return state;
  return {
    ...state,
    phaseEndsAt: null,
    paused: true,
    remainingMs: state.phaseEndsAt === null ? 0 : Math.max(0, state.phaseEndsAt - now),
  };
};

export const resumeQuizPhase = (state: QuizPhaseState, now: number): QuizPhaseState => {
  if (!state.paused || state.phase === "results") return state;
  return {
    ...state,
    phaseEndsAt: now + (state.remainingMs ?? 0),
    paused: false,
    remainingMs: null,
  };
};

export const endQuizPhase = (state: QuizPhaseState): QuizPhaseState => ({
  ...state,
  phase: "results",
  phaseEndsAt: null,
  paused: false,
  remainingMs: null,
});
