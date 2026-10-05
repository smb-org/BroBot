import type { ModuleLanguage } from "../../contract";
import { CHAT_VOTING_HARD_LIMIT_MS } from "../contracts";
import type { ChatVotingPreset, ChatVotingSettings } from "../contracts";

export type VoteCommand =
  | { kind: "start"; preset: ChatVotingPreset; optionCount: number }
  | { kind: "end" }
  | { kind: "help" };

export type VoteLabelSetting = "yesNoLabels" | "scaleLabels" | "optionLabels";

export const isValidVoteLabelSetting = (value: string, setting: VoteLabelSetting): boolean => {
  if (value.trim().length === 0) return true;
  const labels = value.split("|").map((label) => label.trim());
  const [minimum, maximum] = setting === "yesNoLabels" ? [2, 2]
    : setting === "scaleLabels" ? [5, 5]
      : [2, 9];
  return labels.length >= minimum && labels.length <= maximum &&
    labels.every((label) => label.length > 0 && label.length <= 32);
};

export const parseVoteCommand = (text: string): VoteCommand | null => {
  const match = /^!vote(?:\s+([^\s]+))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  const argument = match[1]?.toLowerCase();
  if (argument === "end") return { kind: "end" };
  if (argument === "yesno") return { kind: "start", preset: "yes_no", optionCount: 2 };
  if (argument === "scale") return { kind: "start", preset: "scale_5", optionCount: 5 };
  if (argument !== undefined && /^[2-9]$/u.test(argument)) {
    return { kind: "start", preset: "options_n", optionCount: Number(argument) };
  }
  return { kind: "help" };
};

const configuredLabels = (value: string, count: number, allowAdditional = false): string[] | null => {
  const labels = value.split("|").map((label) => label.trim());
  const acceptedLength = allowAdditional ? labels.length >= count : labels.length === count;
  return acceptedLength && labels.slice(0, count).every((label) => label.length > 0 && label.length <= 32)
    ? labels.slice(0, count)
    : null;
};

export const labelsForVote = (
  settings: ChatVotingSettings,
  preset: ChatVotingPreset,
  optionCount: number,
  language: ModuleLanguage,
): string[] => {
  const configured = configuredLabels(
    preset === "yes_no" ? settings.yesNoLabels : preset === "scale_5" ? settings.scaleLabels : settings.optionLabels,
    optionCount,
    preset === "options_n",
  );
  if (configured !== null) return configured;
  if (preset === "yes_no") return language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  return Array.from({ length: optionCount }, (_, index) => String(index + 1));
};

export const formatVoteResult = (labels: readonly string[], counts: readonly number[]): string => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count, index) => {
    const label = labels[index] ?? String(index + 1);
    const percent = total === 0 ? 0 : Math.round(count * 100 / total);
    return `${label}: ${String(count)} (${String(percent)}%)`;
  }).join(" · ");
};

export const voteCloseDeadline = (openedAtMs: number, autoCloseSeconds: number): {
  closesAt: number;
  reason: "timer" | "limit";
} => autoCloseSeconds > 0
  ? { closesAt: openedAtMs + Math.min(autoCloseSeconds * 1_000, CHAT_VOTING_HARD_LIMIT_MS), reason: "timer" }
  : { closesAt: openedAtMs + CHAT_VOTING_HARD_LIMIT_MS, reason: "limit" };
