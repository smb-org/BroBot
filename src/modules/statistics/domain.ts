import { STATISTICS_STOP_WORDS } from "./stop-words";

const STATISTICS_WINDOW_SECONDS = 5 * 60;
export const STATISTICS_WINDOW_MILLISECONDS = STATISTICS_WINDOW_SECONDS * 1_000;
const STATISTICS_WORD_STREAM_DISTINCT_LIMIT = 20_000;
export const STATISTICS_WORD_STREAM_MERGE_LIMIT = 1_000;
export const STATISTICS_WORD_BASELINE_LIMIT = 5_000;
export const STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const admitStatisticsWordCounts = (
  candidates: ReadonlyMap<string, number>,
  existingWords: ReadonlySet<string>,
  currentDistinctWordCount: number,
): { accepted: Map<string, number>; addedDistinctWords: number } => {
  const accepted = new Map<string, number>();
  let remainingSlots = Math.max(0, STATISTICS_WORD_STREAM_DISTINCT_LIMIT - currentDistinctWordCount);
  let addedDistinctWords = 0;
  for (const [word, count] of candidates) {
    if (existingWords.has(word)) {
      accepted.set(word, count);
    } else if (remainingSlots > 0) {
      accepted.set(word, count);
      remainingSlots -= 1;
      addedDistinctWords += 1;
    }
  }
  return { accepted, addedDistinctWords };
};

export interface StatisticsChatActivity {
  windowStart: string;
  receivedAt: string;
  emotes: number;
  streamId: string | null;
  textFragments?: readonly string[];
}

/** Start of the UTC-epoch-aligned five-minute window containing `timeMs` (shared with other window series). */
export const statisticsWindowStartMs = (timeMs: number): number =>
  Math.floor(timeMs / STATISTICS_WINDOW_MILLISECONDS) * STATISTICS_WINDOW_MILLISECONDS;

export const statisticsWindowStart = (receivedAt: string): number | null => {
  const received = Date.parse(receivedAt);
  return Number.isFinite(received) ? statisticsWindowStartMs(received) : null;
};
const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Returns only plain text fragments; emotes, mentions and cheer fragments never enter word counting. */
export const statisticsTextFragments = (payload: Readonly<Record<string, unknown>>): string[] => {
  const message = recordValue(payload.message);
  if (message === null || !Array.isArray(message.fragments)) return [];
  return message.fragments.flatMap((fragment): string[] => {
    const value = recordValue(fragment);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
};

/** Tokenises text for the anonymous per-stream word-frequency baseline. */
export const tokenizeStatisticsWords = (textFragments: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const fragment of textFragments) {
    const text = fragment.normalize("NFKC").toLowerCase()
      .replace(/(?:https?:\/\/|www\.)[^\s]+/gu, " ")
      .replace(/@[\p{L}\p{N}_-]+/gu, " ")
      .replace(/:[\p{L}\p{N}_+-]+:/gu, " ");
    for (const rawToken of text.split(/\s+/u)) {
      const trimmed = rawToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (trimmed.length === 0 || /[./]/u.test(trimmed)) continue;
      for (const token of trimmed.match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (Array.from(token).length < 3 || /^\p{N}+$/u.test(token) || STATISTICS_STOP_WORDS.has(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return counts;
};

export const countStatisticsEmotes = (payload: Readonly<Record<string, unknown>>): number => {
  const message = recordValue(payload.message);
  if (message === null || !Array.isArray(message.fragments)) return 0;
  return message.fragments.reduce((count: number, fragment: unknown) =>
    recordValue(fragment)?.type === "emote" ? count + 1 : count, 0);
};
