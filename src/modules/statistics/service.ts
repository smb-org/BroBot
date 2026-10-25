import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
  ModuleTimelineEvent,
  ModuleStatisticsWindow,
} from "../contract";
import { STATISTICS_WINDOW_MILLISECONDS, statisticsWindowStartMs } from "./domain";

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
  const [deadline, hasWindows] = await Promise.all([
    context.getAlarmDeadline?.("window") ?? Promise.resolve(null),
    context.statisticsChat.hasWindows(),
  ]);
  if (deadline !== null || stream?.state !== "online" && !hasWindows) return;
  await context.schedule("window", nextBoundary(now));
};

/** Reads the stream state, advances the window clock and writes every completed dirty window. */
const flushCompletedWindows = async (
  context: ModuleAlarmContext,
  statisticsChat: NonNullable<ModuleAlarmContext["statisticsChat"]>,
  deadline: number,
): Promise<{ streamIsOnline: boolean; writeFailure: unknown }> => {
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const streamIsOnline = stream?.state === "online" && stream.started_at !== null;
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
      await recordEmoteSpike(context, window);
      await statisticsChat.markWindowClean(windowStart, window.revision);
    } catch (error: unknown) {
      writeFailure ??= error;
    }
  }
  return { streamIsOnline, writeFailure };
};

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  if (alarmKey !== "window") return;
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");

  let outcome: Awaited<ReturnType<typeof flushCompletedWindows>>;
  try {
    outcome = await flushCompletedWindows(context, context.statisticsChat, deadline);
  } finally {
    // Age-based pruning must not depend on the state read or the D1 writes succeeding.
    await context.statisticsChat.pruneExpiredWindows(Date.now());
  }
  const hasWindows = await context.statisticsChat.hasWindows();
  if (outcome.writeFailure !== undefined) {
    if (outcome.writeFailure instanceof Error) throw outcome.writeFailure;
    throw new Error("Statistics window write failed.", { cause: outcome.writeFailure });
  }

  // Without a reschedule the host retires this occurrence only if it is still the stored entry, so a
  // newer alarm armed by a concurrent stream.online is never cleared from here.
  if (outcome.streamIsOnline || hasWindows) {
    await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
  }
};
