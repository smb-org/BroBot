import { z } from "zod";
import type { ChatOutputTarget } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";

export const BLITZ_ROUND_MODULE_ID = "blitz_round";
export const BLITZ_QUESTION_MAXIMUM_COUNT = 500;
export const BLITZ_QUESTION_PAGE_SIZE = 25;
export const BLITZ_GRACE_SECONDS = 5;
export const BLITZ_AUTO_START_MINUTES = 15;
export const BLITZ_AUTO_START_MAX_MINUTES = 240;

const blitzRoundSettingsObjectSchema = z.object({
  prize: z.number().int().min(1).max(10_000).default(50),
  answerTimeSeconds: z.number().int().min(15).max(300).default(60),
  autoStart: z.boolean().default(false),
  autoStartIntervalMinutes: z.number().int().min(BLITZ_AUTO_START_MINUTES).max(BLITZ_AUTO_START_MAX_MINUTES).default(BLITZ_AUTO_START_MINUTES),
  chatTarget: z.enum(["all_chats", "source_only", "where_asked"]).nullable().default(null),
  startText: z.string().max(500).default(""),
  startTextEnabled: z.boolean().optional(),
  solvedText: z.string().max(500).default(""),
  solvedTextEnabled: z.boolean().optional(),
  timeoutText: z.string().max(500).default(""),
  timeoutTextEnabled: z.boolean().optional(),
});

const validateBlitzRoundMessages = (settings: z.output<typeof blitzRoundSettingsObjectSchema>, context: z.RefinementCtx): void => {
  for (const key of ["startText", "solvedText", "timeoutText"] as const) {
    if (isMessageEnabled(settings, key, `${key}Enabled`) && settings[key].trim().length === 0) {
      context.addIssue({ code: "custom", path: [key], message: "message_text_missing" });
    }
  }
};

export const blitzRoundSettingsReadSchema = blitzRoundSettingsObjectSchema;
export const blitzRoundSettingsSchema = blitzRoundSettingsObjectSchema.superRefine(validateBlitzRoundMessages);

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
  autoStartBaseline?: string;
  kind: BlitzQuestionKind;
  prompt: string;
  answer: string;
  answers: string[];
  startText: string;
  startTextEnabled?: boolean;
  prize: number;
  seconds: number;
  texts: { solvedText: string; solvedTextEnabled?: boolean; timeoutText: string; timeoutTextEnabled?: boolean };
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
