import {
  FAQ_PATTERN_MAXIMUM_COUNT,
  FAQ_PATTERN_MAX_LENGTH,
  type FaqEntry,
  type FaqMatch,
  type FaqMatchResult,
  type FaqMutationMatcher,
} from "../contracts";

export interface PreparedFaqMatcher {
  entry: FaqEntry;
  patterns: readonly { source: string; normalized: string }[];
}

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
  .filter((entry) => entry.enabled && entry.matcher.type === "keywords")
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  .map((entry) => ({
    entry,
    patterns: entry.matcher.type === "keywords"
      ? entry.matcher.patterns.flatMap((source) => {
        const normalized = normalizeFaqText(source);
        return normalized.length === 0 ? [] : [{ source, normalized }];
      })
      : [],
  }));

export const hasCommandPrefix = (message: string): boolean => message.trimStart().split(/\s/u)[0]?.startsWith("!") === true;

export const firstFaqMatch = (prepared: readonly PreparedFaqMatcher[], message: string): FaqMatchResult => {
  if (hasCommandPrefix(message)) return { match: null, reason: "command_prefix" };
  const normalizedMessage = normalizeFaqText(message);
  for (const matcher of prepared) {
    for (const pattern of matcher.patterns) {
      if (hasWholeWordOccurrence(normalizedMessage, pattern.normalized)) {
        const match: FaqMatch = { entry: matcher.entry, matchedPattern: pattern.source };
        return { match, reason: "matched" };
      }
    }
  }
  return { match: null, reason: "no_match" };
};

export const validFaqMatcher = (value: unknown): value is FaqMutationMatcher => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "keywords" || !Array.isArray(record.patterns) || record.patterns.length < 1 || record.patterns.length > FAQ_PATTERN_MAXIMUM_COUNT) return false;
  return record.patterns.every((pattern) => typeof pattern === "string" && pattern.trim().length > 0 && pattern.trim().length <= FAQ_PATTERN_MAX_LENGTH);
};
