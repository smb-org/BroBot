import type { ModuleLanguage } from "../../contract";
import { CHAT_VOTING_HARD_LIMIT_MS } from "../contracts";
import type { ChatVoteTerm, ChatVotingPreset, ChatVotingSettings, ChatVotingTextMode } from "../contracts";

export type VoteCommand =
  | { kind: "start"; preset: ChatVotingPreset; optionCount: number; textMode?: ChatVotingTextMode }
  | { kind: "end" }
  | { kind: "help" };

export type VoteLabelSetting = "yesNoLabels" | "scaleLabels" | "optionLabels" | "zeroOneLabels" | "oneTwoLabels";

export const isValidVoteLabelSetting = (value: string, setting: VoteLabelSetting): boolean => {
  if (value.trim().length === 0) return true;
  const labels = value.split("|").map((label) => label.trim());
  const [minimum, maximum] = setting === "yesNoLabels" || setting === "zeroOneLabels" || setting === "oneTwoLabels" ? [2, 2]
    : setting === "scaleLabels" ? [5, 5]
      : [2, 9];
  return labels.length >= minimum && labels.length <= maximum &&
    labels.every((label) => label.length > 0 && label.length <= 32);
};

export const parseVoteCommand = (text: string): VoteCommand | null => {
  const match = /^!vote(?:\s+([^\s]+))?(?:\s+([^\s]+))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  const argument = match[1]?.toLowerCase();
  const subargument = match[2]?.toLowerCase();
  if (argument === "end" && subargument === undefined) return { kind: "end" };
  if (argument === "yesno" && subargument === undefined) return { kind: "start", preset: "yes_no", optionCount: 2 };
  if (argument === "scale" && subargument === undefined) return { kind: "start", preset: "scale_5", optionCount: 5 };
  if (argument === "01" && subargument === undefined) return { kind: "start", preset: "digit_01", optionCount: 2 };
  if (argument === "12" && subargument === undefined) return { kind: "start", preset: "digit_12", optionCount: 2 };
  if (argument === "text" && (subargument === undefined || subargument === "word" || subargument === "message")) {
    return {
      kind: "start",
      preset: "free_text",
      optionCount: 0,
      textMode: subargument === "message" ? "whole_message" : "first_word",
    };
  }
  if (argument === "text") return { kind: "help" };
  if (subargument !== undefined) return { kind: "help" };
  if (argument !== undefined && /^[2-9]$/u.test(argument)) {
    return { kind: "start", preset: "options_n", optionCount: Number(argument) };
  }
  return { kind: "help" };
};

export const voteChoiceFromMessage = (text: string, preset: ChatVotingPreset, optionCount: number): number | null => {
  if (preset === "digit_01") return text === "0" ? 1 : text === "1" ? 2 : null;
  if (preset === "digit_12") return text === "1" ? 1 : text === "2" ? 2 : null;
  if (!/^[1-9]$/u.test(text)) return null;
  const choice = Number(text);
  return choice <= optionCount ? choice : null;
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
  if (preset === "free_text") return [];
  const setting = preset === "yes_no" ? settings.yesNoLabels
    : preset === "scale_5" ? settings.scaleLabels
      : preset === "options_n" ? settings.optionLabels
        : preset === "digit_01" ? settings.zeroOneLabels : settings.oneTwoLabels;
  const configured = configuredLabels(
    setting,
    optionCount,
    preset === "options_n",
  );
  if (configured !== null) return configured;
  if (preset === "yes_no") return language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  if (preset === "digit_01") return language === "de" ? ["Nein", "Ja"] : ["No", "Yes"];
  if (preset === "digit_12") return ["1", "2"];
  return Array.from({ length: optionCount }, (_, index) => String(index + 1));
};

const normalizeVoteText = (text: string): string => text.normalize("NFKC").toLowerCase()
  .replace(/[\p{P}]/gu, "")
  .replace(/\s+/gu, " ")
  .trim();

interface BlockedPatternWord {
  value: string;
  wildcardPrefix: boolean;
  wildcardSuffix: boolean;
}

/** Linear-time replacement for /^\*+/ and /\*+$/ (the trailing form backtracks quadratically). */
const stripEdgeStars = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "*") start += 1;
  while (end > start && text[end - 1] === "*") end -= 1;
  return text.slice(start, end);
};

const blockedPattern = (text: string): BlockedPatternWord[] => text.normalize("NFKC").toLowerCase()
  .split(/\s+/u)
  .flatMap((source) => {
    const wildcardPrefix = source.startsWith("*");
    const wildcardSuffix = source.endsWith("*");
    const value = normalizeVoteText(stripEdgeStars(source));
    return value.length === 0 ? [] : [{ value, wildcardPrefix, wildcardSuffix }];
  });

const firstCharacters = (text: string, maximum: number): string => Array.from(text).slice(0, maximum).join("");

/** Normalizes one free-text ballot message to a bounded, lowercased term. */
export const normalizeFreeTextVote = (text: string, mode: ChatVotingTextMode): string | null => {
  const normalized = normalizeVoteText(text);
  if (normalized.length === 0) return null;
  const value = mode === "first_word" ? normalized.split(" ")[0] ?? "" : normalized;
  // Trim after truncation: cutting at 25 can leave a trailing space that approval keys never have.
  const bounded = firstCharacters(value, 25).trim();
  return bounded.length === 0 ? null : bounded;
};

/** Normalizes message text before the stored term is truncated for tallying. */
export const normalizeFreeTextVoteForMatching = (text: string): string => normalizeVoteText(text);

/** Normalizes a blocked pattern while keeping Twitch's edge wildcards intact. */
export const normalizeBlockedVoteTerm = (text: string): string => {
  return blockedPattern(text).map(({ value, wildcardPrefix, wildcardSuffix }) =>
    `${wildcardPrefix ? "*" : ""}${value}${wildcardSuffix ? "*" : ""}`,
  ).join(" ");
};

/** Matches blocked words and phrases within the normalized chat message. */
export const isBlockedFreeTextVote = (vote: string, blockedTerms: readonly string[]): boolean => {
  const words = normalizeVoteText(vote).split(" ").filter((word) => word.length > 0);
  return blockedTerms.some((blockedTerm) => {
    const patternWords = blockedPattern(blockedTerm);
    if (patternWords.length === 0 || patternWords.length > words.length) return false;
    const matchingWord = (pattern: BlockedPatternWord, candidate: string): boolean => {
      if (pattern.wildcardPrefix && pattern.wildcardSuffix) return candidate.includes(pattern.value);
      if (pattern.wildcardPrefix) return candidate.endsWith(pattern.value);
      if (pattern.wildcardSuffix) return candidate.startsWith(pattern.value);
      return candidate === pattern.value;
    };
    const assignedPattern = Array<number>(words.length).fill(-1);
    const assignPatternWord = (patternIndex: number, seen: boolean[]): boolean => {
      const pattern = patternWords[patternIndex];
      if (pattern === undefined) return false;
      for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
        const candidate = words[wordIndex];
        if (candidate === undefined || seen[wordIndex] === true || !matchingWord(pattern, candidate)) continue;
        seen[wordIndex] = true;
        const previousPattern = assignedPattern[wordIndex] ?? -1;
        if (previousPattern === -1 || assignPatternWord(previousPattern, seen)) {
          assignedPattern[wordIndex] = patternIndex;
          return true;
        }
      }
      return false;
    };
    return patternWords.every((_pattern, index) => assignPatternWord(index, Array<boolean>(words.length).fill(false)));
  });
};

export const rankVoteTerms = (terms: readonly ChatVoteTerm[], limit = 5): ChatVoteTerm[] =>
  [...terms].sort((left, right) => right.count - left.count || (left.term < right.term ? -1 : left.term > right.term ? 1 : 0))
    .slice(0, limit);

export const formatFreeTextVoteResult = (terms: readonly ChatVoteTerm[], more: number, moreLabel: string): string => {
  const approved = rankVoteTerms(terms.filter(({ approved }) => approved));
  const total = terms.reduce((sum, { count }) => sum + count, 0);
  const lines = approved.map(({ term, count }) => `${term}: ${String(count)} (${String(total === 0 ? 0 : Math.round(count * 100 / total))}%)`);
  if (more > 0) lines.push(`${moreLabel}: ${String(more)}`);
  return lines.join(" · ");
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
