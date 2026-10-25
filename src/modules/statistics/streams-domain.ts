import type {
  StatisticsBitrateWindow,
  StatisticsStreamEvent,
  StatisticsStreamSummary,
  StatisticsStreamWindow,
  StatisticsTimelineEvent,
} from "./contracts";

const WINDOW_MILLISECONDS = 5 * 60_000;
const DROP_WINDOW_MILLISECONDS = 10 * 60_000;

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const metadataValues = (event: StatisticsTimelineEvent): { title: string | null; category: string | null } => {
  const detail = record(event.detail) ?? {};
  const category = record(detail.category);
  return { title: text(detail.title), category: text(category?.name) };
};

const average = (values: readonly (number | null)[]): number | null => {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === 0 ? null : observed.reduce((sum, value) => sum + value, 0) / observed.length;
};

const instantNanoseconds = (value: string): bigint | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) return null;
  const milliseconds = Date.parse(`${match[1] ?? ""}${match[3] ?? ""}`);
  if (!Number.isFinite(milliseconds)) return null;
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
};

const compareInstants = (left: string, right: string): number => {
  const leftInstant = instantNanoseconds(left);
  const rightInstant = instantNanoseconds(right);
  if (leftInstant !== null && rightInstant !== null) return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
  return left.localeCompare(right);
};

const eventInRange = (event: StatisticsTimelineEvent, start: string, end: string): boolean =>
  compareInstants(event.occurredAt, start) >= 0 && compareInstants(event.occurredAt, end) < 0;

interface StreamLifecycleRange {
  startedAt: string;
  endedAt: string;
  endingKind: "stream_offline" | "stream_online" | null;
}

const streamLifecycleRange = (
  timelineEvents: readonly StatisticsTimelineEvent[],
  streamId: string | undefined,
  windowStart: string,
  windowEnd: string,
): StreamLifecycleRange => {
  if (streamId === undefined) return { startedAt: windowStart, endedAt: windowEnd, endingKind: null };
  const ordered = [...timelineEvents].sort((left, right) => compareInstants(left.occurredAt, right.occurredAt));
  const isOwnOnline = (event: StatisticsTimelineEvent): boolean => event.kind === "stream_online" && event.streamId === streamId;
  const online = ordered.find(isOwnOnline);
  if (online === undefined) return { startedAt: windowStart, endedAt: windowEnd, endingKind: null };
  // Reconnects reuse the stream id, so the interval ends at the first lifecycle event after the last own start.
  const lastOnlineIndex = ordered.findLastIndex(isOwnOnline);
  const nextLifecycle = ordered.find((event, index) => index > lastOnlineIndex &&
    (event.kind === "stream_offline" || event.kind === "stream_online"));
  if (nextLifecycle === undefined) return { startedAt: online.occurredAt, endedAt: windowEnd, endingKind: null };
  // The last window may close after the offline notice; events inside it still belong to the stream.
  const endsWithOffline = nextLifecycle.kind === "stream_offline";
  const endedAt = endsWithOffline && compareInstants(nextLifecycle.occurredAt, windowEnd) < 0 ? windowEnd : nextLifecycle.occurredAt;
  return { startedAt: online.occurredAt, endedAt, endingKind: endsWithOffline ? "stream_offline" : "stream_online" };
};

const eventInLifecycleRange = (event: StatisticsTimelineEvent, range: StreamLifecycleRange): boolean =>
  eventInRange(event, range.startedAt, range.endedAt) ||
  (event.kind === "stream_offline" && range.endingKind === "stream_offline" && compareInstants(event.occurredAt, range.endedAt) === 0);

const compareNewestFirst = (left: StatisticsStreamSummary, right: StatisticsStreamSummary): number =>
  compareInstants(right.cursorAt ?? right.endedAt, left.cursorAt ?? left.endedAt) || right.streamId.localeCompare(left.streamId);

interface StreamCursor {
  cursorAt: string;
  streamId: string;
}

export const encodeStreamCursor = (cursor: StreamCursor): string =>
  btoa(JSON.stringify({ v: 1, ...cursor })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const decodeStreamCursor = (value: string): StreamCursor | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded: unknown = JSON.parse(atob(base64));
    const candidate = record(decoded);
    if (candidate?.v !== 1 || typeof candidate.cursorAt !== "string" || !Number.isFinite(Date.parse(candidate.cursorAt)) ||
        typeof candidate.streamId !== "string" || candidate.streamId.length === 0 || candidate.streamId.length > 128) return null;
    return { cursorAt: candidate.cursorAt, streamId: candidate.streamId };
  } catch {
    return null;
  }
};

/** Groups five-minute rows without retaining any message or person-level data. */
export const groupStatisticsWindows = (
  windows: readonly StatisticsStreamWindow[],
  timelineEvents: readonly StatisticsTimelineEvent[],
): StatisticsStreamSummary[] => {
  const groups = new Map<string, StatisticsStreamWindow[]>();
  for (const window of windows) {
    if (window.streamId === null) continue;
    const group = groups.get(window.streamId) ?? [];
    group.push(window);
    groups.set(window.streamId, group);
  }

  const summaries = [...groups.entries()].map(([streamId, rows]): StatisticsStreamSummary => {
    const ordered = [...rows].sort((left, right) => left.windowStart.localeCompare(right.windowStart));
    const windowStart = ordered[0]?.windowStart ?? "";
    const lastWindowStart = ordered.at(-1)?.windowStart ?? windowStart;
    const windowEnd = new Date(Date.parse(lastWindowStart) + WINDOW_MILLISECONDS).toISOString();
    const lifecycle = streamLifecycleRange(timelineEvents, streamId, windowStart, windowEnd);
    const { startedAt, endedAt } = lifecycle;
    const displayEnd = lifecycle.endingKind === "stream_online" ? windowEnd : endedAt;
    const metadataEvents = timelineEvents
      .filter((event) => event.kind === "channel_metadata")
      .sort((left, right) => compareInstants(left.occurredAt, right.occurredAt));
    const metadataBefore = metadataEvents.filter((event) => compareInstants(event.occurredAt, startedAt) < 0).at(-1);
    const inRangeMetadata = metadataEvents.filter((event) => eventInRange(event, startedAt, endedAt));
    const observedMetadata = [...(metadataBefore === undefined ? [] : [metadataBefore]), ...inRangeMetadata];
    const latestMetadata = observedMetadata.at(-1);
    const categories = [...new Set(observedMetadata.flatMap((event) => {
      const category = metadataValues(event).category;
      return category === null ? [] : [category];
    }))];
    const viewers = ordered.filter((row) => row.viewerCount !== null);
    const peak = viewers.reduce<StatisticsStreamWindow | null>((best, row) =>
      best === null || (row.viewerCount ?? -1) > (best.viewerCount ?? -1) ? row : best, null);

    return {
      streamId,
      startedAt,
      // A stream without an offline notice runs to its last window, not to the next stream's start.
      endedAt: displayEnd,
      durationSeconds: Math.max(0, Math.round((Date.parse(displayEnd) - Date.parse(startedAt)) / 1_000)),
      title: latestMetadata === undefined ? null : metadataValues(latestMetadata).title,
      categories,
      averageViewers: average(ordered.map((row) => row.viewerCount)),
      peakViewers: peak?.viewerCount ?? null,
      peakAt: peak?.windowStart ?? null,
      messages: ordered.reduce((sum, row) => sum + row.messages, 0),
      averageActiveChatters: average(ordered.map((row) => row.activeChatters)),
      clips: timelineEvents.filter((event) => event.kind === "clip_created" && eventInLifecycleRange(event, lifecycle)).length,
      cursorAt: lastWindowStart,
    };
  });

  return summaries.sort(compareNewestFirst);
};

export const paginateStreamSummaries = (
  summaries: readonly StatisticsStreamSummary[],
  cursor: string | null,
  limit: number,
): { streams: StatisticsStreamSummary[]; nextCursor: string | null } => {
  const parsedCursor = cursor === null ? null : decodeStreamCursor(cursor);
  if (cursor !== null && parsedCursor === null) throw new RangeError("Invalid statistics stream cursor.");
  const ordered = [...summaries].sort(compareNewestFirst).filter((summary) => {
    if (parsedCursor === null) return true;
    const cursorAt = summary.cursorAt ?? summary.endedAt;
    const comparison = compareInstants(cursorAt, parsedCursor.cursorAt);
    return comparison < 0 || (comparison === 0 && summary.streamId < parsedCursor.streamId);
  });
  const streams = ordered.slice(0, limit);
  const hasMore = ordered.length > limit;
  const last = streams.at(-1);
  return {
    streams,
    nextCursor: !hasMore || last === undefined ? null : encodeStreamCursor({ cursorAt: last.cursorAt ?? last.endedAt, streamId: last.streamId }),
  };
};

const dropPairs = (events: readonly StatisticsTimelineEvent[]): Map<number, number> => {
  const ordered = [...events].sort((left, right) => compareInstants(left.occurredAt, right.occurredAt));
  const usedOnline = new Set<number>();
  const pairs = new Map<number, number>();
  ordered.forEach((event, offlineIndex) => {
    if (event.kind !== "stream_offline") return;
    const offlineTime = Date.parse(event.occurredAt);
    const onlineIndex = ordered.findIndex((candidate, candidateIndex) => candidateIndex > offlineIndex &&
      !usedOnline.has(candidateIndex) && candidate.kind === "stream_online" &&
      Date.parse(candidate.occurredAt) >= offlineTime && Date.parse(candidate.occurredAt) - offlineTime <= DROP_WINDOW_MILLISECONDS);
    if (onlineIndex < 0) return;
    pairs.set(offlineIndex, onlineIndex);
    usedOnline.add(onlineIndex);
  });
  return pairs;
};

/** Turns raw timeline facts into user-facing events; lifecycle drops use the documented ten-minute rule. */
export const deriveStreamEvents = (
  timelineEvents: readonly StatisticsTimelineEvent[],
  startedAt: string,
  endedAt: string,
  streamId?: string,
): StatisticsStreamEvent[] => {
  const ordered = [...timelineEvents].sort((left, right) => compareInstants(left.occurredAt, right.occurredAt));
  const pairs = dropPairs(ordered);
  const pairedOnline = new Set(pairs.values());
  const result: StatisticsStreamEvent[] = [];
  let metadataBefore: { title: string | null; category: string | null } | null = null;
  const range = streamLifecycleRange(ordered, streamId, startedAt, endedAt);

  ordered.forEach((event, index) => {
    const inRange = eventInLifecycleRange(event, range);
    if (event.kind === "channel_metadata") {
      const current = metadataValues(event);
      if (inRange && metadataBefore !== null && (current.title !== metadataBefore.title || current.category !== metadataBefore.category)) {
        const transitionText = current.title ?? current.category;
        result.push({
          id: `metadata:${event.occurredAt}:${String(index)}`,
          type: "metadata",
          at: event.occurredAt,
          title: current.title,
          oldTitle: metadataBefore.title,
          category: current.category,
          oldCategory: metadataBefore.category,
          ...(transitionText === null ? {} : { text: transitionText }),
        });
      }
      metadataBefore = current;
      return;
    }
    if (event.kind === "stream_offline") {
      if (!inRange) return;
      const pairedOnlineIndex = pairs.get(index);
      if (pairedOnlineIndex !== undefined) {
        const recoveredAt = ordered[pairedOnlineIndex]?.occurredAt;
        if (recoveredAt !== undefined) {
          result.push({
            id: `drop:${event.occurredAt}:${String(index)}`,
            type: "drop",
            at: event.occurredAt,
            recoveredAt,
            durationSeconds: Math.round((Date.parse(recoveredAt) - Date.parse(event.occurredAt)) / 1_000),
          });
          return;
        }
      }
      result.push({ id: `offline:${event.occurredAt}:${String(index)}`, type: "offline", at: event.occurredAt });
      return;
    }
    if (!inRange) return;
    if (event.kind === "stream_online") {
      const isStreamStart = streamId !== undefined && event.streamId === streamId && compareInstants(event.occurredAt, range.startedAt) === 0;
      if (!pairedOnline.has(index) || isStreamStart) result.push({ id: `start:${event.occurredAt}:${String(index)}`, type: "start", at: event.occurredAt });
    } else if (event.kind === "clip_created") {
      const detail = record(event.detail) ?? {};
      const clipId = text(detail.clipId);
      const title = text(detail.title);
      result.push({
        id: `clip:${event.occurredAt}:${String(index)}`,
        type: "clip",
        at: event.occurredAt,
        ...(clipId === null ? {} : { clipId }),
        ...(title === null ? {} : { text: title }),
      });
    } else if (event.kind === "ad_break") {
      const detail = record(event.detail) ?? {};
      result.push({
        id: `ad:${event.occurredAt}:${String(index)}`,
        type: "ad",
        at: event.occurredAt,
        ...(typeof detail.durationSeconds === "number" ? { durationSeconds: detail.durationSeconds } : {}),
      });
    } else {
      const detail = record(event.detail) ?? {};
      result.push({
        id: `emote:${event.occurredAt}:${String(index)}`,
        type: "emoteSpike",
        at: event.occurredAt,
        ...(typeof detail.emotes === "number" ? { emotes: detail.emotes } : {}),
      });
    }
  });

  return result.sort((left, right) => compareInstants(left.at, right.at) || left.id.localeCompare(right.id));
};

/** BELABOX stream ids are independent of Twitch ids, so only the UTC range is compared. */
export const matchBitrateWindows = <Window extends StatisticsBitrateWindow>(
  windows: readonly Window[],
  startedAt: string,
  endedAt: string,
): Window[] => {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return windows.filter((window) => window.windowStart >= start && window.windowStart < end)
    .sort((left, right) => left.windowStart - right.windowStart);
};
