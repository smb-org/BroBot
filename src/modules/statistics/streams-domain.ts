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

export const statisticsMetadataValues = (event: StatisticsTimelineEvent): { title: string | null; category: string | null } => {
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

export const compareStatisticsInstants = (left: string, right: string): number => {
  const leftInstant = instantNanoseconds(left);
  const rightInstant = instantNanoseconds(right);
  if (leftInstant !== null && rightInstant !== null) return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
  return left.localeCompare(right);
};

const eventInRange = (event: StatisticsTimelineEvent, start: string, end: string): boolean =>
  compareStatisticsInstants(event.occurredAt, start) >= 0 && compareStatisticsInstants(event.occurredAt, end) <= 0;

const compareNewestFirst = (left: StatisticsStreamSummary, right: StatisticsStreamSummary): number =>
  compareStatisticsInstants(right.cursorAt ?? right.endedAt, left.cursorAt ?? left.endedAt) || right.streamId.localeCompare(left.streamId);

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
    const startedAt = windowStart;
    const endedAt = windowEnd;
    const metadataEvents = timelineEvents
      .filter((event) => event.kind === "channel_metadata")
      .sort((left, right) => compareStatisticsInstants(left.occurredAt, right.occurredAt));
    const metadataBefore = metadataEvents.filter((event) => compareStatisticsInstants(event.occurredAt, startedAt) < 0).at(-1);
    const inRangeMetadata = metadataEvents.filter((event) => eventInRange(event, startedAt, endedAt));
    const observedMetadata = [...(metadataBefore === undefined ? [] : [metadataBefore]), ...inRangeMetadata];
    const latestMetadata = observedMetadata.at(-1);
    const categories = [...new Set(observedMetadata.flatMap((event) => {
      const category = statisticsMetadataValues(event).category;
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
      title: latestMetadata === undefined ? null : statisticsMetadataValues(latestMetadata).title,
      categories,
      averageViewers: average(ordered.map((row) => row.viewerCount)),
      peakViewers: peak?.viewerCount ?? null,
      peakAt: peak?.windowStart ?? null,
      messages: ordered.reduce((sum, row) => sum + row.messages, 0),
      averageActiveChatters: average(ordered.map((row) => row.activeChatters)),
      clips: timelineEvents.filter((event) => event.kind === "clip_created" && eventInRange(event, startedAt, endedAt)).length,
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
    const comparison = compareStatisticsInstants(cursorAt, parsedCursor.cursorAt);
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
  const ordered = [...events].sort((left, right) => compareStatisticsInstants(left.occurredAt, right.occurredAt));
  const usedOnline = new Set<number>();
  const pairs = new Map<number, number>();
  ordered.forEach((event, offlineIndex) => {
    if (event.kind !== "stream_offline") return;
    // Nanosecond resolution: ten minutes and one nanosecond is not a drop.
    const offlineTime = instantNanoseconds(event.occurredAt);
    if (offlineTime === null) return;
    const dropWindow = BigInt(DROP_WINDOW_MILLISECONDS) * 1_000_000n;
    const onlineIndex = ordered.findIndex((candidate, candidateIndex) => {
      if (candidateIndex <= offlineIndex || usedOnline.has(candidateIndex) || candidate.kind !== "stream_online") return false;
      const onlineTime = instantNanoseconds(candidate.occurredAt);
      return onlineTime !== null && onlineTime >= offlineTime && onlineTime - offlineTime <= dropWindow;
    });
    if (onlineIndex < 0) return;
    pairs.set(offlineIndex, onlineIndex);
    usedOnline.add(onlineIndex);
  });
  return pairs;
};

/** Turns timeline facts inside the window range into user-facing events. */
export const deriveStreamEvents = (
  timelineEvents: readonly StatisticsTimelineEvent[],
  startedAt: string,
  endedAt: string,
  windows: readonly StatisticsStreamWindow[] = [],
): StatisticsStreamEvent[] => {
  const ordered = [...timelineEvents].sort((left, right) => compareStatisticsInstants(left.occurredAt, right.occurredAt));
  const metadataSeed = ordered.findLast((event) => event.kind === "channel_metadata" && compareStatisticsInstants(event.occurredAt, startedAt) < 0);
  let metadataBefore = metadataSeed === undefined ? null : statisticsMetadataValues(metadataSeed);
  const windowStarts = new Set(windows.map(({ windowStart }) => Date.parse(windowStart)).filter(Number.isFinite));
  const inRangeEvents = ordered.filter((event) => {
    if (!eventInRange(event, startedAt, endedAt)) return false;
    if (event.kind !== "emote_spike") return true;
    const windowStart = event.detail.windowStart;
    return typeof windowStart === "string" && windowStarts.has(Date.parse(windowStart));
  });
  const pairs = dropPairs(inRangeEvents);
  const pairedOnline = new Set(pairs.values());
  const result: StatisticsStreamEvent[] = [];

  inRangeEvents.forEach((event, index) => {
    if (event.kind === "channel_metadata") {
      const current = statisticsMetadataValues(event);
      if (metadataBefore !== null && (current.title !== metadataBefore.title || current.category !== metadataBefore.category)) {
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
      const pairedOnlineIndex = pairs.get(index);
      if (pairedOnlineIndex !== undefined) {
        const recoveredAt = inRangeEvents[pairedOnlineIndex]?.occurredAt;
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
    } else if (event.kind === "raid_incoming" || event.kind === "raid_outgoing") {
      const detail = record(event.detail) ?? {};
      const partner = record(detail.partner) ?? {};
      const partnerName = text(partner.displayName) ?? text(partner.login);
      result.push({
        id: `raid:${event.kind}:${event.occurredAt}:${String(index)}`,
        type: event.kind === "raid_incoming" ? "raidIncoming" : "raidOutgoing",
        at: event.occurredAt,
        ...(partnerName === null ? {} : { partnerName }),
        ...(typeof detail.viewers === "number" ? { raidViewers: detail.viewers } : {}),
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

  return result.sort((left, right) => compareStatisticsInstants(left.at, right.at) || left.id.localeCompare(right.id));
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
