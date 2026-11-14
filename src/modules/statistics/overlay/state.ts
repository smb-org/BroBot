import type { JsonObject } from "../../contract";
import { foldStatisticsWord, tokenizeStatisticsWordDetails } from "../domain";

export type StatisticsWordCounterShow = "stream" | "total" | "both";

export interface StatisticsWordCounterConfig {
  word: string;
  label: string;
  show: StatisticsWordCounterShow;
}

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
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseStatisticsWordCounterConfig = (raw: unknown): StatisticsWordCounterConfig | null => {
  const input = record(raw);
  if (input === null || Object.keys(input).some((key) => !["word", "label", "show"].includes(key)) ||
      typeof input.word !== "string") return null;
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
};

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
  if (next === null) return current ?? {};
  const previous = current === null ? null : parseStatisticsWordCounterState(current);
  const isBootstrap = next.bootstrapWordSet === true;
  if (previous === null && !isBootstrap) {
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
  return {
    serverNow: previous === null || Date.parse(next.serverNow) >= Date.parse(previous.serverNow)
      ? next.serverNow
      : previous.serverNow,
    words,
    wordServerNow,
    ...((isBootstrap || previous?.bootstrapWordSet === true) ? { bootstrapWordSet: true } : {}),
  };
};

export const statisticsWordCounterStateToJson = (state: StatisticsWordCounterState): JsonObject => state as unknown as JsonObject;
