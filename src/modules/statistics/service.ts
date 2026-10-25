import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
  ModuleStatisticsWindow,
} from "../contract";
import {
  STATISTICS_WORD_BASELINE_LIMIT,
  STATISTICS_WORD_STREAM_MERGE_LIMIT,
  STATISTICS_WINDOW_MILLISECONDS,
  statisticsWindowStartMs,
} from "./domain";

interface StoredStreamState {
  state: string;
  stream_id: string | null;
  started_at: string | null;
}

const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const nextBoundary = (time: number): number =>
  statisticsWindowStartMs(time) + STATISTICS_WINDOW_MILLISECONDS;

const sampledCount = async (read: (() => Promise<number | null>) | undefined): Promise<number | null> => {
  if (read === undefined) return null;
  try {
    const value = await read();
    return validCount(value) ? value : null;
  } catch {
    return null;
  }
};

const writeAbsoluteWindow = async (
  context: ModuleAlarmContext,
  window: ModuleStatisticsWindow,
): Promise<void> => {
  await context.DB.prepare(
    `INSERT INTO channel_statistics
       (channel_id, stream_id, window_start, messages, emotes, viewer_count, chatters, active_chatters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, window_start) DO UPDATE SET
       stream_id = excluded.stream_id,
       messages = MAX(channel_statistics.messages, excluded.messages),
       emotes = MAX(channel_statistics.emotes, excluded.emotes),
       viewer_count = excluded.viewer_count,
       chatters = excluded.chatters,
       active_chatters = excluded.active_chatters`,
  ).bind(
    context.channelId,
    window.streamId,
    window.windowStart,
    window.messages,
    window.emotes,
    window.viewerCount,
    window.chatters,
    window.activeChatters,
  ).run();
};

export const mergeStatisticsWordStream = async (
  db: D1Database,
  channelId: string,
  streamId: string,
  wordCounts: readonly { word: string; count: number; lastSeenAt: string }[],
  mergedAt: string,
): Promise<void> => {
  const topWords = [...wordCounts]
    .sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0))
    .slice(0, STATISTICS_WORD_STREAM_MERGE_LIMIT);
  if (topWords.length === 0) return;

  const wordPayload = JSON.stringify(topWords.map(({ word, count, lastSeenAt }) => ({ word, count, lastSeenAt })));
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO channel_word_frequency_streams (channel_id, stream_id, merged_at)
       VALUES (?, ?, NULL)`,
    ).bind(channelId, streamId),
    db.prepare(
      `INSERT INTO channel_word_frequency_baseline
         (channel_id, word, total_count, streams_seen, last_seen_at)
       SELECT ?, json_extract(value, '$.word'), CAST(json_extract(value, '$.count') AS INTEGER), 1,
              json_extract(value, '$.lastSeenAt')
         FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM channel_word_frequency_streams
           WHERE channel_id = ? AND stream_id = ? AND merged_at IS NULL
        )
       ON CONFLICT (channel_id, word) DO UPDATE SET
         total_count = channel_word_frequency_baseline.total_count + excluded.total_count,
         streams_seen = channel_word_frequency_baseline.streams_seen + 1,
         last_seen_at = MAX(channel_word_frequency_baseline.last_seen_at, excluded.last_seen_at)`,
    ).bind(channelId, wordPayload, channelId, streamId),
    db.prepare(
      `DELETE FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word NOT IN (
          SELECT word FROM channel_word_frequency_baseline
           WHERE channel_id = ?
           ORDER BY total_count DESC, word ASC
           LIMIT ?
        )`,
    ).bind(channelId, channelId, STATISTICS_WORD_BASELINE_LIMIT),
    db.prepare(
      `UPDATE channel_word_frequency_streams SET merged_at = ?
        WHERE channel_id = ? AND stream_id = ? AND merged_at IS NULL`,
    ).bind(mergedAt, channelId, streamId),
  ]);
};

export const processStatisticsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType === "stream.online") {
    if (context.streamStateTransitionAccepted !== true) return emptyResult();
    const startedAt = textValue(event.payload.started_at);
    const startedAtMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) return emptyResult();
    const receivedAtMs = Date.parse(event.receivedAt);
    await context.scheduleAlarm(
      "window",
      "window",
      nextBoundary(Number.isFinite(receivedAtMs) ? receivedAtMs : startedAtMs),
    );
    return emptyResult();
  }
  if (event.subscriptionType === "stream.offline") {
    const streamId = context.streamSession?.streamId;
    if (context.streamStateTransitionAccepted === true) {
      if (streamId !== null && streamId !== undefined) {
        await context.statisticsChat?.markWordStreamEnded(streamId, event.eventSubTimestamp ?? event.receivedAt);
      }
      await context.scheduleAlarm("window", "window", nextBoundary(Date.now()));
    }
    return emptyResult();
  }
  return emptyResult();
};

export const reconcileStatisticsSchedule = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (reason !== "stream_state" || context.statisticsChat === undefined) return;
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const now = Date.now();
  const [deadline, hasWindows, hasWordStreams] = await Promise.all([
    context.getAlarmDeadline?.("window") ?? Promise.resolve(null),
    context.statisticsChat.hasWindows(),
    context.statisticsChat.hasWordStreams(),
  ]);
  if (deadline !== null || stream?.state !== "online" && !hasWindows && !hasWordStreams) return;
  await context.schedule("window", nextBoundary(now));
};

/** Reads the stream state, advances the window clock and writes every completed dirty window. */
const flushCompletedWindows = async (
  context: ModuleAlarmContext,
  statisticsChat: NonNullable<ModuleAlarmContext["statisticsChat"]>,
  deadline: number,
): Promise<{ streamIsOnline: boolean; streamId: string | null; writeFailure: unknown }> => {
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const streamIsOnline = stream?.state === "online" && stream.started_at !== null;
  await statisticsChat.reconcileWordStreams(stream?.state === "online", stream?.stream_id ?? null, Date.now());
  await statisticsChat.advanceToBoundary(deadline, streamIsOnline, stream?.stream_id ?? null);

  const boundaryWindowStart = new Date(deadline - STATISTICS_WINDOW_MILLISECONDS).toISOString();
  const boundaryWindow = streamIsOnline ? await statisticsChat.readWindow(boundaryWindowStart) : null;
  if (boundaryWindow !== null && !boundaryWindow.metricsSampled) {
    const [viewerCount, chatters] = await Promise.all([
      sampledCount(context.fetchViewerCount),
      sampledCount(context.fetchChattersTotal),
    ]);
    await statisticsChat.saveWindowMetrics(boundaryWindowStart, viewerCount, chatters);
  }

  let writeFailure: unknown;
  for (const windowStart of await statisticsChat.listDirtyCompletedWindows()) {
    const window = await statisticsChat.readWindow(windowStart);
    if (window === null) continue;
    try {
      await writeAbsoluteWindow(context, window);
      await statisticsChat.markWindowClean(windowStart, window.revision);
    } catch (error: unknown) {
      writeFailure ??= error;
    }
  }
  return { streamIsOnline, streamId: stream?.stream_id ?? null, writeFailure };
};

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  if (alarmKey !== "window") return;
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");

  let outcome: Awaited<ReturnType<typeof flushCompletedWindows>> | undefined;
  let flushFailure: unknown;
  let flushFailed = false;
  try {
    outcome = await flushCompletedWindows(context, context.statisticsChat, deadline);
  } catch (error: unknown) {
    flushFailed = true;
    flushFailure = error;
  }
  // Age-based pruning must not depend on the state read or the D1 writes succeeding.
  const now = Date.now();
  let maintenanceFailure: unknown;
  try {
    await context.statisticsChat.pruneExpiredWindows(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  try {
    await context.statisticsChat.pruneExpiredWordStreams(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  const hasWindows = await context.statisticsChat.hasWindows();
  const hasWordStreams = await context.statisticsChat.hasWordStreams();
  if (flushFailed) {
    if (hasWindows || hasWordStreams) await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
    if (flushFailure instanceof Error) throw flushFailure;
    throw new Error("Statistics state read failed.", { cause: flushFailure });
  }
  if (maintenanceFailure !== undefined) {
    if (outcome?.streamIsOnline === true || hasWindows || hasWordStreams) {
      await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
    }
    if (maintenanceFailure instanceof Error) throw maintenanceFailure;
    throw new Error("Statistics retention pruning failed.", { cause: maintenanceFailure });
  }
  if (outcome === undefined) throw new Error("Statistics window alarm did not finish.");

  let wordMergeFailure: unknown;
  if (outcome.streamIsOnline || !hasWindows) {
    try {
      const endedStreams = await context.statisticsChat.listEndedWordStreams();
      for (const streamId of endedStreams) {
        try {
          const words = await context.statisticsChat.readWordCounts(streamId);
          await mergeStatisticsWordStream(context.DB, context.channelId, streamId, words, new Date(now).toISOString());
          await context.statisticsChat.deleteWordStream(streamId);
        } catch (error: unknown) {
          wordMergeFailure ??= error;
        }
      }
    } catch (error: unknown) {
      wordMergeFailure ??= error;
    }
  }

  const pendingWordStreams = await context.statisticsChat.hasWordStreams();
  if (outcome.streamIsOnline || hasWindows || pendingWordStreams) {
    // The host retires an occurrence only if it is still the stored entry; scheduling the same key
    // also keeps D1 retries alive while the age-based pruning bound remains independent.
    await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
  }

  if (outcome.writeFailure !== undefined) {
    if (outcome.writeFailure instanceof Error) throw outcome.writeFailure;
    throw new Error("Statistics window write failed.", { cause: outcome.writeFailure });
  }
  if (wordMergeFailure instanceof Error) throw wordMergeFailure;
  if (wordMergeFailure !== undefined) {
    throw new Error("Statistics word baseline merge failed.", { cause: wordMergeFailure });
  }
};
