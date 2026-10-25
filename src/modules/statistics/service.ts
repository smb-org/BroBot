import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
  ModuleTimelineEvent,
  ModuleStatisticsWindow,
} from "../contract";
import {
  STATISTICS_WORD_BASELINE_LIMIT,
  STATISTICS_WORD_STREAM_IDLE_MILLISECONDS,
  STATISTICS_WORD_STREAM_MERGE_LIMIT,
  STATISTICS_WINDOW_MILLISECONDS,
  statisticsWindowStartMs,
} from "./domain";

const EMOTE_SPIKE_BASELINE_WINDOWS = 12;
const EMOTE_SPIKE_MINIMUM_COUNT = 10;
const EMOTE_SPIKE_MULTIPLIER = 3;

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

// Windows and word streams catch up on a past deadline immediately; a clip import only waits, so it never spins.
const retryAt = (deadline: number, clipImportOnly: boolean): number =>
  clipImportOnly
    ? Math.max(deadline + STATISTICS_WINDOW_MILLISECONDS, nextBoundary(Date.now()))
    : deadline + STATISTICS_WINDOW_MILLISECONDS;

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

/**
 * Merges one word bucket into the channel baseline in a single D1 batch and returns whether the bucket
 * is now confirmed merged (this batch or an earlier attempt). The batch itself refuses a stream that D1
 * reports as live at write time (an online row without a stream id counts as live for every stream), so a
 * state change after the caller's read cannot merge a busy bucket. The confirmation SELECT ignores the live
 * state on purpose, so a retry after a lost response still confirms.
 */
export const mergeStatisticsWordBatch = async (
  db: D1Database,
  channelId: string,
  streamId: string,
  batch: number,
  wordCounts: readonly { word: string; count: number; lastSeenAt: string }[],
  mergedAt: string,
): Promise<boolean> => {
  const topWords = [...wordCounts]
    .sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0))
    .slice(0, STATISTICS_WORD_STREAM_MERGE_LIMIT);
  if (topWords.length === 0) return false;

  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO channel_word_frequency_streams (channel_id, stream_id, batch, merged_at)
       SELECT ?, ?, ?, NULL WHERE NOT EXISTS (
          SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND (stream_id IS NULL OR stream_id = ?)
        )`,
    ).bind(channelId, streamId, batch, channelId, streamId),
    db.prepare(
      `INSERT INTO channel_word_frequency_baseline
         (channel_id, word, total_count, last_seen_at)
       SELECT ?, json_extract(value, '$.word'), CAST(json_extract(value, '$.count') AS INTEGER),
              json_extract(value, '$.lastSeenAt')
         FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM channel_word_frequency_streams
           WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND (stream_id IS NULL OR stream_id = ?)
        )
       ON CONFLICT (channel_id, word) DO UPDATE SET
         total_count = channel_word_frequency_baseline.total_count + excluded.total_count,
         last_seen_at = MAX(channel_word_frequency_baseline.last_seen_at, excluded.last_seen_at)`,
    ).bind(channelId, JSON.stringify(topWords), channelId, streamId, batch, channelId, streamId),
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
        WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND (stream_id IS NULL OR stream_id = ?)
        )`,
    ).bind(mergedAt, channelId, streamId, batch, channelId, streamId),
    db.prepare(
      `SELECT 1 AS merged FROM channel_word_frequency_streams
        WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NOT NULL`,
    ).bind(channelId, streamId, batch),
  ]);
  return (results.at(-1)?.results.length ?? 0) > 0;
};

const recordEmoteSpike = async (
  context: ModuleAlarmContext,
  window: ModuleStatisticsWindow,
): Promise<void> => {
  if (context.recordTimelineEvent === undefined) return;
  const previous = await context.DB.prepare(
    `SELECT emotes FROM channel_statistics
      WHERE channel_id = ? AND window_start < ?
      ORDER BY window_start DESC LIMIT ?`,
  ).bind(context.channelId, window.windowStart, EMOTE_SPIKE_BASELINE_WINDOWS)
    .all<{ emotes: number }>();
  if (previous.results.length === 0 || window.emotes < EMOTE_SPIKE_MINIMUM_COUNT) return;

  const counts = previous.results.map(({ emotes }) => emotes).sort((left, right) => left - right);
  const middle = Math.floor(counts.length / 2);
  const medianEmotes = counts.length % 2 === 0
    ? ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2
    : counts[middle] ?? 0;
  if (window.emotes < medianEmotes * EMOTE_SPIKE_MULTIPLIER) return;

  const windowEnd = Date.parse(window.windowStart) + STATISTICS_WINDOW_MILLISECONDS;
  if (!Number.isFinite(windowEnd)) return;
  const timelineEvent: ModuleTimelineEvent = {
    kind: "emote_spike",
    identity: window.windowStart,
    occurredAt: new Date(windowEnd).toISOString(),
    detail: {
      windowStart: window.windowStart,
      emotes: window.emotes,
      medianEmotes,
      baselineWindows: counts.length,
      minimumEmotes: EMOTE_SPIKE_MINIMUM_COUNT,
      multiplier: EMOTE_SPIKE_MULTIPLIER,
    },
  };
  await context.recordTimelineEvent(timelineEvent);
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
    const streamId = context.streamSession?.streamId ?? textValue(event.payload.id);
    let alarmAt = nextBoundary(Date.now());
    if (context.streamStateTransitionAccepted === true) {
      if (streamId !== null) {
        await context.statisticsChat?.markWordStreamEnded(streamId, event.eventSubTimestamp ?? event.receivedAt);
      }
    }
    if (streamId !== null) {
      const endedAt = event.eventSubTimestamp ?? event.receivedAt;
      await context.statisticsChat?.markClipImportPending(streamId, endedAt);
      const endedAtMs = Date.parse(endedAt);
      const clipImportReadyAt = (Number.isFinite(endedAtMs) ? endedAtMs : Date.now()) +
          STATISTICS_WORD_STREAM_IDLE_MILLISECONDS;
      alarmAt = Math.max(alarmAt, clipImportReadyAt);
    }
    await context.scheduleAlarm("window", "window", alarmAt);
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
  const [deadline, hasWindows, hasWordStreams, hasClipImports] = await Promise.all([
    context.getAlarmDeadline?.("window") ?? Promise.resolve(null),
    context.statisticsChat.hasWindows(),
    context.statisticsChat.hasWordStreams(),
    context.statisticsChat.hasClipImports(),
  ]);
  if (deadline !== null || stream?.state !== "online" && !hasWindows && !hasWordStreams && !hasClipImports) return;
  await context.schedule("window", nextBoundary(now));
};

const streamStartedAt = async (context: ModuleAlarmContext, streamId: string): Promise<string | null> => {
  const row = await context.DB.prepare(
    `SELECT COALESCE(
       (SELECT json_extract(detail_json, '$.startedAt')
          FROM channel_timeline_events
         WHERE channel_id = ? AND kind = 'stream_online' AND stream_id = ?
           AND json_extract(detail_json, '$.startedAt') IS NOT NULL
         ORDER BY occurred_at ASC LIMIT 1),
       (SELECT MIN(window_start) FROM channel_statistics
         WHERE channel_id = ? AND stream_id = ?)
     ) AS started_at`,
  ).bind(context.channelId, streamId, context.channelId, streamId).first<{ started_at: string | null }>();
  return typeof row?.started_at === "string" && Number.isFinite(Date.parse(row.started_at))
    ? row.started_at
    : null;
};

const importReadyStreamClips = async (
  context: ModuleAlarmContext,
  now: number,
): Promise<void> => {
  const statisticsChat = context.statisticsChat;
  if (statisticsChat === undefined || context.fetchStreamClips === undefined ||
      context.recordTimelineEvent === undefined) return;
  for (const pending of await statisticsChat.listReadyClipImports(now)) {
    try {
      const startedAt = await streamStartedAt(context, pending.streamId);
      if (startedAt === null) continue;
      const clips = await context.fetchStreamClips(startedAt, pending.endedAt);
      if (clips === null) continue;
      for (const clip of clips) {
        await context.recordTimelineEvent({
          kind: "clip_created",
          identity: clip.clipId,
          occurredAt: clip.createdAt,
          detail: {
            clipId: clip.clipId,
            title: clip.title,
            createdAt: clip.createdAt,
            ...(clip.viewCount === undefined ? {} : { viewCount: clip.viewCount }),
            ...(clip.durationSeconds === undefined ? {} : { durationSeconds: clip.durationSeconds }),
          },
        });
      }
      await statisticsChat.completeClipImport(pending.streamId);
    } catch (error: unknown) {
      console.warn("Statistics clip import failed; the pending import will retry.", error);
    }
  }
};

/** Reads the stream state, advances the window clock and writes every completed dirty window. */
const flushCompletedWindows = async (
  context: ModuleAlarmContext,
  statisticsChat: NonNullable<ModuleAlarmContext["statisticsChat"]>,
  deadline: number,
): Promise<{
  streamIsOnline: boolean;
  streamState: "online" | "offline" | "unknown";
  streamId: string | null;
  writeFailure: unknown;
}> => {
  await statisticsChat.flushWordCounts();
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const streamIsOnline = stream?.state === "online" && stream.started_at !== null;
  const streamState = stream?.state === "online" ? "online" : stream?.state === "offline" ? "offline" : "unknown";
  await statisticsChat.reconcileWordStreams(streamState, stream?.stream_id ?? null, Date.now());
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
      try {
        await recordEmoteSpike(context, window);
      } catch (error: unknown) {
        // The window is already persisted; a lost spike must not keep it dirty or block the reschedule.
        console.warn("Emote spike could not be evaluated.", error);
      }
      await statisticsChat.markWindowClean(windowStart, window.revision);
    } catch (error: unknown) {
      writeFailure ??= error;
    }
  }
  return { streamIsOnline, streamState, streamId: stream?.stream_id ?? null, writeFailure };
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
  try {
    await context.statisticsChat.pruneExpiredClipImports(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  const [hasWindows, hasWordStreams, hasClipImports] = await Promise.all([
    context.statisticsChat.hasWindows(),
    context.statisticsChat.hasWordStreams(),
    context.statisticsChat.hasClipImports(),
  ]);
  if (flushFailed) {
    if (hasWindows || hasWordStreams || hasClipImports) {
      await context.schedule("window", retryAt(deadline, !hasWindows && !hasWordStreams));
    }
    if (flushFailure instanceof Error) throw flushFailure;
    throw new Error("Statistics state read failed.", { cause: flushFailure });
  }
  if (maintenanceFailure !== undefined) {
    if (outcome?.streamState === "online" || hasWindows || hasWordStreams || hasClipImports) {
      await context.schedule(
        "window",
        retryAt(deadline, outcome?.streamState !== "online" && !hasWindows && !hasWordStreams),
      );
    }
    if (maintenanceFailure instanceof Error) throw maintenanceFailure;
    throw new Error("Statistics retention pruning failed.", { cause: maintenanceFailure });
  }
  if (outcome === undefined) throw new Error("Statistics window alarm did not finish.");

  let wordMergeFailure: unknown;
  try {
    const idleBefore = now - STATISTICS_WORD_STREAM_IDLE_MILLISECONDS;
    const buckets = await context.statisticsChat.listMergeableWordBuckets(
      outcome.streamState,
      outcome.streamId,
      idleBefore,
    );
    const blockedStreams = new Set<string>();
    for (const bucket of buckets) {
      if (blockedStreams.has(bucket.streamId)) continue;
      try {
        const words = await context.statisticsChat.prepareWordBucketForMerge(
          bucket,
          outcome.streamState,
          outcome.streamId,
          idleBefore,
        );
        if (words.length === 0) continue;
        const merged = await mergeStatisticsWordBatch(
          context.DB,
          context.channelId,
          bucket.streamId,
          bucket.batch,
          words,
          new Date(now).toISOString(),
        );
        // A refused merge (stream turned live meanwhile) keeps the bucket for a later alarm and blocks
        // the stream's later batches so they cannot overtake it and reorder the capped baseline.
        if (merged) await context.statisticsChat.deleteWordBucket(bucket);
        else blockedStreams.add(bucket.streamId);
      } catch (error: unknown) {
        blockedStreams.add(bucket.streamId);
        wordMergeFailure ??= error;
      }
    }
  } catch (error: unknown) {
    wordMergeFailure ??= error;
  }

  await importReadyStreamClips(context, now);

  const pendingWordStreams = await context.statisticsChat.hasWordStreams();
  const pendingClipImports = await context.statisticsChat.hasClipImports();
  if (outcome.streamState === "online" || hasWindows || pendingWordStreams || pendingClipImports) {
    // The host retires an occurrence only if it is still the stored entry; scheduling the same key
    // also keeps D1 retries alive while the age-based pruning bound remains independent.
    await context.schedule(
      "window",
      retryAt(deadline, outcome.streamState !== "online" && !hasWindows && !pendingWordStreams),
    );
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
