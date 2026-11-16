import type { ModuleOverlayAppearanceDefinition, OverlayAppearanceConfig } from "../../contract";
import { parseOverlayElementConfig } from "../../../overlay/appearance";

export type StatisticsWordRankingScope = "stream" | "total";

export interface StatisticsWordRankingConfig {
  scope: StatisticsWordRankingScope;
  count: number;
  title?: string;
  bars: boolean;
  appearance: OverlayAppearanceConfig;
}

export const STATISTICS_WORD_RANKING_APPEARANCE = {
  parts: ["background", "text", "secondaryText", "accent"],
  defaults: { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1", accent: "#35557f" },
} satisfies ModuleOverlayAppearanceDefinition;

export const DEFAULT_STATISTICS_WORD_RANKING_CONFIG: StatisticsWordRankingConfig = {
  scope: "stream",
  count: 5,
  bars: true,
  appearance: STATISTICS_WORD_RANKING_APPEARANCE.defaults,
};

export const parseStatisticsWordRankingConfig = (raw: unknown): StatisticsWordRankingConfig | null => parseOverlayElementConfig(
  raw,
  STATISTICS_WORD_RANKING_APPEARANCE,
  (input) => {
    if (Object.keys(input).some((key) => !["scope", "count", "title", "bars"].includes(key))) return null;
    const scope = input.scope ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.scope;
    const count = input.count ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.count;
    const bars = input.bars ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG.bars;
    const title = input.title;
    if (!(scope === "stream" || scope === "total") || !Number.isSafeInteger(count) || (count as number) < 3 ||
        (count as number) > 10 || typeof bars !== "boolean" ||
        title !== undefined && (typeof title !== "string" || title.length > 80)) return null;
    return {
      scope,
      count,
      ...(typeof title === "string" ? { title } : {}),
      bars,
    };
  },
) as unknown as StatisticsWordRankingConfig | null;
