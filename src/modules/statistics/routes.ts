import { Hono } from "hono";
import { z } from "zod";

import { DEFAULT_CHANNEL_TIME_ZONE, validChannelTimeZone } from "../contract";
import type { ModuleRouteEnvironment } from "../contract";
import type { StatisticsBitrateWindow, StatisticsStreamWindow, StatisticsTimelineEvent, StatisticsTrendsWeeks } from "./contracts";
import { decodeStreamCursor, deriveStreamEvents, encodeStreamCursor, groupStatisticsWindows, matchBitrateWindows, paginateStreamSummaries } from "./streams-domain";
import { STATISTICS_CHAT_FILLER_WORDS } from "./filler-words";
import { foldStatisticsWord } from "./domain";
import { statisticsSettingsSchema } from "./contracts";
import { deriveStatisticsTrends } from "./trends-domain";

const WINDOW_MILLISECONDS = 5 * 60_000;
const WORD_PAGE_SIZE = 100;
const WORD_MAX_PAGE = 250;
const WORD_MAX_SEARCH_LENGTH = 80;

const listParamsSchema = z.object({ channelId: z.string().trim().min(1).max(128) });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
const streamParamsSchema = z.object({
  channelId: z.string().trim().min(1).max(128),
  streamId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u),
});
const trendsQuerySchema = z.object({ weeks: z.enum(["4", "12", "52"]).default("12") })
  .transform(({ weeks }): { weeks: StatisticsTrendsWeeks } => ({ weeks: Number(weeks) as StatisticsTrendsWeeks }));
const wordsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(WORD_MAX_PAGE).default(1),
  search: z.string().trim().max(WORD_MAX_SEARCH_LENGTH).default(""),
  hideFillers: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  scope: z.enum(["stream", "total"]).default("total"),
});

interface StreamCandidateRow {
  stream_id: string;
  first_window_start: string;
  last_window_start: string;
}

interface StreamWindowRow {
  window_start: string;
  stream_id: string | null;
  messages: number;
  emotes: number;
  viewer_count: number | null;
  chatters: number | null;
  active_chatters: number | null;
}

interface TimelineRow {
  kind: StatisticsTimelineEvent["kind"];
  occurred_at: string;
  detail_json: string;
}

interface BitrateWindowRow {
  window_start: number;
  bitrate_avg: number;
  bitrate_min: number;
  bitrate_max: number;
  bitrate_p10: number;
}

interface WordFrequencyRow {
  word: string;
  display_word: string;
  total_count: number;
  last_seen_at: string;
}

interface StatisticsWordObject {
  readStatisticsWordCountsByBatch: (streamId: string) => Promise<readonly {
    batch: number;
    words: readonly { word: string; displayWord?: string; count: number; lastSeenAt: string }[];
  }[]>;
  readStatisticsWordStreamCounts: (streamId?: string) => Promise<{
    streamId: string;
    words: readonly { word: string; displayWord?: string; count: number; lastSeenAt: string }[];
  } | null>;
}

interface StatisticsWordBatchCounts {
  batch: number;
  words: readonly { word: string; displayWord?: string; count: number; lastSeenAt: string }[];
}

const statisticsWindow = (row: StreamWindowRow): StatisticsStreamWindow => ({
  windowStart: row.window_start,
  streamId: row.stream_id,
  messages: row.messages,
  emotes: row.emotes,
  viewerCount: row.viewer_count,
  chatters: row.chatters,
  activeChatters: row.active_chatters,
});

const timelineEvent = (row: TimelineRow): StatisticsTimelineEvent => {
  let detail: Readonly<Record<string, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      detail = parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // The table's JSON validity check makes this unreachable for stored rows.
  }
  return { kind: row.kind, occurredAt: row.occurred_at, detail };
};

const timelineTimestamp = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  return match === null ? value : `${match[1] ?? ""}.${(match[2] ?? "").padEnd(9, "0")}Z`;
};

export const statisticsRoutes = new Hono<ModuleRouteEnvironment>();

statisticsRoutes.get("/streams", async (context) => {
  const params = listParamsSchema.safeParse({ channelId: context.req.param("channelId") });
  const query = listQuerySchema.safeParse({
    ...(context.req.query("limit") === undefined ? {} : { limit: context.req.query("limit") }),
    ...(context.req.query("cursor") === undefined ? {} : { cursor: context.req.query("cursor") }),
  });
  if (!params.success || !query.success) return context.json({ error: "statistics_stream_query_invalid" }, 400);

  const cursor = query.data.cursor === undefined ? null : decodeStreamCursor(query.data.cursor);
  if (query.data.cursor !== undefined && cursor === null) return context.json({ error: "statistics_stream_query_invalid" }, 400);

  const { channelId } = params.data;
  // Stream selection is window-backed; this grouping scans the channel's statistics rows.
  const statement = cursor === null
    ? context.env.DB.prepare(
      `SELECT stream_id, MIN(window_start) AS first_window_start, MAX(window_start) AS last_window_start
         FROM channel_statistics
        WHERE channel_id = ? AND stream_id IS NOT NULL
        GROUP BY stream_id
        ORDER BY MAX(window_start) DESC, stream_id DESC
        LIMIT ?`,
    ).bind(channelId, query.data.limit + 1)
    : context.env.DB.prepare(
      `SELECT stream_id, MIN(window_start) AS first_window_start, MAX(window_start) AS last_window_start
         FROM channel_statistics
        WHERE channel_id = ? AND stream_id IS NOT NULL
        GROUP BY stream_id
       HAVING MAX(window_start) < ? OR (MAX(window_start) = ? AND stream_id < ?)
        ORDER BY MAX(window_start) DESC, stream_id DESC
        LIMIT ?`,
    ).bind(channelId, cursor.cursorAt, cursor.cursorAt, cursor.streamId, query.data.limit + 1);
  const candidates = (await statement.all<StreamCandidateRow>()).results;
  const selected = candidates.slice(0, query.data.limit);
  if (selected.length === 0) return context.json({ streams: [], nextCursor: null });

  const streamIds = selected.map(({ stream_id }) => stream_id);
  const lastTimelineAt = new Date(Math.max(...selected.map(({ last_window_start }) => Date.parse(last_window_start))) + WINDOW_MILLISECONDS).toISOString();
  const placeholders = streamIds.map(() => "?").join(", ");
  const windowRows = await context.env.DB.prepare(
      `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics
        WHERE channel_id = ? AND stream_id IN (${placeholders})
        ORDER BY window_start ASC`,
    ).bind(channelId, ...streamIds).all<StreamWindowRow>();
  const firstWindowAt = Math.min(...selected.map(({ first_window_start }) => Date.parse(first_window_start)));
  const firstTimelineAt = new Date(firstWindowAt).toISOString();
  const [timelineRows, previousMetadata] = await Promise.all([
    context.env.DB.prepare(
      `SELECT kind, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at <= ?
          AND kind IN ('stream_online', 'stream_offline', 'channel_metadata', 'clip_created')
        ORDER BY occurred_at ASC`,
    ).bind(channelId, timelineTimestamp(firstTimelineAt), timelineTimestamp(lastTimelineAt)).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT kind, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(channelId, timelineTimestamp(firstTimelineAt)).all<TimelineRow>(),
  ]);
  const candidateCursorByStream = new Map(selected.map(({ stream_id, last_window_start }) => [stream_id, last_window_start]));
  const timeline = [
    ...previousMetadata.results.map(timelineEvent),
    ...timelineRows.results.map(timelineEvent),
  ];
  const summaries = groupStatisticsWindows(windowRows.results.map(statisticsWindow), timeline)
    .map((summary) => {
      const cursorAt = candidateCursorByStream.get(summary.streamId);
      return cursorAt === undefined ? summary : { ...summary, cursorAt };
    });
  const page = paginateStreamSummaries(summaries, null, query.data.limit);
  const lastCandidate = selected.at(-1);
  return context.json({
    streams: page.streams,
    nextCursor: candidates.length > query.data.limit && lastCandidate !== undefined
      ? encodeStreamCursor({ cursorAt: lastCandidate.last_window_start, streamId: lastCandidate.stream_id })
      : null,
  });
});

statisticsRoutes.get("/streams/:streamId", async (context) => {
  const params = streamParamsSchema.safeParse({
    channelId: context.req.param("channelId"),
    streamId: context.req.param("streamId"),
  });
  if (!params.success) return context.json({ error: "statistics_stream_params_invalid" }, 400);

  const { channelId, streamId } = params.data;
  const windowRows = await context.env.DB.prepare(
    `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
       FROM channel_statistics
      WHERE channel_id = ? AND stream_id = ?
      ORDER BY window_start ASC`,
  ).bind(channelId, streamId).all<StreamWindowRow>();
  const windows = windowRows.results.map(statisticsWindow);
  if (windows.length === 0) return context.json({ error: "statistics_stream_not_found" }, 404);

  const startedAt = windows[0]?.windowStart ?? "";
  const lastWindowStart = windows.at(-1)?.windowStart ?? startedAt;
  const endedAt = new Date(Date.parse(lastWindowStart) + WINDOW_MILLISECONDS).toISOString();
  const startMilliseconds = Date.parse(startedAt);
  const endMilliseconds = Date.parse(endedAt);
  const [timelineRows, previousMetadata, bitrateRows] = await Promise.all([
    context.env.DB.prepare(
      `SELECT kind, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at <= ?
        ORDER BY occurred_at ASC`,
    ).bind(channelId, timelineTimestamp(startedAt), timelineTimestamp(endedAt)).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT kind, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(channelId, timelineTimestamp(startedAt)).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT window_start, bitrate_avg, bitrate_min, bitrate_max, bitrate_p10
         FROM belabox_bitrate_windows
        WHERE channel_id = ? AND window_start >= ? AND window_start < ?
        ORDER BY window_start ASC`,
    ).bind(channelId, startMilliseconds, endMilliseconds).all<BitrateWindowRow>(),
  ]);
  const timeline = [
    ...previousMetadata.results.map(timelineEvent),
    ...timelineRows.results.map(timelineEvent),
  ];
  const summary = groupStatisticsWindows(windows, timeline).find((candidate) => candidate.streamId === streamId);
  if (summary === undefined) return context.json({ error: "statistics_stream_not_found" }, 404);
  const bitrateWindows: StatisticsBitrateWindow[] = bitrateRows.results.map((row) => ({
    windowStart: row.window_start,
    bitrateAvg: row.bitrate_avg,
    bitrateMin: row.bitrate_min,
    bitrateMax: row.bitrate_max,
    bitrateP10: row.bitrate_p10,
  }));

  return context.json({
    summary,
    windows,
    bitrateWindows: matchBitrateWindows(bitrateWindows, startedAt, endedAt),
    events: deriveStreamEvents(timeline, startedAt, endedAt, windows),
  });
});

statisticsRoutes.get("/trends", async (context) => {
  const params = listParamsSchema.safeParse({ channelId: context.req.param("channelId") });
  const query = trendsQuerySchema.safeParse({
    ...(context.req.query("weeks") === undefined ? {} : { weeks: context.req.query("weeks") }),
  });
  if (!params.success || !query.success) return context.json({ error: "statistics_trends_query_invalid" }, 400);

  const { channelId } = params.data;
  const endMilliseconds = Date.now();
  const end = new Date(endMilliseconds).toISOString();
  const periodMilliseconds = query.data.weeks * 7 * 24 * 60 * 60_000;
  const scanStart = new Date(endMilliseconds - 2 * periodMilliseconds).toISOString();
  const [channel, windowRows, metadataRows] = await Promise.all([
    context.env.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId)
      .first<{ time_zone: string }>(),
    // A single bounded range scan serves both equal-length comparison periods.
    context.env.DB.prepare(
      `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics
        WHERE channel_id = ? AND stream_id IS NOT NULL AND window_start >= ? AND window_start < ?
        ORDER BY window_start ASC`,
    ).bind(channelId, scanStart, end).all<StreamWindowRow>(),
    // Read in-range metadata plus only the latest earlier observation as the category seed.
    context.env.DB.prepare(
      `WITH metadata_in_range AS (
         SELECT event_key, kind, occurred_at, detail_json
           FROM channel_timeline_events
          WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at >= ? AND occurred_at < ?
       ), metadata_seed AS (
         SELECT event_key, kind, occurred_at, detail_json
           FROM channel_timeline_events
          WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at < ?
          ORDER BY occurred_at DESC, event_key DESC
          LIMIT 1
       )
       SELECT event_key, kind, occurred_at, detail_json FROM metadata_in_range
       UNION ALL
       SELECT event_key, kind, occurred_at, detail_json FROM metadata_seed
       ORDER BY occurred_at ASC, event_key ASC`,
    ).bind(channelId, timelineTimestamp(scanStart), timelineTimestamp(end), channelId, timelineTimestamp(scanStart))
      .all<TimelineRow>(),
  ]);
  const timeZone = channel !== null && validChannelTimeZone(channel.time_zone)
    ? channel.time_zone
    : DEFAULT_CHANNEL_TIME_ZONE;
  const response = deriveStatisticsTrends(
    windowRows.results.map(statisticsWindow),
    metadataRows.results.map(timelineEvent),
    { weeks: query.data.weeks, now: end, timeZone },
  );
  return context.json(response);
});

statisticsRoutes.get("/words", async (context) => {
  const params = listParamsSchema.safeParse({ channelId: context.req.param("channelId") });
  const query = wordsQuerySchema.safeParse({
    ...(context.req.query("page") === undefined ? {} : { page: context.req.query("page") }),
    search: context.req.query("search") ?? "",
    hideFillers: context.req.query("hideFillers") ?? "true",
    scope: context.req.query("scope") ?? "total",
  });
  if (!params.success || !query.success) return context.json({ error: "statistics_words_query_invalid" }, 400);

  const { channelId } = params.data;
  const search = foldStatisticsWord(query.data.search);
  const offset = (query.data.page - 1) * WORD_PAGE_SIZE;
  const settingsRow = await context.env.DB.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'statistics'",
  ).bind(channelId).first<{ settings: string }>();
  let ignoredWords = new Set<string>();
  if (settingsRow !== null) {
    try {
      const parsed: unknown = JSON.parse(settingsRow.settings);
      const settings = statisticsSettingsSchema.safeParse(parsed);
      if (settings.success) ignoredWords = new Set(settings.data.ignoredWords.map(foldStatisticsWord));
    } catch {
      // Invalid legacy settings leave the list visible and remain repairable through module settings.
    }
  }

  const counts = new Map<string, { displayWord: string; count: number; lastSeenAt: string }>();
  const addWord = (word: string, displayWord: string, count: number, lastSeenAt: string, replaceDisplay: boolean): void => {
    const current = counts.get(word);
    counts.set(word, {
      displayWord: replaceDisplay || current === undefined ? displayWord : current.displayWord,
      count: (current?.count ?? 0) + count,
      lastSeenAt: current === undefined || current.lastSeenAt < lastSeenAt ? lastSeenAt : current.lastSeenAt,
    });
  };

  if (query.data.scope === "stream") {
    const streamState = await context.env.DB.prepare(
      "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?",
    ).bind(channelId).first<{ state: string; stream_id: string | null }>();
    const onlineWithoutId = streamState?.state === "online" && streamState.stream_id === null;
    const channelObject = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId)) as unknown as StatisticsWordObject;
    const stream = onlineWithoutId
      ? null
      : await channelObject.readStatisticsWordStreamCounts(streamState?.state === "online" ? streamState.stream_id ?? undefined : undefined);
    for (const row of stream?.words ?? []) {
      addWord(row.word, row.displayWord ?? row.word, row.count, row.lastSeenAt, true);
    }
  } else {
    const streamState = await context.env.DB.prepare(
      "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?",
    ).bind(channelId).first<{ state: string; stream_id: string | null }>();
    const runningStreamId = streamState?.state === "online" ? streamState.stream_id : null;
    let pendingBatches: StatisticsWordBatchCounts[] = [];
    let streamDisplayWords = new Map<string, string>();
    if (runningStreamId !== null) {
      const channelObject = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId)) as unknown as StatisticsWordObject;
      pendingBatches = [...await channelObject.readStatisticsWordCountsByBatch(runningStreamId)];
      const stream = await channelObject.readStatisticsWordStreamCounts(runningStreamId);
      streamDisplayWords = new Map((stream?.words ?? []).map(({ word, displayWord }) => [word, displayWord ?? word]));
    }
    const baselineStatement = context.env.DB.prepare(
      `SELECT word, COALESCE(NULLIF(display_word, ''), word) AS display_word,
              total_count, last_seen_at
         FROM channel_word_frequency_baseline WHERE channel_id = ?
        ORDER BY total_count DESC, word ASC`,
    ).bind(channelId);
    const mergedBatchStatement = runningStreamId === null ? null : context.env.DB.prepare(
      `SELECT batch FROM channel_word_frequency_streams
        WHERE channel_id = ? AND stream_id = ? AND merged_at IS NOT NULL`,
    ).bind(channelId, runningStreamId);
    const [baselineResult, mergedBatchResult] = mergedBatchStatement === null
      ? [await baselineStatement.all<WordFrequencyRow>(), null] as const
      : await context.env.DB.batch([baselineStatement, mergedBatchStatement]) as [D1Result<WordFrequencyRow>, D1Result<{ batch: number }>];
    for (const row of baselineResult.results) {
      addWord(foldStatisticsWord(row.word), row.display_word, row.total_count, row.last_seen_at, false);
    }
    const mergedBatches = new Set(mergedBatchResult?.results.map(({ batch }) => batch) ?? []);
    const pendingWords = new Set<string>();
    for (const batch of pendingBatches) {
      if (mergedBatches.has(batch.batch)) continue;
      for (const row of batch.words) {
        pendingWords.add(row.word);
        addWord(row.word, row.displayWord ?? row.word, row.count, row.lastSeenAt, true);
      }
    }
    for (const word of pendingWords) {
      const count = counts.get(word);
      const displayWord = streamDisplayWords.get(word);
      if (count !== undefined && displayWord !== undefined) count.displayWord = displayWord;
    }
  }

  const fillerWords = new Set(STATISTICS_CHAT_FILLER_WORDS.map(foldStatisticsWord));
  const sourceWords = [...counts].map(([word, value]) => ({ word, ...value }));
  const totalCount = sourceWords.reduce((sum, word) => sum + word.count, 0);
  const maxCount = sourceWords.reduce((maximum, word) => Math.max(maximum, word.count), 0);
  const visibleWords = sourceWords.filter(({ word }) =>
    (search.length === 0 || word.includes(search)) && !ignoredWords.has(word) &&
    (!query.data.hideFillers || !fillerWords.has(word)));
  visibleWords.sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0));
  const total = visibleWords.length;
  const wordRows = visibleWords.slice(offset, offset + WORD_PAGE_SIZE);
  return context.json({
    words: wordRows.map((row, index) => ({
      rank: offset + index + 1,
      word: row.displayWord,
      count: row.count,
      share: totalCount === 0 ? 0 : row.count / totalCount,
      lastSeenAt: row.lastSeenAt,
    })),
    page: query.data.page,
    pageSize: WORD_PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / WORD_PAGE_SIZE),
    totalCount,
    maxCount,
  });
});
