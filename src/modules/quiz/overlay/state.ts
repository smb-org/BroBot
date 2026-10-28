import type { JsonObject, ModuleOverlaySnapshotContext } from "../../contract";
import { quizTextLength } from "../domain/sets";

type QuizOverlayPhase = "idle" | "announce" | "open" | "reveal" | "results";
export const QUIZ_RESULTS_DISPLAY_MS = 60_000;

interface QuizOverlayRankingEntry {
  login: string;
  correct: number;
  rank: number;
}

export interface QuizOverlayState {
  sessionId: string;
  phaseSequence: number;
  sessionStartedAt: string;
  phase: QuizOverlayPhase;
  questionIndex: number;
  questionCount: number;
  question: string;
  options: readonly string[];
  phaseEndsAt: string | null;
  paused: boolean;
  remainingMs: number | null;
  serverNow?: string;
  resultAt?: string;
  correctIndex?: number;
  answerDistribution?: readonly number[];
  ranking?: readonly QuizOverlayRankingEntry[];
}

export interface QuizOverlayConfig {
  showQuestionProgress: boolean;
  showPercent: boolean;
  backgroundColor: string;
  textColor: string;
  secondaryColor: string;
  accentColor: string;
  correctColor: string;
}

export const DEFAULT_QUIZ_OVERLAY_CONFIG: QuizOverlayConfig = {
  showQuestionProgress: true,
  showPercent: true,
  backgroundColor: "#10141b",
  textColor: "#f2f5f9",
  secondaryColor: "#a8b2c1",
  accentColor: "#5fa4ff",
  correctColor: "#32ca88",
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDateString = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);

export const parseQuizOverlayConfig = (value: unknown): QuizOverlayConfig | null => {
  const config = record(value);
  if (config === null || Object.keys(config).some((key) => ![
    "showQuestionProgress", "showPercent", "backgroundColor", "textColor", "secondaryColor", "accentColor", "correctColor",
  ].includes(key))) return null;

  const parsed = {
    showQuestionProgress: config.showQuestionProgress ?? DEFAULT_QUIZ_OVERLAY_CONFIG.showQuestionProgress,
    showPercent: config.showPercent ?? DEFAULT_QUIZ_OVERLAY_CONFIG.showPercent,
    backgroundColor: config.backgroundColor ?? DEFAULT_QUIZ_OVERLAY_CONFIG.backgroundColor,
    textColor: config.textColor ?? DEFAULT_QUIZ_OVERLAY_CONFIG.textColor,
    secondaryColor: config.secondaryColor ?? DEFAULT_QUIZ_OVERLAY_CONFIG.secondaryColor,
    accentColor: config.accentColor ?? DEFAULT_QUIZ_OVERLAY_CONFIG.accentColor,
    correctColor: config.correctColor ?? DEFAULT_QUIZ_OVERLAY_CONFIG.correctColor,
  };
  return typeof parsed.showQuestionProgress === "boolean" && typeof parsed.showPercent === "boolean" &&
    isColor(parsed.backgroundColor) && isColor(parsed.textColor) && isColor(parsed.secondaryColor) &&
    isColor(parsed.accentColor) && isColor(parsed.correctColor)
    ? parsed as QuizOverlayConfig
    : null;
};

/** Accepts only the fields needed to display the current phase and drops answers outside reveal. */
export const parseQuizOverlayState = (value: unknown): QuizOverlayState | null => {
  const state = record(value);
  if (state === null || typeof state.sessionId !== "string" || state.sessionId.length === 0 ||
      !isNonNegativeInteger(state.phaseSequence) || !isDateString(state.sessionStartedAt) ||
      !(state.phase === "idle" || state.phase === "announce" || state.phase === "open" || state.phase === "reveal" || state.phase === "results")) return null;

  if (state.phase === "idle") {
    return {
      sessionId: state.sessionId,
      phaseSequence: state.phaseSequence,
      sessionStartedAt: state.sessionStartedAt,
      phase: "idle",
      questionIndex: 0,
      questionCount: 1,
      question: "",
      options: [],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      ...(isDateString(state.serverNow) ? { serverNow: state.serverNow } : {}),
    };
  }

  if (
      !isNonNegativeInteger(state.questionIndex) || !isNonNegativeInteger(state.questionCount) ||
      state.questionCount === 0 || state.questionIndex >= state.questionCount ||
      typeof state.question !== "string" || quizTextLength(state.question) > 200 ||
      !Array.isArray(state.options) || state.options.length < 2 || state.options.length > 4 ||
      !state.options.every((option) => typeof option === "string" && quizTextLength(option) <= 80) ||
      !(state.phaseEndsAt === null || typeof state.phaseEndsAt === "string" && Number.isFinite(Date.parse(state.phaseEndsAt))) ||
      typeof state.paused !== "boolean" || !(state.remainingMs === null || isNonNegativeInteger(state.remainingMs))) return null;

  const parsed: QuizOverlayState = {
    sessionId: state.sessionId,
    phaseSequence: state.phaseSequence,
    sessionStartedAt: state.sessionStartedAt,
    phase: state.phase,
    questionIndex: state.questionIndex,
    questionCount: state.questionCount,
    question: state.question,
    options: state.options as string[],
    phaseEndsAt: state.phaseEndsAt,
    paused: state.paused,
    remainingMs: state.remainingMs,
    ...(typeof state.serverNow === "string" && Number.isFinite(Date.parse(state.serverNow)) ? { serverNow: state.serverNow } : {}),
  };

  if (parsed.phase === "reveal") {
    if (!isNonNegativeInteger(state.correctIndex) || state.correctIndex >= parsed.options.length ||
        !Array.isArray(state.answerDistribution) || state.answerDistribution.length !== parsed.options.length ||
        !state.answerDistribution.every(isNonNegativeInteger)) return null;
    parsed.correctIndex = state.correctIndex;
    parsed.answerDistribution = state.answerDistribution;
  }

  if (parsed.phase === "results") {
    const resultAt = isDateString(state.resultAt) ? state.resultAt
      : isDateString(state.resolvedAt) ? state.resolvedAt : undefined;
    if (resultAt !== undefined) parsed.resultAt = resultAt;
    const ranking = Array.isArray(state.ranking) ? state.ranking.slice(0, 10).flatMap((entry) => {
      const rank = record(entry);
      return rank !== null && typeof rank.login === "string" && rank.login.length > 0 && rank.login.length <= 25 &&
        isNonNegativeInteger(rank.correct) && isNonNegativeInteger(rank.rank)
        ? [{ login: rank.login, correct: rank.correct, rank: rank.rank }]
        : [];
    }) : [];
    parsed.ranking = ranking;
  }

  return parsed;
};

export const loadQuizOverlayState = async (
  context: Pick<ModuleOverlaySnapshotContext, "now" | "readSnapshot"> | undefined,
): Promise<JsonObject | null> => {
  if (context?.readSnapshot === undefined) return null;
  const state = parseQuizOverlayState(await context.readSnapshot());
  if (state === null) return null;
  const serverNow = new Date(context.now).toISOString();
  if (state.phase === "results" && (state.resultAt === undefined ||
      context.now >= Date.parse(state.resultAt) + QUIZ_RESULTS_DISPLAY_MS)) {
    return {
      sessionId: state.sessionId,
      phaseSequence: state.phaseSequence,
      sessionStartedAt: state.sessionStartedAt,
      phase: "idle",
      questionIndex: 0,
      questionCount: 1,
      question: "",
      options: [],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      serverNow,
    };
  }
  return { ...state, serverNow } as unknown as JsonObject;
};

/** Phase sequence orders quiz snapshots and events independently of clock calibration. */
export const mergeQuizOverlayRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const parsed = parseQuizOverlayState(incoming);
  if (parsed === null) return {};
  const previous = parseQuizOverlayState(current);
  if (previous === null) return parsed as unknown as Readonly<Record<string, unknown>>;

  const previousTime = previous.serverNow === undefined ? Number.NaN : Date.parse(previous.serverNow);
  const incomingTime = parsed.serverNow === undefined ? Number.NaN : Date.parse(parsed.serverNow);
  const calibratedServerNow = Number.isFinite(previousTime) && Number.isFinite(incomingTime)
    ? incomingTime > previousTime ? parsed.serverNow : previous.serverNow
    : parsed.serverNow ?? previous.serverNow;
  const retainPrevious = (): Readonly<Record<string, unknown>> => ({
    ...previous,
    ...(calibratedServerNow === undefined ? {} : { serverNow: calibratedServerNow }),
  });

  if (parsed.phaseSequence <= previous.phaseSequence) return retainPrevious();

  return {
    ...parsed,
    ...(calibratedServerNow === undefined ? {} : { serverNow: calibratedServerNow }),
  };
};
