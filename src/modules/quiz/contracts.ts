import { z } from "zod";
import type { QuizPhaseState } from "./domain/session";

export const QUIZ_MODULE_ID = "quiz";
export const QUIZ_SET_MAXIMUM_COUNT = 50;
export const QUIZ_SET_PAGE_SIZE = 10;
export const QUIZ_QUESTION_MAXIMUM_COUNT = 100;
export const QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH = 200;
export const QUIZ_OPTION_MINIMUM_COUNT = 2;
export const QUIZ_OPTION_MAXIMUM_COUNT = 4;
export const QUIZ_OPTION_MAXIMUM_LENGTH = 80;

export const quizSettingsSchema = z.object({
  pot: z.number().int().min(0).max(100_000).default(500),
  answerSeconds: z.number().int().min(5).max(300).default(30),
  revealSeconds: z.number().int().min(1).max(60).default(8),
  chatQuestions: z.boolean().default(true),
});
export type QuizSettings = z.output<typeof quizSettingsSchema>;

export type QuizSessionQuestion = Pick<QuizQuestion, "text" | "options" | "correctIndex">;

export interface QuizSessionAggregates {
  participants: number;
  correctCounts: number[];
  answerDistribution: number[][];
  totalAnswers: number;
  totalCorrect: number;
  correctRate: number;
  distributed: number;
  houseRemainder: number;
}

interface QuizPauseInterval {
  startedAt: number;
  endedAt: number | null;
}

export interface QuizSessionRoundData extends QuizPhaseState {
  sessionId: string;
  setId: string;
  setName: string;
  language: "de" | "en";
  chatQuestions: boolean;
  pot: number;
  answerSeconds: number;
  revealSeconds: number;
  questions: QuizSessionQuestion[];
  aggregates?: QuizSessionAggregates;
  phaseOpenedAt: number | null;
  pauseIntervals: QuizPauseInterval[];
  offlineSince: number | null;
}

export interface QuizQuestion {
  position: number;
  text: string;
  options: string[];
  correctIndex: number;
  enabled: boolean;
}

export interface QuizSet {
  id: string;
  name: string;
  revision: number;
  questions: QuizQuestion[];
  createdAt: string;
  updatedAt: string;
}

export interface QuizSetSummary {
  id: string;
  name: string;
  revision: number;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuizSetInput {
  name: string;
  questions: readonly Omit<QuizQuestion, "position">[];
}

export interface QuizSetPage {
  sets: QuizSetSummary[];
  total: number;
  page: number;
}

export type QuizSetValidationCode =
  | "invalid_set"
  | "set_name_required"
  | "question_count_invalid"
  | "question_invalid"
  | "question_text_required"
  | "question_too_long"
  | "option_count_invalid"
  | "option_invalid"
  | "option_too_long"
  | "correct_index_invalid";
