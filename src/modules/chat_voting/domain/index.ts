import type { ModuleLanguage } from "../../contract";
import { CHAT_VOTING_HARD_LIMIT_MS, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import { CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS } from "../contracts";
import type { ChatVoteTemplate, ChatVoteTerm, ChatVotingKind, ChatVotingPreset, ChatVotingSettings, ChatVotingTextMode } from "../contracts";
import { chatVotingFreeTextOptionText } from "../contracts/chat-defaults";

export type VoteCommand =
  | { kind: "start"; voteKind: ChatVotingKind; preset: ChatVotingPreset; optionCount: number; labels?: readonly string[]; textMode?: ChatVotingTextMode; title: string | null; durationSeconds?: number }
  | { kind: "template"; shortcut: string }
  | { kind: "legacyAlias"; alias: "yesno" | "scale" | "zeroOne" | "oneTwo"; title: string | null }
  | { kind: "again" }
  | { kind: "end" }
  | { kind: "invalid"; problem: "question" | "questionTooLong" | "answerCount" | "labels" | "duration" }
  | { kind: "help" };

export const CHAT_VOTING_LABEL_MAX_LENGTH = 32;

export const voteLabelLength = (label: string): number => Array.from(label).length;

export const normalizeVoteTitle = (title: string): string | null => title.trim() || null;

export const isValidVoteTitle = (title: string): boolean =>
  voteLabelLength(normalizeVoteTitle(title) ?? "") <= CHAT_VOTING_TITLE_MAX_LENGTH;

export const isValidVoteLabel = (label: string): boolean => {
  const trimmed = label.trim();
  const length = voteLabelLength(trimmed);
  return length > 0 && length <= CHAT_VOTING_LABEL_MAX_LENGTH &&
    normalizeFreeTextVoteForMatching(trimmed).length > 0;
};

export const validateVoteLabels = (
  labels: readonly string[],
  minimum = 2,
  maximum = 9,
): boolean => {
  if (labels.length < minimum || labels.length > maximum || !labels.every(isValidVoteLabel)) return false;
  const normalized = labels.map(normalizeFreeTextVoteForMatching);
  return new Set(normalized).size === normalized.length;
};

export const isValidTemplateShortcut = (shortcut: string | null): boolean =>
  shortcut === null || (/^[a-z][a-z0-9_-]{0,23}$/u.test(shortcut) &&
    !(CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS as readonly string[]).includes(shortcut));

export type TemplateStartProblem = "answers" | "duration" | null;

export const templateStartProblem = (
  template: Pick<ChatVoteTemplate, "labels" | "freeTextMode" | "durationSeconds">,
): TemplateStartProblem => {
  if (!Number.isSafeInteger(template.durationSeconds) || template.durationSeconds < 0 || template.durationSeconds > 14_400) {
    return "duration";
  }
  if (template.freeTextMode !== null) return null;
  return validateVoteLabels(template.labels, 2, 9) ? null : "answers";
};

export const chatVoteTemplateConfiguration = (
  template: ChatVoteTemplate,
  titleOverride?: string | null,
) => {
  const voteKind: ChatVotingKind = template.freeTextMode === null ? "options" : "free_text";
  return {
    voteKind,
    optionCount: voteKind === "free_text" ? 0 : template.labels.length,
    ...(voteKind === "free_text" ? { textMode: template.freeTextMode ?? "first_word" } : { labels: template.labels }),
    title: normalizeVoteTitle(titleOverride ?? template.title),
    durationSeconds: template.durationSeconds,
  };
};

/** Splits off the first whitespace-delimited token of trimmed text in linear time (no regex backtracking). */
const splitFirstToken = (text: string): [token: string, rest: string] => {
  let end = 0;
  while (end < text.length && !/\s/u.test(text[end] as string)) end += 1;
  return [text.slice(0, end), text.slice(end).trim()];
};

const startCommand = (
  voteKind: ChatVotingKind,
  preset: ChatVotingPreset,
  optionCount: number,
  title: string,
  labels?: readonly string[],
  textMode?: ChatVotingTextMode,
  durationSeconds?: number,
): VoteCommand => {
  const normalizedTitle = normalizeVoteTitle(title);
  if (normalizedTitle !== null && voteLabelLength(normalizedTitle) > CHAT_VOTING_TITLE_MAX_LENGTH) {
    return { kind: "invalid", problem: "questionTooLong" };
  }
  if (labels !== undefined && !validateVoteLabels(labels, 2, 9)) return { kind: "invalid", problem: "labels" };
  return {
    kind: "start",
    voteKind,
    preset,
    optionCount,
    ...(labels === undefined ? {} : { labels }),
    ...(textMode === undefined ? {} : { textMode }),
    title: normalizedTitle,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
};

const parseInlineOptions = (tail: string): VoteCommand => {
  const segments = tail.split("|").map((segment) => segment.trim());
  const question = segments[0] ?? "";
  if (!question.endsWith("?")) return { kind: "invalid", problem: "question" };
  let durationSeconds: number | undefined;
  const last = segments.at(-1) ?? "";
  if (/^\d{1,3}(s|m|h)$/u.test(last)) {
    const amount = Number(last.slice(0, -1));
    const unit = last.at(-1);
    const multiplier = unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
    durationSeconds = amount * multiplier;
    if (durationSeconds < 1 || durationSeconds > 14_400) return { kind: "invalid", problem: "duration" };
    segments.pop();
  }
  const labels = segments.slice(1);
  if (labels.length < 2 || labels.length > 9) return { kind: "invalid", problem: "answerCount" };
  return startCommand("options", "options_n", labels.length, question, labels, undefined, durationSeconds);
};

export const parseVoteCommand = (text: string): VoteCommand | null => {
  const [command, tail] = splitFirstToken(text.trim());
  if (command.toLowerCase() !== "!vote") return null;
  if (tail.length === 0 || tail.toLowerCase() === "help") return { kind: "help" };
  if (tail.toLowerCase() === "end") return { kind: "end" };
  if (tail.toLowerCase() === "again") return { kind: "again" };
  if (tail.includes("|")) return parseInlineOptions(tail);

  const [rawArgument, remainder] = splitFirstToken(tail);
  const argument = rawArgument.length === 0 ? undefined : rawArgument.toLowerCase();
  const alias = argument === "yesno" ? "yesno" : argument === "scale" ? "scale" : argument === "01" ? "zeroOne" : argument === "12" ? "oneTwo" : null;
  if (alias !== null) {
    const title = normalizeVoteTitle(remainder);
    return isValidVoteTitle(title ?? "") ? { kind: "legacyAlias", alias, title } : { kind: "invalid", problem: "questionTooLong" };
  }
  if (argument === "text") {
    const [modeToken, modeRest] = splitFirstToken(remainder);
    const mode = modeToken.toLowerCase();
    const hasMode = mode === "word" || mode === "message";
    const title = hasMode ? modeRest : remainder;
    return startCommand("free_text", "free_text", 0, title, undefined,
      mode === "message" ? "whole_message" : "first_word");
  }
  if (argument !== undefined && /^[2-9]$/u.test(argument)) {
    return startCommand("options", "options_n", Number(argument), remainder);
  }
  if (tail.endsWith("?")) return startCommand("yes_no", "yes_no", 2, tail);
  if (argument !== undefined && remainder.length === 0) return { kind: "template", shortcut: argument };
  return { kind: "help" };
};

export interface VoteChoice {
  choice: number;
  source: "number" | "word";
}

export const voteChoiceFromMessage = (
  text: string,
  kind: ChatVotingKind,
  optionCount: number,
  labels: readonly string[] = [],
): VoteChoice | null => {
  const trimmed = text.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    const choice = Number(trimmed);
    if (Number.isSafeInteger(choice) && choice <= optionCount) return { choice, source: "number" };
  }
  if (kind !== "options") return null;
  const normalizedText = normalizeFreeTextVoteForMatching(trimmed);
  if (normalizedText.length === 0) return null;
  const index = labels.findIndex((label) => {
    const normalizedLabel = normalizeFreeTextVoteForMatching(label);
    return normalizedLabel.length > 0 && !/^\p{N}+$/u.test(normalizedLabel) && normalizedLabel === normalizedText;
  });
  return index < 0 ? null : { choice: index + 1, source: "word" };
};

export const configuredLabels = (labels: readonly string[], count: number, allowAdditional = false): string[] | null => {
  const normalized = labels.map((label) => label.trim());
  const acceptedLength = allowAdditional ? normalized.length >= count : normalized.length === count;
  return acceptedLength && validateVoteLabels(normalized.slice(0, count), count, count)
    ? normalized.slice(0, count)
    : null;
};

export const labelsForVote = (
  _settings: ChatVotingSettings,
  preset: ChatVotingPreset,
  optionCount: number,
  language: ModuleLanguage,
): string[] => {
  if (preset === "free_text") return [];
  if (preset === "yes_no") return language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  if (preset === "digit_01") return language === "de" ? ["Nein", "Ja"] : ["No", "Yes"];
  if (preset === "digit_12") return ["1", "2"];
  return Array.from({ length: optionCount }, (_, index) => String(index + 1));
};

export const formatVoteOptions = (
  vote: {
    kind: ChatVotingKind;
    optionCount: number;
    labels: readonly string[];
    textMode?: ChatVotingTextMode | null;
  },
  language: ModuleLanguage,
): string => {
  if (vote.kind === "free_text") return chatVotingFreeTextOptionText(language, vote.textMode);
  return Array.from({ length: vote.optionCount }, (_, index) =>
    `${String(index + 1)} = ${vote.labels[index] ?? String(index + 1)}`,
  ).join(", ");
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
