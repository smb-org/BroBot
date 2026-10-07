import { z } from "zod";

export const CHAT_VOTING_MODULE_ID = "chat_voting";
export const CHAT_VOTING_ELEMENT_KIND = "chat_voting.tally";
export const CHAT_VOTING_ALARM_HANDLER = "close";

export const CHAT_VOTING_MAX_OPTIONS = 9;
export const CHAT_VOTING_MAX_TEXT_TERMS = 200;
export const CHAT_VOTING_TITLE_MAX_LENGTH = 80;
export const CHAT_VOTING_HARD_LIMIT_MS = 4 * 60 * 60 * 1_000;
export const CHAT_VOTING_BALLOT_RETENTION_MS = 24 * 60 * 60 * 1_000 - 60_000;

// Label lists are measured in Unicode code points, like the per-label rule (an emoji counts as one).
const labelList = (maxCodePoints: number) =>
  z.string().refine((value) => Array.from(value).length <= maxCodePoints).default("");

export const chatVotingSettingsSchema = z.object({
  yesNoLabels: labelList(70),
  scaleLabels: labelList(175),
  optionLabels: labelList(315),
  zeroOneLabels: labelList(70),
  oneTwoLabels: labelList(70),
  autoCloseSeconds: z.number().int().min(0).max(CHAT_VOTING_HARD_LIMIT_MS / 1_000).default(0),
  announceResult: z.boolean().default(true),
  resultText: z.string().max(500).default("{vote.result}"),
  resultTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
});

export type ChatVotingSettings = z.output<typeof chatVotingSettingsSchema>;

export const DEFAULT_CHAT_VOTING_SETTINGS: ChatVotingSettings = {
  yesNoLabels: "",
  scaleLabels: "",
  optionLabels: "",
  zeroOneLabels: "",
  oneTwoLabels: "",
  autoCloseSeconds: 0,
  announceResult: true,
  resultText: "{vote.result}",
  resultTarget: "source_only",
};

export const CHAT_VOTING_PRESETS = ["yes_no", "scale_5", "options_n", "digit_01", "digit_12", "free_text"] as const;
export type ChatVotingPreset = (typeof CHAT_VOTING_PRESETS)[number];
export type ChatVotePreset = ChatVotingPreset;
export const CHAT_VOTING_TEXT_MODES = ["first_word", "whole_message"] as const;
export type ChatVotingTextMode = (typeof CHAT_VOTING_TEXT_MODES)[number];

export interface ChatVoteTerm {
  term: string;
  count: number;
  approved: boolean;
}

export const CHAT_VOTE_CLOSE_REASONS = ["manual", "timer", "limit"] as const;
export type ChatVoteCloseReason = (typeof CHAT_VOTE_CLOSE_REASONS)[number];

export interface ChatVote {
  id: string;
  channelId: string;
  preset: ChatVotingPreset;
  optionCount: number;
  labels: readonly string[];
  title: string | null;
  textMode?: ChatVotingTextMode | null;
  termFilterReady?: boolean | null;
  status: "open" | "closed";
  openedAt: string;
  closesAt: string;
  requestedDurationSeconds: number | null;
  closedAt: string | null;
  closeReason: ChatVoteCloseReason;
  counts: readonly number[] | null;
  voterCount: number | null;
  textResults?: readonly ChatVoteTerm[] | null;
  moreTerms?: number | null;
}

export interface ChatVoteDraft extends Omit<ChatVote, "status" | "closedAt" | "counts" | "voterCount"> {
  status?: "open";
}
