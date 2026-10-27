export const QUIZ_MODULE_ID = "quiz";
export const QUIZ_SET_MAXIMUM_COUNT = 50;
export const QUIZ_SET_PAGE_SIZE = 10;
export const QUIZ_QUESTION_MAXIMUM_COUNT = 100;
export const QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH = 200;
export const QUIZ_OPTION_MINIMUM_COUNT = 2;
export const QUIZ_OPTION_MAXIMUM_COUNT = 4;
export const QUIZ_OPTION_MAXIMUM_LENGTH = 80;

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
