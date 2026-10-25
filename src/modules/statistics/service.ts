import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
  ModuleStatisticsWindow,
} from "../contract";
import { STATISTICS_WINDOW_MILLISECONDS, statisticsWindowStartMs } from "./domain";

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

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  if (alarmKey !== "window") return;
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");

  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const streamIsOnline = stream?.state === "online" && stream.started_at !== null;
  await context.statisticsChat.advanceToBoundary(deadline, streamIsOnline, stream?.stream_id ?? null);

  const boundaryWindowStart = new Date(deadline - STATISTICS_WINDOW_MILLISECONDS).toISOString();
  const boundaryWindow = streamIsOnline
    ? await context.statisticsChat.readWindow(boundaryWindowStart)
    : null;
  if (boundaryWindow !== null && !boundaryWindow.metricsSampled) {
    const [viewerCount, chatters] = await Promise.all([
      sampledCount(context.fetchViewerCount),
      sampledCount(context.fetchChattersTotal),
    ]);
    await context.statisticsChat.saveWindowMetrics(boundaryWindowStart, viewerCount, chatters);
  }

  let writeFailure: unknown;
  const dirtyWindows = await context.statisticsChat.listDirtyCompletedWindows();
  for (const windowStart of dirtyWindows) {
    const window = await context.statisticsChat.readWindow(windowStart);
    if (window === null) continue;
    try {
      await writeAbsoluteWindow(context, window);
      await context.statisticsChat.markWindowClean(windowStart, window.revision);
    } catch (error: unknown) {
      writeFailure ??= error;
    }
  }

  const now = Date.now();
  await context.statisticsChat.pruneExpiredWindows(now);
  const hasWindows = await context.statisticsChat.hasWindows();
  if (writeFailure !== undefined) {
    if (writeFailure instanceof Error) throw writeFailure;
    throw new Error("Statistics window write failed.", { cause: writeFailure });
  }

  if (streamIsOnline || hasWindows) {
    await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
  } else {
    await context.clear("window");
  }
};
