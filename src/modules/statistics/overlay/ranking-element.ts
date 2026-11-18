import type { JsonObject, ModuleOverlayElementContext, ModuleOverlayElementDefinition } from "../../contract";
import {
  STATISTICS_WORD_RANKING_DEFAULT_SIZE,
  STATISTICS_WORD_RANKING_ELEMENT_KIND,
} from "./kinds";
import { statisticsWordRankingLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_RANKING_CONFIG,
  mergeStatisticsWordRankingRealtimeState,
  parseStatisticsWordRankingConfig,
  statisticsWordRankingStateToJson,
} from "./state";

const german = statisticsWordRankingLabels("de");
const english = statisticsWordRankingLabels("en");

const initialState = async (
  _db: D1Database,
  _channelId: string,
  rawConfig: JsonObject,
  context?: ModuleOverlayElementContext,
): Promise<JsonObject | null> => {
  const config = parseStatisticsWordRankingConfig(rawConfig);
  if (config === null) return null;
  if (context?.readStatisticsWordRanking === undefined) {
    throw new Error("Statistics word ranking state requires the channel ranking reader.");
  }
  const snapshot = await context.readStatisticsWordRanking(config.scope, context.now);
  return statisticsWordRankingStateToJson({
    bootstrap: true,
    serverNow: snapshot.serverNow,
    stream: config.scope === "stream"
      ? { entries: snapshot.entries, streamIsLive: snapshot.streamIsLive ?? false, computedAt: snapshot.serverNow }
      : null,
    total: config.scope === "total" ? { entries: snapshot.entries, computedAt: snapshot.serverNow } : null,
  });
};

const previewState = (rawConfig: JsonObject, _language: "de" | "en", now: number): JsonObject => {
  const config = parseStatisticsWordRankingConfig(rawConfig) ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG;
  const entries = [
    { word: "fak", displayWord: "Fak", count: 34 },
    { word: "chat", displayWord: "Chat", count: 25 },
    { word: "alpha", displayWord: "Alpha", count: 18 },
    { word: "stream", displayWord: "Stream", count: 12 },
    { word: "gaming", displayWord: "Gaming", count: 7 },
    { word: "viewer", displayWord: "Viewer", count: 5 },
    { word: "welcome", displayWord: "Welcome", count: 4 },
    { word: "word", displayWord: "Word", count: 3 },
    { word: "live", displayWord: "Live", count: 2 },
    { word: "great", displayWord: "Great", count: 1 },
  ].slice(0, 10);
  return statisticsWordRankingStateToJson({
    bootstrap: true,
    serverNow: new Date(now).toISOString(),
    stream: config.scope === "stream" ? { entries, streamIsLive: true, computedAt: new Date(now).toISOString() } : null,
    total: config.scope === "total" ? { entries, computedAt: new Date(now).toISOString() } : null,
  });
};

export const statisticsWordRankingOverlayElement: ModuleOverlayElementDefinition = {
  kind: STATISTICS_WORD_RANKING_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: STATISTICS_WORD_RANKING_DEFAULT_SIZE,
  defaultConfig: DEFAULT_STATISTICS_WORD_RANKING_CONFIG as unknown as JsonObject,
  previewState,
  editorLabel: { de: german.elementLabel, en: english.elementLabel },
  editorAddLabel: { de: german.elementLabel, en: english.elementLabel },
  editorDescription: { de: german.description, en: english.description },
  editorModuleLabel: { de: german.elementLabel, en: english.elementLabel },
  initialStateNeedsContext: true,
  reloadStateOnHostEvents: ["stream.state.changed"],
  mergeRealtimeStateOnModuleMessages: ["modul.statistics.word_ranking"],
  mergeRealtimeState: mergeStatisticsWordRankingRealtimeState,
  preserveRealtimeStateOnReload: true,
  parseConfig: (raw) => {
    const parsed = parseStatisticsWordRankingConfig(raw);
    return parsed === null ? null : parsed as unknown as JsonObject;
  },
  initialState,
  // The preview grows by one 24px row per word; the fields above it take 360px.
  editorReservedHeight: (rawConfig) =>
    `calc(var(--s10) * 9 + ${String((parseStatisticsWordRankingConfig(rawConfig) ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG).count)} * var(--s6))`,
  load: () => import("./ranking-view"),
  editor: () => import("./ranking-editor"),
};
