import { RE2JS } from "re2js";

import {
  FAQ_PATTERN_MAXIMUM_COUNT,
  FAQ_PATTERN_MAX_LENGTH,
  type FaqEntry,
  type FaqMatch,
  type FaqMatchResult,
  type FaqMatcher,
  type FaqMinimumTier,
  type FaqMutationMatcher,
} from "../contracts";
import type { ModuleChatStatus } from "../../contract";

/** An entry whose pattern matched the text but was excluded by the game filter. */
interface FaqSkippedMatch {
  entry: FaqEntry;
  matchedPattern: string;
}

export interface FaqSelection extends FaqMatchResult {
  skippedByGame: readonly FaqSkippedMatch[];
}

export interface FaqMatchExplanation {
  entry: FaqEntry;
  match:
    | { kind: "keyword"; pattern: string }
    | { kind: "regex"; pattern: string; ranges: readonly [number, number][] };
  reason: "command_prefix" | "permission_denied" | "game_filter" | "shadowed" | null;
  byEntryId?: string;
}

export interface PreparedFaqMatcher {
  entry: FaqEntry;
  patterns: readonly PreparedFaqPattern[];
}

type PreparedFaqPattern =
  | { type: "keywords"; source: string; normalized: string }
  | { type: "regex"; source: string; compiled: ReturnType<typeof RE2JS.compile> };

export interface FaqPatternTestResult {
  reason: "matched" | "no_match" | "command_prefix";
  matchedPattern?: string;
}

export interface FaqMatcherValidationError {
  path: "matcher.pattern" | "matcher.patterns";
  reasonCode: FaqMatcherValidationReasonCode;
  reason: string;
}

export type FaqMatcherValidationReasonCode =
  | "faq_matcher_required"
  | "faq_regex_required"
  | "faq_regex_too_long"
  | "faq_regex_invalid"
  | "faq_keywords_invalid";

const combiningMarks = /\p{M}/gu;
const wordCharacter = /^[\p{L}\p{N}_]$/u;

export const normalizeFaqText = (value: string): string => value
  .normalize("NFD")
  .replace(combiningMarks, "")
  .toLowerCase()
  .replace(/\u00DF/gu, "ss")
  .replace(/\s+/gu, " ")
  .trim();

const codePointBefore = (value: string, offset: number): string => {
  if (offset <= 0) return "";
  const previous = value.charCodeAt(offset - 1);
  const isLowSurrogate = previous >= 0xdc00 && previous <= 0xdfff;
  if (!isLowSurrogate || offset < 2) return value.slice(offset - 1, offset);
  const preceding = value.charCodeAt(offset - 2);
  return preceding >= 0xd800 && preceding <= 0xdbff ? value.slice(offset - 2, offset) : value.slice(offset - 1, offset);
};

const codePointAfter = (value: string, offset: number): string => {
  if (offset >= value.length) return "";
  const point = value.codePointAt(offset);
  return point === undefined ? "" : String.fromCodePoint(point);
};

const hasWholeWordOccurrence = (message: string, pattern: string): boolean => {
  const needsLeftBoundary = /^[\p{L}\p{N}]/u.test(pattern);
  const needsRightBoundary = /[\p{L}\p{N}]$/u.test(pattern);
  let from = 0;
  while (from <= message.length - pattern.length) {
    const index = message.indexOf(pattern, from);
    if (index < 0) return false;
    const before = codePointBefore(message, index);
    const after = codePointAfter(message, index + pattern.length);
    const leftMatches = !needsLeftBoundary || before.length === 0 || !wordCharacter.test(before);
    const rightMatches = !needsRightBoundary || after.length === 0 || !wordCharacter.test(after);
    if (leftMatches && rightMatches) return true;
    from = index + 1;
  }
  return false;
};

const preparePatterns = (matcher: FaqMatcher): PreparedFaqPattern[] => matcher.type === "keywords"
  ? matcher.patterns.flatMap((source): PreparedFaqPattern[] => {
    const normalized = normalizeFaqText(source);
    return normalized.length === 0 ? [] : [{ type: "keywords", source, normalized }];
  })
  : (() => {
    if (matcher.pattern.trim().length === 0) return [];
    try {
      return [{ type: "regex", source: matcher.pattern, compiled: RE2JS.compile(matcher.pattern) }];
    } catch {
      return [];
    }
  })();

export const prepareFaqMatchers = (entries: readonly FaqEntry[]): PreparedFaqMatcher[] => entries
  .filter((entry) => entry.enabled)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  .map((entry) => ({ entry, patterns: preparePatterns(entry.matcher) }));

export const hasCommandPrefix = (message: string): boolean => message.trimStart().split(/\s/u)[0]?.startsWith("!") === true;

const patternMatches = (message: string, normalizedMessage: string, pattern: PreparedFaqPattern): boolean =>
  pattern.type === "regex"
    ? pattern.compiled.test(message)
    : hasWholeWordOccurrence(normalizedMessage, pattern.normalized);

export const matchFaqMatcher = (matcher: FaqMatcher, message: string): FaqPatternTestResult => {
  if (hasCommandPrefix(message)) return { reason: "command_prefix" };
  const normalizedMessage = normalizeFaqText(message);
  const matchedPattern = preparePatterns(matcher).find((pattern) => patternMatches(message, normalizedMessage, pattern));
  return matchedPattern === undefined
    ? { reason: "no_match" }
    : { reason: "matched", matchedPattern: matchedPattern.source };
};

const minimumTierStatuses: Readonly<Record<FaqMinimumTier, readonly ModuleChatStatus[]>> = {
  everyone: ["viewer", "subscriber", "vip", "moderator", "broadcaster"],
  subscriber: ["subscriber", "moderator", "broadcaster"],
  vip: ["vip", "moderator", "broadcaster"],
  moderator: ["moderator", "broadcaster"],
  broadcaster: ["broadcaster"],
};

const statusMeetsMinimumTier = (status: readonly ModuleChatStatus[] | null, minimumTier: FaqMinimumTier): boolean =>
  minimumTier === "everyone" || (status !== null && status.some((value) => minimumTierStatuses[minimumTier].includes(value)));

export const firstFaqMatch = (prepared: readonly PreparedFaqMatcher[], message: string, chatStatus: readonly ModuleChatStatus[] | null = null): FaqMatchResult => {
  if (hasCommandPrefix(message)) return { match: null, reason: "command_prefix" };
  const normalizedMessage = normalizeFaqText(message);
  for (const matcher of prepared) {
    if (!statusMeetsMinimumTier(chatStatus, matcher.entry.minimumTier)) continue;
    for (const pattern of matcher.patterns) {
      if (patternMatches(message, normalizedMessage, pattern)) {
        const match: FaqMatch = { entry: matcher.entry, matchedPattern: pattern.source };
        return { match, reason: "matched" };
      }
    }
  }
  return { match: null, reason: "no_match" };
};

const isEligibleForGame = (entry: FaqEntry, gameId: string | null): boolean =>
  entry.games.length === 0 || (gameId !== null && entry.games.some((game) => game.id === gameId));

const regexRanges = (pattern: PreparedFaqPattern & { type: "regex" }, message: string): [number, number][] => {
  const matcher = pattern.compiled.matcher(message);
  const ranges: [number, number][] = [];
  let searchFrom = 0;
  while (searchFrom <= message.length && matcher.find(searchFrom)) {
    const start = matcher.start();
    const end = matcher.end();
    ranges.push([start, end]);
    if (end > start) {
      searchFrom = end;
    } else if (end >= message.length) {
      break;
    } else {
      searchFrom = end + 1;
    }
  }
  return ranges;
};

/** Explains every entry whose matcher hits, preserving production order and selection rules. */
export const explainFaqMatches = (
  prepared: readonly PreparedFaqMatcher[],
  message: string,
  gameId: string | null,
  chatStatus: readonly ModuleChatStatus[] | null = null,
): FaqMatchExplanation[] => {
  const commandPrefix = hasCommandPrefix(message);
  const normalizedMessage = normalizeFaqText(message);
  const explanations: FaqMatchExplanation[] = [];
  let winnerId: string | null = null;

  for (const matcher of prepared) {
    const pattern = matcher.patterns.find((candidate) => patternMatches(message, normalizedMessage, candidate));
    if (pattern === undefined) continue;
    const match = pattern.type === "regex"
      ? { kind: "regex" as const, pattern: pattern.source, ranges: regexRanges(pattern, message) }
      : { kind: "keyword" as const, pattern: pattern.source };
    let reason: FaqMatchExplanation["reason"];
    let byEntryId: string | undefined;

    if (commandPrefix) {
      reason = "command_prefix";
    } else if (winnerId !== null) {
      reason = "shadowed";
      byEntryId = winnerId;
    } else if (!statusMeetsMinimumTier(chatStatus, matcher.entry.minimumTier)) {
      reason = "permission_denied";
    } else if (!isEligibleForGame(matcher.entry, gameId)) {
      reason = "game_filter";
    } else {
      reason = null;
      winnerId = matcher.entry.id;
    }

    explanations.push({
      entry: matcher.entry,
      match,
      reason,
      ...(byEntryId === undefined ? {} : { byEntryId }),
    });
  }

  return explanations;
};

/** Selects the first entry that matches both its role and game restrictions. */
export const selectFaqMatch = (
  prepared: readonly PreparedFaqMatcher[],
  message: string,
  gameId: string | null,
  chatStatus: readonly ModuleChatStatus[] | null = null,
): FaqSelection => {
  if (hasCommandPrefix(message)) return { match: null, reason: "command_prefix", skippedByGame: [] };
  const normalizedMessage = normalizeFaqText(message);
  const skippedByGame: FaqSkippedMatch[] = [];
  for (const matcher of prepared) {
    if (!statusMeetsMinimumTier(chatStatus, matcher.entry.minimumTier)) continue;
    for (const pattern of matcher.patterns) {
      if (!patternMatches(message, normalizedMessage, pattern)) continue;
      if (isEligibleForGame(matcher.entry, gameId)) {
        return { match: { entry: matcher.entry, matchedPattern: pattern.source }, reason: "matched", skippedByGame };
      }
      skippedByGame.push({ entry: matcher.entry, matchedPattern: pattern.source });
      break;
    }
  }
  return { match: null, reason: "no_match", skippedByGame };
};

export const faqMatcherValidationError = (value: unknown): FaqMatcherValidationError | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path: "matcher.patterns", reasonCode: "faq_matcher_required", reason: "A matcher is required." };
  }
  const record = value as Record<string, unknown>;
  if (record.type === "regex") {
    if (typeof record.pattern !== "string" || record.pattern.trim().length === 0) {
      return { path: "matcher.pattern", reasonCode: "faq_regex_required", reason: "A regular expression is required." };
    }
    if (record.pattern.length > FAQ_PATTERN_MAX_LENGTH) {
      return { path: "matcher.pattern", reasonCode: "faq_regex_too_long", reason: `Regular expressions can be at most ${String(FAQ_PATTERN_MAX_LENGTH)} characters.` };
    }
    try {
      RE2JS.compile(record.pattern);
      return null;
    } catch (error: unknown) {
      return {
        path: "matcher.pattern",
        reasonCode: "faq_regex_invalid",
        reason: error instanceof Error ? error.message : "The regular expression uses unsupported RE2 syntax.",
      };
    }
  }
  if (record.type !== "keywords" || !Array.isArray(record.patterns) ||
      record.patterns.length < 1 || record.patterns.length > FAQ_PATTERN_MAXIMUM_COUNT ||
      !record.patterns.every((pattern) => typeof pattern === "string" && pattern.trim().length > 0 && pattern.trim().length <= FAQ_PATTERN_MAX_LENGTH)) {
    return { path: "matcher.patterns", reasonCode: "faq_keywords_invalid", reason: "Add between 1 and 20 valid keyword patterns." };
  }
  return null;
};

export const validFaqMatcher = (value: unknown): value is FaqMutationMatcher => faqMatcherValidationError(value) === null;
