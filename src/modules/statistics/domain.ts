import { STATISTICS_STOP_WORDS } from "./stop-words";

const STATISTICS_WINDOW_SECONDS = 5 * 60;
export const STATISTICS_WINDOW_MILLISECONDS = STATISTICS_WINDOW_SECONDS * 1_000;
const STATISTICS_WORD_STREAM_DISTINCT_LIMIT = 20_000;
const STATISTICS_WORD_MESSAGE_DISTINCT_LIMIT = 20;
const STATISTICS_WORD_TOKEN_LENGTH_LIMIT = 40;
const STATISTICS_CHAT_BOT_LOGINS = new Set([
  "nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "sery_bot",
]);
const STATISTICS_FOLDED_STOP_WORDS = new Set([...STATISTICS_STOP_WORDS].map((word) =>
  word.normalize("NFKC").toLowerCase().replace(/(\p{L})\1+/gu, "$1"),
));
export const STATISTICS_WORD_STREAM_MERGE_LIMIT = 1_000;
export const STATISTICS_WORD_BASELINE_LIMIT = 5_000;
export const STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const STATISTICS_WORD_STREAM_IDLE_MILLISECONDS = 15 * 60 * 1_000;
export const STATISTICS_WORD_RARE_HIDE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const STATISTICS_WORD_RARE_COUNT_LIMIT = 3;

export interface StatisticsWordCountSource {
  word: string;
  displayWord: string;
  count: number;
  lastSeenAt: string;
}

export interface StatisticsWordCountValue {
  displayWord: string;
  count: number;
  lastSeenAt: string;
}

export interface CalculatedStatisticsWordCount {
  word: string;
  displayWord: string;
  streamCount: number;
  totalCount: number;
  count: number;
  lastSeenAt: string;
  hiddenByRarity: boolean;
}

/** Adds one source row to the folded display/count view shared by routes and commands. */
export const addStatisticsWordCount = (
  counts: Map<string, StatisticsWordCountValue>,
  entry: StatisticsWordCountSource,
): void => {
  const word = foldStatisticsWord(entry.word);
  if (word.length === 0 || !Number.isSafeInteger(entry.count) || entry.count <= 0) return;
  const current = counts.get(word) ?? {
    displayWord: entry.displayWord.length > 0 ? entry.displayWord : entry.word,
    count: 0,
    lastSeenAt: entry.lastSeenAt,
  };
  current.count += entry.count;
  if (current.lastSeenAt < entry.lastSeenAt) current.lastSeenAt = entry.lastSeenAt;
  counts.set(word, current);
};

/** Combines one folded word's source counts and applies the dashboard's rare-word rule. */
export const calculateStatisticsWordCount = (
  word: string,
  baselineCounts: ReadonlyMap<string, StatisticsWordCountValue>,
  streamCounts: ReadonlyMap<string, StatisticsWordCountValue>,
  scope: "stream" | "total",
  hiddenBefore: string,
  fullStreamCounts: ReadonlyMap<string, StatisticsWordCountValue> = streamCounts,
): CalculatedStatisticsWordCount => {
  const foldedWord = foldStatisticsWord(word);
  const baseline = baselineCounts.get(foldedWord);
  const stream = streamCounts.get(foldedWord);
  const fullStream = fullStreamCounts.get(foldedWord);
  const streamCount = fullStream?.count ?? stream?.count ?? 0;
  const totalCount = (baseline?.count ?? 0) + (stream?.count ?? 0);
  const count = scope === "stream" ? streamCount : totalCount;
  const lastSeenAt = scope === "stream"
    ? fullStream?.lastSeenAt ?? stream?.lastSeenAt ?? ""
    : baseline === undefined ? stream?.lastSeenAt ?? ""
      : stream === undefined || baseline.lastSeenAt >= stream.lastSeenAt ? baseline.lastSeenAt : stream.lastSeenAt;
  return {
    word: foldedWord,
    displayWord: scope === "stream"
      ? fullStream?.displayWord ?? stream?.displayWord ?? foldedWord
      : baseline?.displayWord ?? stream?.displayWord ?? foldedWord,
    streamCount,
    totalCount,
    count,
    lastSeenAt,
    hiddenByRarity: scope === "total" && count < STATISTICS_WORD_RARE_COUNT_LIMIT &&
      lastSeenAt.length > 0 && lastSeenAt < hiddenBefore,
  };
};

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

/** Returns text and emote-name fragments; mentions, cheers and links never enter word counting. */
export const statisticsTextFragments = (payload: Readonly<Record<string, unknown>>): string[] => {
  const message = recordValue(payload.message);
  if (message === null || !Array.isArray(message.fragments)) return [];
  return message.fragments.flatMap((fragment): string[] => {
    const value = recordValue(fragment);
    return (value?.type === "text" || value?.type === "emote") && typeof value.text === "string" ? [value.text] : [];
  });
};

/** Folds a normalized word key by reducing every run of the same Unicode letter to one letter. */
export const foldStatisticsWord = (word: string): string =>
  word.normalize("NFKC").toLowerCase().replace(/(\p{L})\1+/gu, "$1");

export interface StatisticsWordToken {
  count: number;
  displayWord: string;
}

/** Tokenises one message while retaining its first observed spelling for the stream's display tracker. */
export const tokenizeStatisticsWordDetails = (textFragments: readonly string[]): Map<string, StatisticsWordToken> => {
  const words = new Map<string, StatisticsWordToken>();
  fragments: for (const fragment of textFragments) {
    const text = fragment.normalize("NFKC")
      .replace(/(?:https?:\/\/|www\.)[^\s]+/gu, " ")
      .replace(/@[\p{L}\p{M}\p{N}_-]+/gu, " ")
      .replace(/:[\p{L}\p{M}\p{N}_+-]+:/gu, " ");
    for (const rawToken of text.split(/\s+/u)) {
      const trimmed = rawToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
      if (trimmed.length === 0 || /[./]/u.test(trimmed)) continue;
      for (const token of trimmed.match(/(?:\p{L}[\p{L}\p{M}\p{N}]*|\p{N}+)/gu) ?? []) {
        const length = Array.from(token).length;
        const word = foldStatisticsWord(token);
        if (length < 3 || length > STATISTICS_WORD_TOKEN_LENGTH_LIMIT || Array.from(word).length < 3 ||
            /^\p{N}+$/u.test(token) || STATISTICS_FOLDED_STOP_WORDS.has(word) || words.has(word)) continue;
        if (words.size === STATISTICS_WORD_MESSAGE_DISTINCT_LIMIT) break fragments;
        words.set(word, { count: 1, displayWord: token });
      }
    }
  }
  return words;
};

/** Tokenises text for the anonymous per-stream word-frequency baseline. */
export const tokenizeStatisticsWords = (textFragments: readonly string[]): Map<string, number> =>
  new Map([...tokenizeStatisticsWordDetails(textFragments)].map(([word, token]) => [word, token.count]));

/** Commands and known chat bots stay in activity totals but do not contribute word counts. */
export const statisticsWordsExcluded = (payload: Readonly<Record<string, unknown>>): boolean => {
  const message = recordValue(payload.message);
  if (typeof message?.text === "string" && message.text.startsWith("!")) return true;
  return typeof payload.chatter_user_login === "string" &&
    STATISTICS_CHAT_BOT_LOGINS.has(payload.chatter_user_login.toLowerCase());
};

export const countStatisticsEmotes = (payload: Readonly<Record<string, unknown>>): number => {
  const message = recordValue(payload.message);
  if (message === null || !Array.isArray(message.fragments)) return 0;
  return message.fragments.reduce((count: number, fragment: unknown) =>
    recordValue(fragment)?.type === "emote" ? count + 1 : count, 0);
};
