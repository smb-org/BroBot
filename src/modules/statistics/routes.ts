import { Hono } from "hono";
import { z } from "zod";

import type { ModuleRouteEnvironment } from "../contract";
import type { StatisticsBitrateWindow, StatisticsStreamWindow, StatisticsTimelineEvent } from "./contracts";
import { decodeStreamCursor, deriveStreamEvents, encodeStreamCursor, groupStatisticsWindows, matchBitrateWindows, paginateStreamSummaries } from "./streams-domain";

const WINDOW_MILLISECONDS = 5 * 60_000;
const DROP_QUERY_PADDING_MILLISECONDS = 10 * 60_000;

const listParamsSchema = z.object({ channelId: z.string().trim().min(1).max(128) });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
const streamParamsSchema = z.object({
  channelId: z.string().trim().min(1).max(128),
  streamId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u),
});

interface StreamCandidateRow {
  stream_id: string;
  first_online_at: string;
  last_online_at: string;
}

interface StreamLifecycleRow {
  started_at: string;
  last_online_at: string;
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
  stream_id: string | null;
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
  return { kind: row.kind, streamId: row.stream_id, occurredAt: row.occurred_at, detail };
};

const floorToWindow = (instant: string): string =>
  new Date(Math.floor(Date.parse(instant) / WINDOW_MILLISECONDS) * WINDOW_MILLISECONDS).toISOString();

const nextOnlineAfter = async (db: D1Database, channelId: string, streamId: string, after: string): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT occurred_at
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'stream_online' AND stream_id <> ? AND occurred_at > ?
      ORDER BY occurred_at ASC LIMIT 1`,
  ).bind(channelId, streamId, after).first<{ occurred_at: string }>();
  return row?.occurred_at ?? null;
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
  // Lifecycle candidates use the channel/kind/time index; at most one extra stream is read for cursor paging.
  const statement = cursor === null
    ? context.env.DB.prepare(
      `SELECT stream_id, MIN(occurred_at) AS first_online_at, MAX(occurred_at) AS last_online_at
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'stream_online' AND stream_id IS NOT NULL
        GROUP BY stream_id
        ORDER BY MAX(occurred_at) DESC, stream_id DESC
        LIMIT ?`,
    ).bind(channelId, query.data.limit + 1)
    : context.env.DB.prepare(
      `SELECT stream_id, MIN(occurred_at) AS first_online_at, MAX(occurred_at) AS last_online_at
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'stream_online' AND stream_id IS NOT NULL
        GROUP BY stream_id
       HAVING MAX(occurred_at) < ? OR (MAX(occurred_at) = ? AND stream_id < ?)
        ORDER BY MAX(occurred_at) DESC, stream_id DESC
        LIMIT ?`,
    ).bind(channelId, cursor.cursorAt, cursor.cursorAt, cursor.streamId, query.data.limit + 1);
  const candidates = (await statement.all<StreamCandidateRow>()).results;
  const selected = candidates.slice(0, query.data.limit);
  if (selected.length === 0) return context.json({ streams: [], nextCursor: null });

  const streamIds = selected.map(({ stream_id }) => stream_id);
  const firstStart = selected.reduce((first, row) => {
    const windowStart = floorToWindow(row.first_online_at);
    return windowStart < first ? windowStart : first;
  }, floorToWindow(selected[0]?.first_online_at ?? ""));
  const pageLastOnline = Math.max(...selected.map(({ last_online_at }) => Date.parse(last_online_at)));
  const latestRangeEnd = new Date(Math.max(Date.now(), pageLastOnline + WINDOW_MILLISECONDS)).toISOString();
  // Include the 5-minute boundary for same-timestamp cursor ties; only selected stream ids are returned.
  const endExclusive = cursor === null ? latestRangeEnd : new Date(Date.parse(cursor.cursorAt) + WINDOW_MILLISECONDS).toISOString();
  const placeholders = streamIds.map(() => "?").join(", ");
  const [windowRows, timelineRows] = await Promise.all([
    context.env.DB.prepare(
      `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics
        WHERE channel_id = ? AND window_start >= ? AND window_start < ?
          AND stream_id IN (${placeholders})
        ORDER BY window_start ASC`,
    ).bind(channelId, firstStart, endExclusive, ...streamIds).all<StreamWindowRow>(),
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at < ?
          AND kind IN ('stream_online', 'channel_metadata', 'clip_created')
        ORDER BY occurred_at ASC`,
    ).bind(channelId, firstStart, endExclusive).all<TimelineRow>(),
  ]);
  const candidateCursorByStream = new Map(selected.map(({ stream_id, last_online_at }) => [stream_id, last_online_at]));
  const summaries = groupStatisticsWindows(windowRows.results.map(statisticsWindow), timelineRows.results.map(timelineEvent))
    .map((summary) => {
      const cursorAt = candidateCursorByStream.get(summary.streamId);
      return cursorAt === undefined ? summary : { ...summary, cursorAt };
    });
  const page = paginateStreamSummaries(summaries, null, query.data.limit);
  const lastCandidate = selected.at(-1);
  return context.json({
    streams: page.streams,
    nextCursor: candidates.length > query.data.limit && lastCandidate !== undefined
      ? encodeStreamCursor({ cursorAt: lastCandidate.last_online_at, streamId: lastCandidate.stream_id })
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
  const lifecycle = await context.env.DB.prepare(
    `SELECT MIN(occurred_at) AS started_at, MAX(occurred_at) AS last_online_at
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'stream_online' AND stream_id = ?
      GROUP BY stream_id`,
  ).bind(channelId, streamId).first<StreamLifecycleRow>();
  if (lifecycle === null) return context.json({ error: "statistics_stream_not_found" }, 404);

  const rangeStart = floorToWindow(lifecycle.started_at);
  const nextStreamStart = await nextOnlineAfter(context.env.DB, channelId, streamId, lifecycle.last_online_at);
  const rangeEnd = nextStreamStart ?? new Date(Math.max(Date.now(), Date.parse(lifecycle.last_online_at) + WINDOW_MILLISECONDS)).toISOString();
  const windowRows = await context.env.DB.prepare(
    `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
       FROM channel_statistics
      WHERE channel_id = ? AND window_start >= ? AND window_start < ? AND stream_id = ?
      ORDER BY window_start ASC`,
  ).bind(channelId, rangeStart, rangeEnd, streamId).all<StreamWindowRow>();
  const windows = windowRows.results.map(statisticsWindow);
  if (windows.length === 0) return context.json({ error: "statistics_stream_not_found" }, 404);

  const startedAt = windows[0]?.windowStart ?? rangeStart;
  const lastWindowStart = windows.at(-1)?.windowStart ?? startedAt;
  const endedAt = new Date(Date.parse(lastWindowStart) + WINDOW_MILLISECONDS).toISOString();
  const eventsEnd = new Date(Date.parse(endedAt) + DROP_QUERY_PADDING_MILLISECONDS).toISOString();
  const startMilliseconds = Date.parse(startedAt);
  const endMilliseconds = Date.parse(endedAt);
  const [timelineRows, previousMetadata, bitrateRows] = await Promise.all([
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at ASC`,
    ).bind(channelId, startedAt, eventsEnd).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(channelId, startedAt).all<TimelineRow>(),
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
    events: deriveStreamEvents(timeline, startedAt, endedAt),
  });
});
