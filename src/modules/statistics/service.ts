import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { STATISTICS_WINDOW_MILLISECONDS, STATISTICS_WINDOW_SECONDS, statisticsWindowStartMs } from "./domain";

interface StoredStreamState {
  state: string;
  stream_id: string | null;
  started_at: string | null;
  transition_generation: number;
}

/** One window as written to D1; `windowEnd` is how far the row covers (partial windows end early). */
interface StatisticsWindowSnapshot {
  streamId: string | null;
  windowStart: string;
  windowEnd: string;
  windowSeconds: number;
  messages: number;
  emotes: number;
  viewerCount: number | null;
  chatters: number | null;
  activeChatters: number | null;
}

interface OfflineWindowInvocation {
  kind: "offline-window";
  streamId: string | null;
  streamStartedAt: string | null;
  windowStart: string;
  windowEnd: string;
}

/** The snapshot most recently written to D1: the "already flushed" marker and the carry for a flapped window. */
const LAST_FLUSH_KEY = "last";

const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOfflineWindowInvocation = (value: unknown): value is OfflineWindowInvocation =>
  isRecord(value) && value.kind === "offline-window" &&
  (value.streamId === null || typeof value.streamId === "string") &&
  (value.streamStartedAt === null || typeof value.streamStartedAt === "string") &&
  typeof value.windowStart === "string" && typeof value.windowEnd === "string";

const pendingSnapshotKey = (windowStart: string): string => `pending:${String(Date.parse(windowStart))}`;

const snapshotFrom = (value: unknown): StatisticsWindowSnapshot | null => {
  if (!isRecord(value) || (value.streamId !== null && typeof value.streamId !== "string") ||
      typeof value.windowStart !== "string" || typeof value.windowEnd !== "string" ||
      !validCount(value.windowSeconds) || value.windowSeconds < 1 ||
      value.windowSeconds > STATISTICS_WINDOW_SECONDS || !validCount(value.messages) || !validCount(value.emotes) ||
      !(value.viewerCount === null || validCount(value.viewerCount)) ||
      !(value.chatters === null || validCount(value.chatters)) ||
      !(value.activeChatters === null || validCount(value.activeChatters))) return null;
  return value as unknown as StatisticsWindowSnapshot;
};

interface WindowInput {
  streamId: string | null;
  /** Start of the stream segment this flush belongs to; a partial first window only covers time after it. */
  streamStartedAt: string | null;
  windowStart: string;
  windowEnd: string;
  shouldFetchLiveMetrics: boolean;
}

/**
 * Builds the row for one flush. When the same epoch-aligned window was already flushed earlier
 * (offline/online flap), the earlier counts and covered seconds are carried into the new row.
 */
const snapshotFor = async (
  context: ModuleAlarmContext,
  input: WindowInput,
  carry: StatisticsWindowSnapshot | null,
): Promise<StatisticsWindowSnapshot> => {
  const windowStartMs = Date.parse(input.windowStart);
  const windowEndMs = Date.parse(input.windowEnd);
  const streamStartMs = input.streamStartedAt === null ? Number.NaN : Date.parse(input.streamStartedAt);
  const segmentStartMs = Math.max(
    windowStartMs,
    Number.isFinite(streamStartMs) ? streamStartMs : windowStartMs,
    carry === null ? windowStartMs : Date.parse(carry.windowEnd),
  );
  const segmentSeconds = Math.min(
    STATISTICS_WINDOW_SECONDS,
    Math.max(1, Math.ceil((windowEndMs - segmentStartMs) / 1_000)),
  );
  const [chat, activeChatters, viewerCount, chatters] = await Promise.all([
    context.statisticsChat?.readWindow(input.windowStart),
    context.activeChatters?.countBetween(input.windowStart, input.windowEnd),
    input.shouldFetchLiveMetrics ? context.fetchViewerCount?.() : Promise.resolve(null),
    input.shouldFetchLiveMetrics ? context.fetchChattersTotal?.() : Promise.resolve(null),
  ]);
  if (chat === undefined || activeChatters === undefined) {
    throw new Error("Statistics aggregate sources are unavailable.");
  }
  const messages = validCount(chat.messages) ? chat.messages : 0;
  const currentActive = validCount(activeChatters) ? activeChatters : messages === 0 ? 0 : null;
  // Distinct chatters cannot be merged across a flap (tracking is cleared on offline): keep a side that is
  // trivially empty, otherwise report unknown rather than a wrong number.
  const mergedActive = carry === null || carry.messages === 0
    ? currentActive
    : messages === 0 ? carry.activeChatters : null;
  return {
    streamId: input.streamId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    windowSeconds: Math.min(STATISTICS_WINDOW_SECONDS, segmentSeconds + (carry?.windowSeconds ?? 0)),
    messages: messages + (carry?.messages ?? 0),
    emotes: (validCount(chat.emotes) ? chat.emotes : 0) + (carry?.emotes ?? 0),
    viewerCount: (validCount(viewerCount) ? viewerCount : null) ?? carry?.viewerCount ?? null,
    chatters: (validCount(chatters) ? chatters : null) ?? carry?.chatters ?? null,
    activeChatters: mergedActive,
  };
};

/** Upsert, then clear the live counters, then record the marker; every step is safe to repeat. */
const commitSnapshot = async (context: ModuleAlarmContext, snapshot: StatisticsWindowSnapshot): Promise<void> => {
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");
  await context.DB.prepare(
    `INSERT INTO channel_statistics
       (channel_id, stream_id, window_start, window_seconds, messages, emotes, viewer_count, chatters, active_chatters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, window_start) DO UPDATE SET
       stream_id = excluded.stream_id,
       window_seconds = excluded.window_seconds,
       messages = excluded.messages,
       emotes = excluded.emotes,
       viewer_count = excluded.viewer_count,
       chatters = excluded.chatters,
       active_chatters = excluded.active_chatters`,
  ).bind(
    context.channelId,
    snapshot.streamId,
    snapshot.windowStart,
    snapshot.windowSeconds,
    snapshot.messages,
    snapshot.emotes,
    snapshot.viewerCount,
    snapshot.chatters,
    snapshot.activeChatters,
  ).run();
  await context.statisticsChat.clearWindow(snapshot.windowStart);
  await context.storage.put(LAST_FLUSH_KEY, snapshot);
  await context.storage.delete(pendingSnapshotKey(snapshot.windowStart));
};

const flushWindow = async (context: ModuleAlarmContext, input: WindowInput): Promise<void> => {
  const key = pendingSnapshotKey(input.windowStart);
  // A snapshot left behind by an interrupted flush is finished first, unchanged (retries never re-read the counters).
  const pending = snapshotFrom(await context.storage.get(key));
  if (pending !== null) await commitSnapshot(context, pending);

  const windowStartMs = Date.parse(input.windowStart);
  const last = snapshotFrom(await context.storage.get(LAST_FLUSH_KEY));
  const lastStartMs = last === null ? Number.NEGATIVE_INFINITY : Date.parse(last.windowStart);
  if (last !== null && (lastStartMs > windowStartMs ||
      lastStartMs === windowStartMs && Date.parse(last.windowEnd) >= Date.parse(input.windowEnd))) return;

  const snapshot = await snapshotFor(context, input, last !== null && lastStartMs === windowStartMs ? last : null);
  await context.storage.put(key, snapshot);
  await commitSnapshot(context, snapshot);
};

export const processStatisticsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType === "stream.online") {
    if (context.streamStateTransitionAccepted !== true) return emptyResult();
    const startedAt = textValue(event.payload.started_at);
    if (startedAt === null) return emptyResult();
    const streamStart = Date.parse(startedAt);
    if (!Number.isFinite(streamStart)) return emptyResult();
    // First alarm at the next UTC five-minute boundary; the window before it is partial.
    await context.scheduleAlarm(
      "window",
      "window",
      statisticsWindowStartMs(streamStart) + STATISTICS_WINDOW_MILLISECONDS,
      undefined,
      context.streamStateTransitionGeneration,
    );
    return emptyResult();
  }

  if (event.subscriptionType !== "stream.offline" || context.streamStateTransitionAccepted !== true) {
    return emptyResult();
  }
  const session = context.streamSession;
  const endedAt = Date.parse(event.eventSubTimestamp ?? event.receivedAt);
  if (!Number.isFinite(endedAt)) return emptyResult();
  const scheduledDeadline = await context.getAlarmDeadline?.("window") ?? null;
  const startedAt = session?.startedAt;
  const streamStart = startedAt === null || startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const firstWindowStart = scheduledDeadline === null
    ? Number.isFinite(streamStart) ? statisticsWindowStartMs(streamStart) : null
    : scheduledDeadline - STATISTICS_WINDOW_MILLISECONDS;
  if (firstWindowStart !== null) {
    if (context.runModuleAlarm === undefined) throw new Error("Statistics alarm runner is unavailable.");
    for (let windowStart = firstWindowStart; windowStart < endedAt; windowStart += STATISTICS_WINDOW_MILLISECONDS) {
      const windowEnd = Math.min(windowStart + STATISTICS_WINDOW_MILLISECONDS, endedAt);
      await context.runModuleAlarm("window", `offline:${String(windowStart)}`, {
        kind: "offline-window",
        streamId: session?.streamId ?? null,
        streamStartedAt: session?.startedAt ?? null,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
      } satisfies OfflineWindowInvocation);
    }
  }
  await context.clearAlarm("window");
  return emptyResult();
};

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
  _ownerRevision?: number,
  invocation?: unknown,
): Promise<void> => {
  if (isOfflineWindowInvocation(invocation)) {
    await flushWindow(context, { ...invocation, shouldFetchLiveMetrics: false });
    return;
  }

  if (alarmKey !== "window") return;
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at, transition_generation FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  if (stream?.state !== "online" || stream.started_at === null ||
      context.streamGeneration !== undefined && stream.transition_generation !== context.streamGeneration) {
    await context.clear("window");
    return;
  }

  const streamStart = Date.parse(stream.started_at);
  if (!Number.isFinite(streamStart) || deadline <= streamStart) {
    await context.clear("window");
    return;
  }
  await flushWindow(context, {
    streamId: stream.stream_id,
    streamStartedAt: stream.started_at,
    windowStart: new Date(deadline - STATISTICS_WINDOW_MILLISECONDS).toISOString(),
    windowEnd: new Date(deadline).toISOString(),
    shouldFetchLiveMetrics: true,
  });
  await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS, undefined, context.streamGeneration);
};
