import { z } from "zod";
import { DEFAULT_CHAT_VOTING_START_TEXT } from "./chat-defaults";
import { templateTextLength } from "../../../contracts/template-text-length";
import { chatVoteAnswerColorsSchema } from "./chat-vote-colors-schema";
import { isMessageEnabled } from "../../../contracts/message-enabled";

export { DEFAULT_CHAT_VOTING_START_TEXT, DEFAULT_CHAT_VOTING_START_TEXT_EN } from "./chat-defaults";

export const CHAT_VOTING_MODULE_ID = "chat_voting";
export const CHAT_VOTING_ELEMENT_KIND = "chat_voting.tally";
export const CHAT_VOTING_ALARM_HANDLER = "close";
export const CHAT_VOTING_START_ANNOUNCEMENT_HANDLER = "announce_start";
const CHAT_VOTING_START_ANNOUNCEMENT_ALARM_PREFIX = "start:";

export const chatVotingStartAnnouncementAlarmKey = (pollId: string): string =>
  `${CHAT_VOTING_START_ANNOUNCEMENT_ALARM_PREFIX}${pollId}`;

export const chatVotingStartAnnouncementPollId = (alarmKey: string): string | null => {
  if (!alarmKey.startsWith(CHAT_VOTING_START_ANNOUNCEMENT_ALARM_PREFIX)) return null;
  const pollId = alarmKey.slice(CHAT_VOTING_START_ANNOUNCEMENT_ALARM_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/u.test(pollId) ? pollId : null;
};

export const CHAT_VOTING_TITLE_MAX_LENGTH = 80;
export const CHAT_VOTING_HARD_LIMIT_MS = 4 * 60 * 60 * 1_000;
export const CHAT_VOTING_BALLOT_RETENTION_MS = 24 * 60 * 60 * 1_000 - 60_000;

const chatVotingSettingsObjectSchema = z.object({
  autoCloseSeconds: z.number().int().min(0).max(CHAT_VOTING_HARD_LIMIT_MS / 1_000).default(120),
  startText: z.string().refine((text) => templateTextLength(text) <= 500).default(DEFAULT_CHAT_VOTING_START_TEXT),
  startTextEnabled: z.boolean().optional(),
  announceResult: z.boolean().default(true),
  resultText: z.string().refine((text) => templateTextLength(text) <= 500).default("{vote.result}"),
  resultTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
});

export const chatVotingSettingsSchema = chatVotingSettingsObjectSchema.superRefine((settings, context) => {
  if (isMessageEnabled(settings, "startText", "startTextEnabled") && settings.startText.trim().length === 0) {
    context.addIssue({ code: "custom", path: ["startText"], message: "message_text_missing" });
  }
});

export type ChatVotingSettings = z.output<typeof chatVotingSettingsSchema>;

export const DEFAULT_CHAT_VOTING_SETTINGS: ChatVotingSettings = {
  autoCloseSeconds: 120,
  startText: DEFAULT_CHAT_VOTING_START_TEXT,
  announceResult: true,
  resultText: "{vote.result}",
  resultTarget: "source_only",
};

export type ChatVotingPreset = "yes_no" | "scale_5" | "options_n" | "digit_01" | "digit_12" | "free_text";
export type ChatVotePreset = ChatVotingPreset;
export type ChatVotingKind = "yes_no" | "options" | "free_text";
export const chatVotingKindForPreset = (preset: ChatVotingPreset): ChatVotingKind =>
  preset === "free_text" ? "free_text" : preset === "yes_no" ? "yes_no" : "options";
export const chatVotingPresetForKind = (kind: ChatVotingKind): ChatVotingPreset =>
  kind === "free_text" ? "free_text" : kind === "yes_no" ? "yes_no" : "options_n";
export type ChatVotingTextMode = "first_word" | "whole_message";

export interface ChatVoteTerm {
  term: string;
  count: number;
  approved: boolean;
}

export type ChatVoteCloseReason = "manual" | "timer" | "limit";

export interface ChatVote {
  id: string;
  channelId: string;
  kind: ChatVotingKind;
  optionCount: number;
  labels: readonly string[];
  answerColors: readonly string[];
  title: string | null;
  resultText?: string | null;
  textMode?: ChatVotingTextMode | null;
  termFilterReady?: boolean | null;
  status: "open" | "closing" | "closed";
  openedAt: string;
  closesAt: string;
  requestedDurationSeconds: number | null;
  closedAt: string | null;
  closeReason: ChatVoteCloseReason;
  counts: readonly number[] | null;
  voterCount: number | null;
  textResults?: readonly ChatVoteTerm[] | null;
  moreTerms?: number | null;
  closingAt?: string | null;
  deadlineRevision?: number;
  resultDeliveryPending?: boolean;
}

export interface ChatVoteDraft extends Omit<ChatVote, "status" | "closedAt" | "counts" | "voterCount"> {
  status?: "open";
}

export const CHAT_VOTE_TEMPLATE_MAXIMUM = 100;
export const CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS = [
  "end", "help", "again", "yesno", "scale", "text", "word", "message",
] as const;
type ChatVoteTemplateLegacyAlias = "yesno" | "zeroOne" | "oneTwo" | "scale" | "options";

export interface ChatVoteTemplate {
  id: string;
  channelId: string;
  shortcut: string | null;
  title: string;
  resultText?: string;
  labels: readonly string[];
  answerColors: readonly string[];
  offerInCockpit: boolean;
  freeTextMode: ChatVotingTextMode | null;
  durationSeconds: number;
  revision: number;
  legacyAlias: ChatVoteTemplateLegacyAlias | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatVoteTemplateDraft {
  shortcut: string | null;
  title: string;
  resultText?: string;
  labels: readonly string[];
  answerColors: readonly string[];
  offerInCockpit: boolean;
  freeTextMode: ChatVotingTextMode | null;
  durationSeconds: number;
}

export const chatVoteTemplateDraftSchema = z.object({
  shortcut: z.string().nullable(),
  title: z.string().refine((title) => Array.from(title).length <= CHAT_VOTING_TITLE_MAX_LENGTH),
  resultText: z.string().optional(),
  labels: z.array(z.string()).max(9),
  answerColors: chatVoteAnswerColorsSchema,
  freeTextMode: z.enum(["first_word", "whole_message"]).nullable(),
  durationSeconds: z.number().int().min(0).max(CHAT_VOTING_HARD_LIMIT_MS / 1_000),
  offerInCockpit: z.boolean(),
}).superRefine((template, context) => {
  if (template.answerColors.length !== template.labels.length) {
    context.addIssue({ code: "custom", path: ["answerColors"], message: "Each answer needs one color." });
  }
  if (template.shortcut === null && !template.offerInCockpit) {
    context.addIssue({ code: "custom", path: ["offerInCockpit"], message: "Add a shortcut or offer this vote in the cockpit." });
  }
});
