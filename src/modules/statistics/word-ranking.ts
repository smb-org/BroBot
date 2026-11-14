import {
  calculateStatisticsWordCount,
  foldStatisticsWord,
  type StatisticsWordCountValue,
} from "./domain";
import { STATISTICS_CHAT_FILLER_WORDS } from "./filler-words";

export interface StatisticsWordRankingEntry {
  word: string;
  displayWord: string;
  count: number;
}

export interface StatisticsWordRankingSelectionInput {
  baselineCounts: ReadonlyMap<string, StatisticsWordCountValue>;
  streamCounts: ReadonlyMap<string, StatisticsWordCountValue>;
  scope: "stream" | "total";
  hiddenBefore: string;
  ignoredWords: ReadonlySet<string>;
  limit?: number;
}

const fillerWords = new Set(STATISTICS_CHAT_FILLER_WORDS.map(foldStatisticsWord));

const compare = (left: StatisticsWordRankingEntry, right: StatisticsWordRankingEntry): number =>
  right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0);

/** Returns a bounded top-N result using the same scope, display, and rare-word rules as `/words`. */
export const selectStatisticsWordRankingEntries = (
  input: StatisticsWordRankingSelectionInput,
): StatisticsWordRankingEntry[] => {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const wordKeys = new Set([...input.baselineCounts.keys(), ...input.streamCounts.keys()]);
  const selected: StatisticsWordRankingEntry[] = [];
  for (const word of wordKeys) {
    const calculated = calculateStatisticsWordCount(
      word,
      input.baselineCounts,
      input.streamCounts,
      input.scope,
      input.hiddenBefore,
    );
    if (calculated.count <= 0 || calculated.hiddenByRarity || input.ignoredWords.has(calculated.word) ||
        fillerWords.has(calculated.word)) continue;
    const entry = {
      word: calculated.word,
      displayWord: calculated.displayWord,
      count: calculated.count,
    };
    let index = 0;
    while (index < selected.length && compare(selected[index] as StatisticsWordRankingEntry, entry) < 0) index += 1;
    selected.splice(index, 0, entry);
    if (selected.length > limit) selected.pop();
  }
  return selected;
};
