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
  const lastTimelineAt = new Date(Math.max(...selected.map(({ last_window_start }) => Date.parse(last_window_start))) + WINDOW_MILLISECONDS + DROP_QUERY_PADDING_MILLISECONDS).toISOString();
  const placeholders = streamIds.map(() => "?").join(", ");
  const [windowRows, onlineRows] = await Promise.all([
    context.env.DB.prepare(
      `SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics
        WHERE channel_id = ? AND stream_id IN (${placeholders})
        ORDER BY window_start ASC`,
    ).bind(channelId, ...streamIds).all<StreamWindowRow>(),
    context.env.DB.prepare(
      `SELECT occurred_at
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'stream_online' AND stream_id IN (${placeholders})
        ORDER BY occurred_at ASC`,
    ).bind(channelId, ...streamIds).all<{ occurred_at: string }>(),
  ]);
  const firstWindowAt = Math.min(...selected.map(({ first_window_start }) => Date.parse(first_window_start)));
  const firstOnlineAt = onlineRows.results.reduce((earliest, row) => Math.min(earliest, Date.parse(row.occurred_at)), firstWindowAt);
  const firstTimelineAt = new Date(Math.min(firstWindowAt, firstOnlineAt)).toISOString();
  const [timelineRows, previousMetadata] = await Promise.all([
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at < ?
          AND kind IN ('stream_online', 'stream_offline', 'channel_metadata', 'clip_created')
        ORDER BY occurred_at ASC`,
    ).bind(channelId, timelineTimestamp(firstTimelineAt), timelineTimestamp(lastTimelineAt)).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
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
  const firstOnline = await context.env.DB.prepare(
    `SELECT occurred_at
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'stream_online' AND stream_id = ?
      ORDER BY occurred_at ASC LIMIT 1`,
  ).bind(channelId, streamId).first<{ occurred_at: string }>();
  const eventsStart = firstOnline?.occurred_at ?? startedAt;
  const eventsEnd = new Date(Date.parse(endedAt) + DROP_QUERY_PADDING_MILLISECONDS).toISOString();
  const startMilliseconds = Date.parse(startedAt);
  const endMilliseconds = Date.parse(endedAt);
  const [timelineRows, previousMetadata, bitrateRows] = await Promise.all([
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at ASC`,
    ).bind(channelId, timelineTimestamp(eventsStart), timelineTimestamp(eventsEnd)).all<TimelineRow>(),
    context.env.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'channel_metadata' AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(channelId, timelineTimestamp(eventsStart)).all<TimelineRow>(),
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
    events: deriveStreamEvents(timeline, startedAt, endedAt, streamId),
  });
});
