import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
} from "../contract";
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

/** Window snapshots also act as a carry when an offline/online flap reuses the same epoch window. */
const lastFlushKey = (windowStart: string): string => `last:${String(Date.parse(windowStart))}`;

const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pendingSnapshotKey = (windowStart: string): string => `pending:${String(Date.parse(windowStart))}`;
const WINDOW_SNAPSHOT_PRUNE_CURSOR_KEY = "snapshot_prune_cursor";

const offlineFlushAlarmKey = (
  streamId: string | null,
  streamStartedAt: string | null,
  firstWindowStart: number,
  endedAt: number,
  transitionGeneration: number,
): string => `offline:${encodeURIComponent(streamId ?? "")}:${streamStartedAt === null ? "" : String(Date.parse(streamStartedAt))}:${String(firstWindowStart)}:${String(endedAt)}:${String(transitionGeneration)}`;

const offlineFlushFromAlarmKey = (alarmKey: string): {
  streamId: string | null;
  streamStartedAt: string | null;
  firstWindowStart: number;
  endedAt: number;
  transitionGeneration: number;
} | null => {
  const parts = alarmKey.split(":");
  if (parts.length !== 6 || parts[0] !== "offline" || !/^\d+$/u.test(parts[3] ?? "") ||
      !/^\d+$/u.test(parts[4] ?? "") || !/^\d+$/u.test(parts[5] ?? "") ||
      (parts[2] !== "" && !/^\d+$/u.test(parts[2] ?? ""))) return null;
  let streamId: string;
  try {
    streamId = decodeURIComponent(parts[1] ?? "");
  } catch {
    return null;
  }
  const streamStartedAtMs = parts[2] === "" ? null : Number(parts[2]);
  const firstWindowStart = Number(parts[3]);
  const endedAt = Number(parts[4]);
  const transitionGeneration = Number(parts[5]);
  if (!Number.isSafeInteger(firstWindowStart) || !Number.isSafeInteger(endedAt) || endedAt <= firstWindowStart ||
      !Number.isSafeInteger(transitionGeneration) || streamStartedAtMs !== null && !Number.isSafeInteger(streamStartedAtMs)) return null;
  return {
    streamId: streamId.length === 0 ? null : streamId,
    streamStartedAt: streamStartedAtMs === null ? null : new Date(streamStartedAtMs).toISOString(),
    firstWindowStart,
    endedAt,
    transitionGeneration,
  };
};

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
  windowCounters: {
    messages: number;
    emotes: number;
    activeChatters: number | null;
    hasNew: boolean;
  },
): Promise<StatisticsWindowSnapshot> => {
  const windowStartMs = Date.parse(input.windowStart);
  const windowEndMs = Date.parse(input.windowEnd);
  const streamStartMs = input.streamStartedAt === null ? Number.NaN : Date.parse(input.streamStartedAt);
  const segmentStartMs = Math.max(
    windowStartMs,
    Number.isFinite(streamStartMs) ? streamStartMs : windowStartMs,
    carry === null ? windowStartMs : Date.parse(carry.windowEnd),
  );
  const segmentSeconds = carry !== null && windowEndMs <= Date.parse(carry.windowEnd)
    ? 0
    : Math.min(
      STATISTICS_WINDOW_SECONDS,
      Math.max(1, Math.ceil((windowEndMs - segmentStartMs) / 1_000)),
    );
  const [viewerCount, chatters] = await Promise.all([
    input.shouldFetchLiveMetrics ? context.fetchViewerCount?.() : Promise.resolve(null),
    input.shouldFetchLiveMetrics ? context.fetchChattersTotal?.() : Promise.resolve(null),
  ]);
  const messages = validCount(windowCounters.messages) ? windowCounters.messages : 0;
  const emotes = validCount(windowCounters.emotes) ? windowCounters.emotes : 0;
  const activeChatters = windowCounters.activeChatters;
  return {
    streamId: input.streamId,
    windowStart: input.windowStart,
    windowEnd: segmentSeconds === 0 && carry !== null ? carry.windowEnd : input.windowEnd,
    windowSeconds: Math.min(STATISTICS_WINDOW_SECONDS, segmentSeconds + (carry?.windowSeconds ?? 0)),
    messages: messages + (carry?.messages ?? 0),
    emotes: emotes + (carry?.emotes ?? 0),
    viewerCount: (validCount(viewerCount) ? viewerCount : null) ?? carry?.viewerCount ?? null,
    chatters: (validCount(chatters) ? chatters : null) ?? carry?.chatters ?? null,
    activeChatters: validCount(activeChatters) ? activeChatters : messages === 0 ? 0 : carry?.activeChatters ?? null,
  };
};

/** Upsert, acknowledge the atomically staged counters, then record the marker; every step is safe to repeat. */
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
  await context.storage.put(lastFlushKey(snapshot.windowStart), snapshot);
  await context.statisticsChat.finishWindowFlush(snapshot.windowStart);
  await context.storage.delete(pendingSnapshotKey(snapshot.windowStart));
};

const flushWindow = async (context: ModuleAlarmContext, input: WindowInput): Promise<void> => {
  const key = pendingSnapshotKey(input.windowStart);
  // A snapshot left behind by an interrupted flush is finished first, unchanged (retries never re-read the counters).
  const pending = snapshotFrom(await context.storage.get(key));
  if (pending !== null) await commitSnapshot(context, pending);

  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");
  const [last, windowCounters] = await Promise.all([
    context.storage.get(lastFlushKey(input.windowStart)).then(snapshotFrom),
    context.statisticsChat.beginWindowFlush(input.windowStart),
  ]);
  if (!windowCounters.hasNew && last !== null && Date.parse(last.windowEnd) >= Date.parse(input.windowEnd)) return;

  const snapshot = await snapshotFor(context, input, last, windowCounters);
  await context.storage.put(key, snapshot);
  await commitSnapshot(context, snapshot);
};

const pruneRetiredWindowSnapshots = async (
  context: ModuleAlarmContext,
  cutoff: number,
  limit: number,
): Promise<void> => {
  if (context.storage.list === undefined) return;
  const savedCursor = await context.storage.get(WINDOW_SNAPSHOT_PRUNE_CURSOR_KEY);
  const cursor = typeof savedCursor === "string" ? savedCursor : undefined;
  const snapshots = await context.storage.list("last:", limit, cursor);
  const keys = [...snapshots.keys()];
  for (const key of keys) {
    const windowStartMs = Number(key.slice("last:".length));
    if (!/^last:\d+$/u.test(key) || !Number.isSafeInteger(windowStartMs) || windowStartMs >= cutoff) continue;
    const windowStart = new Date(windowStartMs).toISOString();
    const pending = snapshotFrom(await context.storage.get(pendingSnapshotKey(windowStart)));
    if (pending === null) await context.storage.delete(key);
  }
  const nextCursor = keys.at(-1);
  if (keys.length === limit && nextCursor !== undefined) {
    await context.storage.put(WINDOW_SNAPSHOT_PRUNE_CURSOR_KEY, nextCursor);
  } else {
    await context.storage.delete(WINDOW_SNAPSHOT_PRUNE_CURSOR_KEY);
  }
};

const reconcileDirtyStatisticsWindows = async (
  context: ModuleAlarmContext,
  beforeWindowStart: number,
  fallbackStreamId: string | null,
): Promise<void> => {
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");
  let reconciled = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dirtyWindows = await context.statisticsChat.listDirtyWindowsBefore(
      new Date(beforeWindowStart).toISOString(),
      24,
    );
    if (dirtyWindows.length === 0) {
      reconciled = true;
      break;
    }
    for (const dirtyWindow of dirtyWindows) {
      const carry = snapshotFrom(await context.storage.get(lastFlushKey(dirtyWindow)));
      const dirtyStartMs = Date.parse(dirtyWindow);
      await flushWindow(context, {
        streamId: carry?.streamId ?? fallbackStreamId,
        streamStartedAt: null,
        windowStart: dirtyWindow,
        windowEnd: carry?.windowEnd ?? new Date(dirtyStartMs + STATISTICS_WINDOW_MILLISECONDS).toISOString(),
        shouldFetchLiveMetrics: false,
      });
    }
  }
  if (!reconciled) throw new Error("Statistics late-window reconciliation did not quiesce.");
  const retiredBefore = Date.now() - 20 * 60 * 1_000;
  await context.statisticsChat.pruneRetiredWindowsBefore(new Date(retiredBefore).toISOString(), 100);
  await pruneRetiredWindowSnapshots(context, retiredBefore, 100);
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
    : statisticsWindowStartMs(scheduledDeadline) - STATISTICS_WINDOW_MILLISECONDS;
  if (firstWindowStart !== null) {
    await context.scheduleAlarm(
      "window",
      offlineFlushAlarmKey(
        session?.streamId ?? null,
        session?.startedAt ?? null,
        firstWindowStart,
        endedAt,
        context.streamStateTransitionGeneration ?? 0,
      ),
      Date.now(),
      undefined,
      null,
    );
  }
  await context.clearAlarm("window", undefined, context.streamStateTransitionGeneration);
  return emptyResult();
};

export const reconcileStatisticsSchedule = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (reason !== "stream_state") return;
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at, transition_generation FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const generation = stream?.transition_generation ?? 0;
  if (stream?.state !== "online" || stream.started_at === null) {
    await context.clear("window", undefined, generation);
    return;
  }
  const [deadline, plan] = await Promise.all([
    context.getAlarmDeadline?.("window") ?? Promise.resolve(null),
    context.getAlarmPlan?.("window") ?? Promise.resolve(null),
  ]);
  if (deadline !== null && plan?.streamGeneration === generation) return;
  const streamStart = Date.parse(stream.started_at);
  if (!Number.isFinite(streamStart)) return;
  await context.schedule(
    "window",
    statisticsWindowStartMs(streamStart) + STATISTICS_WINDOW_MILLISECONDS,
    undefined,
    generation,
  );
};

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  const offlineFlush = offlineFlushFromAlarmKey(alarmKey);
  if (offlineFlush !== null) {
    for (let windowStart = offlineFlush.firstWindowStart; windowStart < offlineFlush.endedAt;
      windowStart += STATISTICS_WINDOW_MILLISECONDS) {
      const windowEnd = Math.min(windowStart + STATISTICS_WINDOW_MILLISECONDS, offlineFlush.endedAt);
      await flushWindow(context, {
        streamId: offlineFlush.streamId,
        streamStartedAt: offlineFlush.streamStartedAt,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
        shouldFetchLiveMetrics: false,
      });
    }
    await reconcileDirtyStatisticsWindows(context, offlineFlush.endedAt, offlineFlush.streamId);
    const stream = await context.DB.prepare(
      "SELECT state, transition_generation FROM channel_stream_state WHERE channel_id = ?",
    ).bind(context.channelId).first<{ state: string; transition_generation: number }>();
    if (stream?.state === "offline" && stream.transition_generation === offlineFlush.transitionGeneration) {
      await context.statisticsChat?.clearWindowChattersThrough(new Date(offlineFlush.endedAt).toISOString());
    }
    return;
  }

  if (alarmKey !== "window") return;
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at, transition_generation FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  if (stream?.state !== "online" || stream.started_at === null ||
      context.streamGeneration !== undefined && stream.transition_generation !== context.streamGeneration) {
    await context.clear("window", undefined, context.streamGeneration);
    return;
  }

  const streamStart = Date.parse(stream.started_at);
  if (!Number.isFinite(streamStart) || deadline <= streamStart) {
    await context.clear("window", undefined, context.streamGeneration);
    return;
  }
  await flushWindow(context, {
    streamId: stream.stream_id,
    streamStartedAt: stream.started_at,
    windowStart: new Date(deadline - STATISTICS_WINDOW_MILLISECONDS).toISOString(),
    windowEnd: new Date(deadline).toISOString(),
    shouldFetchLiveMetrics: true,
  });
  const windowStart = deadline - STATISTICS_WINDOW_MILLISECONDS;
  await reconcileDirtyStatisticsWindows(context, windowStart, stream.stream_id);
  await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS, undefined, context.streamGeneration);
};
