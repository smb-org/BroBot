export const STATISTICS_WORD_COUNTER_ELEMENT_KIND = "statistics.word_counter" as const;
export const STATISTICS_WORD_RANKING_ELEMENT_KIND = "statistics.word_ranking" as const;

/** One source for the element's default box: the view fills it and the editor's definition reports it. */
export const STATISTICS_WORD_COUNTER_DEFAULT_SIZE = { width: 480, height: 176 } as const;

/**
 * Fits the title and five 28 px rows (see ranking-view.css): 12 + 24 + 8 + 5 * 28 + 12.
 * The view grows its own minimum height for larger row counts.
 */
export const STATISTICS_WORD_RANKING_DEFAULT_SIZE = { width: 480, height: 196 } as const;
