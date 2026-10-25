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

const eventInRange = (event: StatisticsTimelineEvent, start: string, end: string): boolean =>
  event.occurredAt >= start && event.occurredAt < end;

const compareNewestFirst = (left: StatisticsStreamSummary, right: StatisticsStreamSummary): number =>
  (right.cursorAt ?? right.endedAt).localeCompare(left.cursorAt ?? left.endedAt) || right.streamId.localeCompare(left.streamId);

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
    const startedAt = ordered[0]?.windowStart ?? "";
    const lastWindowStart = ordered.at(-1)?.windowStart ?? startedAt;
    const endedAt = new Date(Date.parse(lastWindowStart) + WINDOW_MILLISECONDS).toISOString();
    const inRangeMetadata = timelineEvents
      .filter((event) => event.kind === "channel_metadata" && eventInRange(event, startedAt, endedAt))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const latestMetadata = inRangeMetadata.at(-1);
    const cursorAt = timelineEvents
      .filter((event) => event.kind === "stream_online" && event.streamId === streamId && eventInRange(event, startedAt, endedAt))
      .at(-1)?.occurredAt;
    const categories = [...new Set(inRangeMetadata.flatMap((event) => {
      const category = metadataValues(event).category;
      return category === null ? [] : [category];
    }))];
    const viewers = ordered.filter((row) => row.viewerCount !== null);
    const peak = viewers.reduce<StatisticsStreamWindow | null>((best, row) =>
      best === null || (row.viewerCount ?? -1) > (best.viewerCount ?? -1) ? row : best, null);

    return {
      streamId,
      startedAt,
      endedAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000)),
      title: latestMetadata === undefined ? null : metadataValues(latestMetadata).title,
      categories,
      averageViewers: average(ordered.map((row) => row.viewerCount)),
      peakViewers: peak?.viewerCount ?? null,
      peakAt: peak?.windowStart ?? null,
      messages: ordered.reduce((sum, row) => sum + row.messages, 0),
      averageActiveChatters: average(ordered.map((row) => row.activeChatters)),
      clips: timelineEvents.filter((event) => event.kind === "clip_created" && eventInRange(event, startedAt, endedAt)).length,
      ...(cursorAt === undefined ? {} : { cursorAt }),
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
    return cursorAt < parsedCursor.cursorAt || (cursorAt === parsedCursor.cursorAt && summary.streamId < parsedCursor.streamId);
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
  const ordered = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
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
): StatisticsStreamEvent[] => {
  const ordered = [...timelineEvents].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const pairs = dropPairs(ordered);
  const pairedOnline = new Set(pairs.values());
  const result: StatisticsStreamEvent[] = [];
  let metadataBefore: { title: string | null; category: string | null } | null = null;

  ordered.forEach((event, index) => {
    const inRange = eventInRange(event, startedAt, endedAt);
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
      if (!pairedOnline.has(index)) result.push({ id: `start:${event.occurredAt}:${String(index)}`, type: "start", at: event.occurredAt });
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

  return result.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
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
