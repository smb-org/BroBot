import type { JsonObject, ModuleOverlayAppearanceDefinition, OverlayAppearanceConfig } from "../../contract";
import { parseOverlayElementConfig } from "../../../overlay/appearance";
import { foldStatisticsWord, tokenizeStatisticsWordDetails } from "../domain";

export type StatisticsWordCounterShow = "stream" | "total" | "both";

export interface StatisticsWordCounterConfig {
  word: string;
  label: string;
  show: StatisticsWordCounterShow;
  appearance: OverlayAppearanceConfig;
}

export const STATISTICS_WORD_COUNTER_APPEARANCE = {
  parts: ["background", "text", "secondaryText"],
  defaults: { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1" },
} satisfies ModuleOverlayAppearanceDefinition;

interface StatisticsWordCounterValue {
  streamCount: number;
  totalCount: number;
  streamIsLive: boolean;
}

export interface StatisticsWordCounterState {
  words: Readonly<Record<string, StatisticsWordCounterValue>>;
  serverNow: string;
  wordServerNow?: Readonly<Record<string, string>>;
  bootstrapWordSet?: true;
}

export const DEFAULT_STATISTICS_WORD_COUNTER_CONFIG: StatisticsWordCounterConfig = {
  word: "hello",
  label: "hello",
  show: "both",
  appearance: STATISTICS_WORD_COUNTER_APPEARANCE.defaults,
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseStatisticsWordCounterConfig = (raw: unknown): StatisticsWordCounterConfig | null => parseOverlayElementConfig(
  raw,
  STATISTICS_WORD_COUNTER_APPEARANCE,
  (input) => {
    if (Object.keys(input).some((key) => !["word", "label", "show"].includes(key)) || typeof input.word !== "string") return null;
    const tokenized = tokenizeStatisticsWordDetails([input.word]);
    if (tokenized.size !== 1) return null;
    const entry = tokenized.entries().next().value as [string, { count: number; displayWord: string }] | undefined;
    if (entry === undefined) return null;
    const [word, token] = entry;
    const label = input.label ?? token.displayWord;
    const show = input.show ?? DEFAULT_STATISTICS_WORD_COUNTER_CONFIG.show;
    if (typeof label !== "string" || label.length > 80 ||
        !(show === "stream" || show === "total" || show === "both")) return null;
    return { word: foldStatisticsWord(word), label, show };
  },
) as unknown as StatisticsWordCounterConfig | null;

const isCounterValue = (value: unknown): value is StatisticsWordCounterValue => {
  const input = record(value);
  return input !== null && Number.isSafeInteger(input.streamCount) && (input.streamCount as number) >= 0 &&
    Number.isSafeInteger(input.totalCount) && (input.totalCount as number) >= 0 &&
    typeof input.streamIsLive === "boolean";
};

export const parseStatisticsWordCounterState = (value: unknown): StatisticsWordCounterState | null => {
  const input = record(value);
  if (input === null || typeof input.serverNow !== "string" || !Number.isFinite(Date.parse(input.serverNow))) return null;
  const wordsInput = record(input.words);
  if (wordsInput === null) return null;
  const wordServerNowInput = input.wordServerNow === undefined ? null : record(input.wordServerNow);
  if (input.wordServerNow !== undefined && wordServerNowInput === null) return null;
  const words: Record<string, StatisticsWordCounterValue> = {};
  const wordServerNow: Record<string, string> = {};
  for (const [word, count] of Object.entries(wordsInput)) {
    const foldedWord = foldStatisticsWord(word);
    if (foldedWord !== word || !isCounterValue(count)) return null;
    const entryServerNow = wordServerNowInput !== null && Object.prototype.hasOwnProperty.call(wordServerNowInput, word)
      ? wordServerNowInput[word]
      : input.serverNow;
    if (typeof entryServerNow !== "string" || !Number.isFinite(Date.parse(entryServerNow))) return null;
    words[word] = count;
    wordServerNow[word] = entryServerNow;
  }
  return {
    words,
    serverNow: input.serverNow,
    wordServerNow,
    ...(input.bootstrapWordSet === true ? { bootstrapWordSet: true as const } : {}),
  };
};

export const mergeStatisticsWordCounterRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const next = parseStatisticsWordCounterState(incoming);
  if (next === null) {
    if (typeof incoming.refreshAt !== "string") return current ?? {};
    if (current === null) return incoming;
    // Pin each counter's effective timestamp before serverNow moves, so older-than-failure chunks still apply.
    const currentParsed = parseStatisticsWordCounterState(current);
    return {
      ...current,
      ...(currentParsed === null ? {} : { wordServerNow: currentParsed.wordServerNow }),
      ...(typeof incoming.serverNow === "string" && Number.isFinite(Date.parse(incoming.serverNow))
        ? { serverNow: incoming.serverNow }
        : {}),
      refreshAt: incoming.refreshAt,
    };
  }
  const previous = current === null ? null : parseStatisticsWordCounterState(current);
  const isBootstrap = next.bootstrapWordSet === true;
  if (previous === null && !isBootstrap) {
    if (current !== null) return current;
    return { words: {}, serverNow: next.serverNow, wordServerNow: {} };
  }
  const words = isBootstrap ? {} : { ...previous?.words };
  const wordServerNow = isBootstrap ? {} : { ...previous?.wordServerNow };
  for (const [word, value] of Object.entries(next.words)) {
    if (!isBootstrap && !Object.prototype.hasOwnProperty.call(previous?.words, word)) continue;
    const previousEntryServerNow = previous?.wordServerNow?.[word];
    const previousValue = previous?.words[word];
    const nextEntryServerNow = next.wordServerNow?.[word] ?? next.serverNow;
    if (previousEntryServerNow === undefined ||
        Date.parse(nextEntryServerNow) >= Date.parse(previousEntryServerNow)) {
      words[word] = value;
      wordServerNow[word] = nextEntryServerNow;
    } else if (isBootstrap && previousValue !== undefined) {
      words[word] = previousValue;
      wordServerNow[word] = previousEntryServerNow;
    }
  }
  if (!isBootstrap) {
    return {
      ...current,
      words,
      wordServerNow,
    };
  }
  return {
    serverNow: previous === null || Date.parse(next.serverNow) >= Date.parse(previous.serverNow)
      ? next.serverNow
      : previous.serverNow,
    words,
    wordServerNow,
    bootstrapWordSet: true,
  };
};

export const statisticsWordCounterStateToJson = (state: StatisticsWordCounterState): JsonObject => state as unknown as JsonObject;

export {
  DEFAULT_STATISTICS_WORD_RANKING_CONFIG,
  parseStatisticsWordRankingConfig,
  STATISTICS_WORD_RANKING_APPEARANCE,
  type StatisticsWordRankingScope,
} from "./ranking-config";

interface StatisticsWordRankingEntry {
  word: string;
  displayWord: string;
  count: number;
}

interface StatisticsWordRankingScopeState {
  entries: readonly StatisticsWordRankingEntry[];
  computedAt: string;
  streamIsLive?: boolean;
}

export interface StatisticsWordRankingState {
  serverNow: string;
  stream: StatisticsWordRankingScopeState | null;
  total: StatisticsWordRankingScopeState | null;
  refreshAt?: string;
  bootstrap?: true;
}

const wordRankingRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const validWordRankingInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const parseStatisticsWordRankingEntry = (value: unknown): StatisticsWordRankingEntry | null => {
  const input = wordRankingRecord(value);
  if (input === null || typeof input.word !== "string" || input.word.length === 0 ||
      foldStatisticsWord(input.word) !== input.word || typeof input.displayWord !== "string" ||
      input.displayWord.length === 0 || input.displayWord.length > 80 ||
      !Number.isSafeInteger(input.count) || (input.count as number) < 1) return null;
  return { word: input.word, displayWord: input.displayWord, count: input.count as number };
};

const parseStatisticsWordRankingEntries = (value: unknown): readonly StatisticsWordRankingEntry[] | null => {
  if (!Array.isArray(value) || value.length > 10) return null;
  const entries = value.map(parseStatisticsWordRankingEntry);
  return entries.some((entry) => entry === null) ? null : entries as StatisticsWordRankingEntry[];
};

const parseStatisticsWordRankingStream = (
  value: unknown,
): StatisticsWordRankingScopeState | null | undefined => {
  if (value === null) return null;
  const input = wordRankingRecord(value);
  if (input === null || typeof input.streamIsLive !== "boolean" || !validWordRankingInstant(input.computedAt)) return undefined;
  const entries = parseStatisticsWordRankingEntries(input.entries);
  return entries === null ? undefined : { entries, streamIsLive: input.streamIsLive, computedAt: input.computedAt };
};

const parseStatisticsWordRankingTotal = (
  value: unknown,
): StatisticsWordRankingScopeState | null | undefined => {
  if (value === null) return null;
  const input = wordRankingRecord(value);
  if (input === null || !validWordRankingInstant(input.computedAt)) return undefined;
  const entries = parseStatisticsWordRankingEntries(input.entries);
  return entries === null ? undefined : { entries, computedAt: input.computedAt };
};

export const parseStatisticsWordRankingState = (value: unknown): StatisticsWordRankingState | null => {
  const input = wordRankingRecord(value);
  if (input === null || !validWordRankingInstant(input.serverNow) ||
      !Object.prototype.hasOwnProperty.call(input, "stream") ||
      !Object.prototype.hasOwnProperty.call(input, "total")) return null;
  const stream = parseStatisticsWordRankingStream(input.stream);
  const total = parseStatisticsWordRankingTotal(input.total);
  if (stream === undefined || total === undefined ||
      input.refreshAt !== undefined && !validWordRankingInstant(input.refreshAt) ||
      input.bootstrap !== undefined && input.bootstrap !== true) return null;
  return {
    serverNow: input.serverNow,
    stream,
    total,
    ...(typeof input.refreshAt === "string" ? { refreshAt: input.refreshAt } : {}),
    ...(input.bootstrap === true ? { bootstrap: true as const } : {}),
  };
};

/** Merges whole-scope snapshots without letting stale hydrations erase fresher live lists. */
export const mergeStatisticsWordRankingRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const next = parseStatisticsWordRankingState(incoming);
  if (next === null) {
    if (!validWordRankingInstant(incoming.refreshAt)) return current ?? {};
    if (current === null) return incoming;
    const previous = parseStatisticsWordRankingState(current);
    if (previous === null) return { ...current, refreshAt: incoming.refreshAt };
    return {
      ...previous,
      ...(validWordRankingInstant(incoming.serverNow) && Date.parse(incoming.serverNow) > Date.parse(previous.serverNow)
        ? { serverNow: incoming.serverNow }
        : {}),
      refreshAt: incoming.refreshAt,
    };
  }

  const previous = current === null ? null : parseStatisticsWordRankingState(current);
  const incomingAt = Date.parse(next.serverNow);
  const streamAccepted = next.stream !== null &&
    (previous === null || previous.stream === null ||
      Date.parse(next.stream.computedAt) >= Date.parse(previous.stream.computedAt));
  const totalAccepted = next.total !== null &&
    (previous === null || previous.total === null ||
      Date.parse(next.total.computedAt) >= Date.parse(previous.total.computedAt));
  const stream = streamAccepted ? next.stream : previous === null ? next.stream : previous.stream;
  const total = totalAccepted ? next.total : previous === null ? next.total : previous.total;
  const previousServerNow = previous?.serverNow;
  const serverNow = previousServerNow === undefined || incomingAt >= Date.parse(previousServerNow)
    ? next.serverNow
    : previousServerNow;
  const refreshAt = next.bootstrap === true ? undefined
    : typeof current?.refreshAt === "string" ? current.refreshAt
      : next.refreshAt;

  return {
    serverNow,
    stream,
    total,
    ...(refreshAt === undefined ? {} : { refreshAt }),
    ...(next.bootstrap === true ? { bootstrap: true as const } : {}),
  };
};

export const statisticsWordRankingStateToJson = (state: StatisticsWordRankingState): JsonObject =>
  state as unknown as JsonObject;
