export type StatisticsWordRankingScope = "stream" | "total";

export interface StatisticsWordRankingConfig {
  scope: StatisticsWordRankingScope;
  count: number;
  title?: string;
  bars: boolean;
}

export const DEFAULT_STATISTICS_WORD_RANKING_CONFIG: StatisticsWordRankingConfig = {
  scope: "stream",
  count: 5,
  bars: true,
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseStatisticsWordRankingConfig = (raw: unknown): StatisticsWordRankingConfig | null => {
  const input = record(raw);
  if (input === null || Object.keys(input).some((key) => !["scope", "count", "title", "bars"].includes(key))) return null;
  const scope = input.scope ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.scope;
  const count = input.count ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.count;
  const bars = input.bars ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.bars;
  const title = input.title;
  if (!(scope === "stream" || scope === "total") || !Number.isSafeInteger(count) || (count as number) < 3 ||
      (count as number) > 10 || typeof bars !== "boolean" ||
      title !== undefined && (typeof title !== "string" || title.length > 80)) return null;
  return {
    scope,
    count: count as number,
    ...(typeof title === "string" ? { title } : {}),
    bars,
  };
};
