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
  const words: Record<string, StatisticsWordCounterValue> = {};
  for (const [word, count] of Object.entries(wordsInput)) {
    const foldedWord = foldStatisticsWord(word);
    if (foldedWord !== word || !isCounterValue(count)) return null;
    words[word] = count;
  }
  return { words, serverNow: input.serverNow };
};

export const mergeStatisticsWordCounterRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const next = parseStatisticsWordCounterState(incoming);
  if (next === null) return current ?? {};
  const previous = current === null ? null : parseStatisticsWordCounterState(current);
  if (previous === null) return next as unknown as Readonly<Record<string, unknown>>;
  if (Date.parse(next.serverNow) < Date.parse(previous.serverNow)) return previous as unknown as Readonly<Record<string, unknown>>;
  return {
    serverNow: next.serverNow,
    words: { ...previous.words, ...next.words },
  };
};

export const statisticsWordCounterStateToJson = (state: StatisticsWordCounterState): JsonObject => state as unknown as JsonObject;
