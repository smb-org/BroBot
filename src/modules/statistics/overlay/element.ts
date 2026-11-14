import type { JsonObject, ModuleOverlayElementContext, ModuleOverlayElementDefinition } from "../../contract";
import {
  addStatisticsWordCount,
  calculateStatisticsWordCountForLookup,
  foldStatisticsWord,
  STATISTICS_WORD_RARE_HIDE_MILLISECONDS,
  type StatisticsWordCountValue,
} from "../domain";
import { STATISTICS_WORD_COUNTER_DEFAULT_SIZE, STATISTICS_WORD_COUNTER_ELEMENT_KIND } from "./kinds";
import { statisticsWordCounterLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_COUNTER_CONFIG,
  mergeStatisticsWordCounterRealtimeState,
  parseStatisticsWordCounterConfig,
  statisticsWordCounterStateToJson,
} from "./state";

const german = statisticsWordCounterLabels("de");
const english = statisticsWordCounterLabels("en");
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const initialState = async (
  db: D1Database,
  channelId: string,
  config: JsonObject,
  context?: ModuleOverlayElementContext,
): Promise<JsonObject | null> => {
  const parsedConfig = parseStatisticsWordCounterConfig(config);
  if (parsedConfig === null) return null;

  const [streamState, settingsRow, baselineRows] = await Promise.all([
    db.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null }>(),
    db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'statistics'")
      .bind(channelId).first<{ settings: string }>(),
    db.prepare(`SELECT word, display_word, total_count, last_seen_at
                  FROM channel_word_frequency_baseline
                 WHERE channel_id = ?
                 ORDER BY total_count DESC, word ASC`)
      .bind(channelId).all<{
        word: string;
        display_word: string;
        total_count: number;
        last_seen_at: string;
      }>(),
  ]);
  const streamIsLive = streamState?.state === "online";
  const activeStreamId = streamIsLive ? streamState.stream_id : null;
  const lookup = (activeStreamId === null && streamIsLive) || context?.readStatisticsWordCountForLookup === undefined
    ? { streamId: null, batches: [], streamWord: null, bufferedWord: null }
    : await context.readStatisticsWordCountForLookup(activeStreamId ?? undefined, parsedConfig.word);
  const selectedStreamId = activeStreamId ?? (!streamIsLive ? lookup.streamId : null);
  const mergedBatches = selectedStreamId !== null && streamIsLive
    ? new Set((await db.prepare(
      `SELECT batch FROM channel_word_frequency_streams
        WHERE channel_id = ? AND stream_id = ? AND merged_at IS NOT NULL`,
    ).bind(channelId, selectedStreamId).all<{ batch: number }>()).results.map(({ batch }) => batch))
    : new Set<number>();

  let ignoredWords = new Set<string>();
  if (settingsRow !== null) {
    try {
      const settings = record(JSON.parse(settingsRow.settings) as unknown);
      const words = settings?.ignoredWords;
      if (Array.isArray(words)) ignoredWords = new Set(words.filter((word): word is string => typeof word === "string").map(foldStatisticsWord));
    } catch {
      // Invalid legacy settings leave the word visible, matching the word list's repairable state.
    }
  }

  const baselineCounts = new Map<string, StatisticsWordCountValue>();
  for (const baselineRow of baselineRows.results) addStatisticsWordCount(baselineCounts, {
    word: baselineRow.word,
    displayWord: baselineRow.display_word,
    count: baselineRow.total_count,
    lastSeenAt: baselineRow.last_seen_at,
  });
  const hiddenBefore = new Date((context?.now ?? Date.now()) - STATISTICS_WORD_RARE_HIDE_MILLISECONDS).toISOString();
  const count = calculateStatisticsWordCountForLookup(
    parsedConfig.word,
    baselineCounts,
    streamIsLive ? lookup.batches : [],
    mergedBatches,
    lookup.streamWord,
    lookup.bufferedWord,
    hiddenBefore,
    streamIsLive,
  );
  const hidden = ignoredWords.has(parsedConfig.word) || count.hiddenByRarity;
  return statisticsWordCounterStateToJson({
    words: {
      [parsedConfig.word]: {
        streamCount: hidden ? 0 : count.streamCount,
        totalCount: hidden ? 0 : count.totalCount,
        streamIsLive,
      },
    },
    serverNow: new Date(context?.now ?? Date.now()).toISOString(),
  });
};

const previewState = (rawConfig: JsonObject, _language: "de" | "en", now: number): JsonObject => {
  const config = parseStatisticsWordCounterConfig(rawConfig) ?? DEFAULT_STATISTICS_WORD_COUNTER_CONFIG;
  return statisticsWordCounterStateToJson({
    words: { [config.word]: { streamCount: 128, totalCount: 1_248, streamIsLive: true } },
    serverNow: new Date(now).toISOString(),
  });
};

export const statisticsWordCounterOverlayElement: ModuleOverlayElementDefinition = {
  kind: STATISTICS_WORD_COUNTER_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: STATISTICS_WORD_COUNTER_DEFAULT_SIZE,
  defaultConfig: DEFAULT_STATISTICS_WORD_COUNTER_CONFIG as unknown as JsonObject,
  previewState,
  editorLabel: { de: german.elementLabel, en: english.elementLabel },
  editorAddLabel: { de: german.elementLabel, en: english.elementLabel },
  editorDescription: { de: german.description, en: english.description },
  editorModuleLabel: { de: german.elementLabel, en: english.elementLabel },
  initialStateNeedsContext: true,
  reloadStateOnHostEvents: ["stream.state.changed"],
  mergeRealtimeStateOnModuleMessages: ["modul.statistics.word_counts"],
  mergeRealtimeState: mergeStatisticsWordCounterRealtimeState,
  preserveRealtimeStateOnReload: true,
  parseConfig: (raw) => {
    const parsed = parseStatisticsWordCounterConfig(raw);
    return parsed === null ? null : parsed as unknown as JsonObject;
  },
  initialState,
  load: () => import("./view"),
  editor: () => import("./editor"),
};
