import { RE2JS } from "re2js";

import {
  FAQ_PATTERN_MAXIMUM_COUNT,
  FAQ_PATTERN_MAX_LENGTH,
  type FaqEntry,
  type FaqMatch,
  type FaqMatchResult,
  type FaqMutationMatcher,
} from "../contracts";

/** An entry whose pattern matched the text but was excluded by the game filter. */
interface FaqSkippedMatch {
  entry: FaqEntry;
  matchedPattern: string;
}

export interface FaqSelection extends FaqMatchResult {
  skippedByGame: readonly FaqSkippedMatch[];
}

export interface PreparedFaqMatcher {
  entry: FaqEntry;
  patterns: readonly PreparedFaqPattern[];
}

type PreparedFaqPattern =
  | { type: "keywords"; source: string; normalized: string }
  | { type: "regex"; source: string; compiled: ReturnType<typeof RE2JS.compile> };

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

export const prepareFaqMatchers = (entries: readonly FaqEntry[]): PreparedFaqMatcher[] => entries
  .filter((entry) => entry.enabled)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  .map((entry) => ({
    entry,
    patterns: entry.matcher.type === "keywords"
      ? entry.matcher.patterns.flatMap((source): PreparedFaqPattern[] => {
        const normalized = normalizeFaqText(source);
        return normalized.length === 0 ? [] : [{ type: "keywords", source, normalized }];
      })
      : (() => {
        if (entry.matcher.pattern.trim().length === 0) return [];
        try {
          return [{ type: "regex", source: entry.matcher.pattern, compiled: RE2JS.compile(entry.matcher.pattern) }];
        } catch {
          return [];
        }
      })(),
  }));

export const hasCommandPrefix = (message: string): boolean => message.trimStart().split(/\s/u)[0]?.startsWith("!") === true;

const patternMatches = (message: string, normalizedMessage: string, pattern: PreparedFaqPattern): boolean =>
  pattern.type === "regex"
    ? pattern.compiled.test(message)
    : hasWholeWordOccurrence(normalizedMessage, pattern.normalized);

export const firstFaqMatch = (prepared: readonly PreparedFaqMatcher[], message: string): FaqMatchResult => {
  if (hasCommandPrefix(message)) return { match: null, reason: "command_prefix" };
  const normalizedMessage = normalizeFaqText(message);
  for (const matcher of prepared) {
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

/**
 * The one place both live chat (`processFaqMessage`) and the panel tester
 * pick a match, so a restricted entry can never match in the tester and stay
 * silent in chat (or the reverse). Unlike `firstFaqMatch`, an entry whose
 * pattern matched but was excluded by the game filter is recorded rather
 * than silently skipped, so the tester can explain why it didn't win.
 */
export const selectFaqMatch = (
  prepared: readonly PreparedFaqMatcher[],
  message: string,
  gameId: string | null,
): FaqSelection => {
  if (hasCommandPrefix(message)) return { match: null, reason: "command_prefix", skippedByGame: [] };
  const normalizedMessage = normalizeFaqText(message);
  const skippedByGame: FaqSkippedMatch[] = [];
  for (const matcher of prepared) {
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
