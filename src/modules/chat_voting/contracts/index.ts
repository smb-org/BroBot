import { z } from "zod";

export const CHAT_VOTING_MODULE_ID = "chat_voting";
export const CHAT_VOTING_ELEMENT_KIND = "chat_voting.tally";
export const CHAT_VOTING_ALARM_HANDLER = "close";

export const CHAT_VOTING_MAX_OPTIONS = 9;
export const CHAT_VOTING_HARD_LIMIT_MS = 4 * 60 * 60 * 1_000;
export const CHAT_VOTING_BALLOT_RETENTION_MS = 24 * 60 * 60 * 1_000 - 60_000;

export const chatVotingSettingsSchema = z.object({
  yesNoLabels: z.string().max(70).default(""),
  scaleLabels: z.string().max(175).default(""),
  optionLabels: z.string().max(315).default(""),
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
  autoCloseSeconds: 0,
  announceResult: true,
  resultText: "{vote.result}",
  resultTarget: "source_only",
};

export const CHAT_VOTING_PRESETS = ["yes_no", "scale_5", "options_n"] as const;
export type ChatVotingPreset = (typeof CHAT_VOTING_PRESETS)[number];
export type ChatVotePreset = ChatVotingPreset;

export const CHAT_VOTE_CLOSE_REASONS = ["manual", "timer", "limit"] as const;
export type ChatVoteCloseReason = (typeof CHAT_VOTE_CLOSE_REASONS)[number];

export interface ChatVote {
  id: string;
  channelId: string;
  preset: ChatVotingPreset;
  optionCount: number;
  labels: readonly string[];
  status: "open" | "closed";
  openedAt: string;
  closesAt: string;
  closedAt: string | null;
  closeReason: ChatVoteCloseReason;
  counts: readonly number[] | null;
  voterCount: number | null;
}

export interface ChatVoteDraft extends Omit<ChatVote, "status" | "closedAt" | "counts" | "voterCount"> {
  status?: "open";
}
