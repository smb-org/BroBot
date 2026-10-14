import { z } from "zod";
import { DEFAULT_CHAT_VOTING_START_TEXT } from "./chat-defaults";
import { templateTextLength } from "../../../contracts/template-text-length";

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

export const chatVotingSettingsSchema = z.object({
  autoCloseSeconds: z.number().int().min(0).max(CHAT_VOTING_HARD_LIMIT_MS / 1_000).default(0),
  startText: z.string().refine((text) => templateTextLength(text) <= 500).default(DEFAULT_CHAT_VOTING_START_TEXT),
  announceResult: z.boolean().default(true),
  resultText: z.string().refine((text) => templateTextLength(text) <= 500).default("{vote.result}"),
  resultTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
});

export type ChatVotingSettings = z.output<typeof chatVotingSettingsSchema>;

export const DEFAULT_CHAT_VOTING_SETTINGS: ChatVotingSettings = {
  autoCloseSeconds: 0,
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
  title: string | null;
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
  labels: readonly string[];
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
  labels: readonly string[];
  freeTextMode: ChatVotingTextMode | null;
  durationSeconds: number;
}
