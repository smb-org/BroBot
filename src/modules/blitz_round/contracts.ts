import { z } from "zod";
import type { ChatOutputTarget } from "../contract";

export const BLITZ_ROUND_MODULE_ID = "blitz_round";
export const BLITZ_QUESTION_MAXIMUM_COUNT = 500;
export const BLITZ_QUESTION_PAGE_SIZE = 25;
export const BLITZ_GRACE_SECONDS = 5;

export const blitzRoundSettingsSchema = z.object({
  prize: z.number().int().min(1).max(10_000).default(50),
  answerTimeSeconds: z.number().int().min(15).max(300).default(60),
  chatTarget: z.enum(["all_chats", "source_only", "where_asked"]).nullable().default(null),
  startText: z.string().min(1).max(500).default(""),
  solvedText: z.string().min(1).max(500).default(""),
  timeoutText: z.string().min(1).max(500).default(""),
});

export type BlitzRoundSettings = z.output<typeof blitzRoundSettingsSchema>;

export type BlitzQuestionKind = "scramble" | "quiz";

export interface BlitzQuestion {
  id: string;
  revision: number;
  kind: BlitzQuestionKind;
  prompt: string;
  answers: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlitzQuestionInput {
  kind: BlitzQuestionKind;
  prompt: string;
  answers: readonly string[];
  enabled: boolean;
}

export interface BlitzQuestionPage {
  questions: BlitzQuestion[];
  total: number;
  page: number;
}

export interface BlitzRoundData {
  questionId?: string;
  openedAt?: string;
  startedBy?: string;
  moduleActivationRevision?: number;
  kind: BlitzQuestionKind;
  prompt: string;
  answer: string;
  answers: string[];
  startText: string;
  prize: number;
  seconds: number;
  texts: { solvedText: string; timeoutText: string };
  language: "de" | "en";
  chatTarget: ChatOutputTarget | null;
}

export type BlitzQuestionValidationCode =
  | "invalid_question"
  | "invalid_kind"
  | "prompt_required"
  | "prompt_too_long"
  | "answer_count_invalid"
  | "answer_invalid"
  | "scramble_word_invalid"
  | "scramble_word_repeated";
