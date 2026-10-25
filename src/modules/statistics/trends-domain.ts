import type {
  StatisticsStreamWindow,
  StatisticsTimelineEvent,
  StatisticsTrendCategory,
  StatisticsTrendHeatmapCell,
  StatisticsTrendKpis,
  StatisticsTrendWeek,
  StatisticsTrendsResponse,
  StatisticsTrendsWeeks,
} from "./contracts";
import { compareStatisticsInstants, groupStatisticsWindows, statisticsMetadataValues } from "./streams-domain";

const WINDOW_MILLISECONDS = 5 * 60_000;
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60_000;

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

interface CategoryAccumulator {
  streamIds: Set<string>;
  milliseconds: number;
  viewerTotal: number;
  viewerMilliseconds: number;
  messages: number;
}

const dateFormatter = (timeZone: string): Intl.DateTimeFormat => new Intl.DateTimeFormat("en-US", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

const localDateParts = (instant: number, formatter: Intl.DateTimeFormat): LocalDateParts => {
  const parts = new Map(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
  };
};

const mondayForLocalDate = (parts: LocalDateParts): number => {
  const date = Date.UTC(parts.year, parts.month - 1, parts.day);
  const weekday = new Date(date).getUTCDay();
  return date - ((weekday + 6) % 7) * 24 * 60 * 60_000;
};

const mondayKeyForLocalDate = (parts: LocalDateParts): string =>
  new Date(mondayForLocalDate(parts)).toISOString().slice(0, 10);

const isoWeekNumber = (monday: number): number => {
  const thursday = monday + 3 * 24 * 60 * 60_000;
  const weekYear = new Date(thursday).getUTCFullYear();
  const januaryFourth = Date.UTC(weekYear, 0, 4);
  const januaryFourthDay = new Date(januaryFourth).getUTCDay();
  const firstMonday = januaryFourth - ((januaryFourthDay + 6) % 7) * 24 * 60 * 60_000;
  return Math.floor((monday - firstMonday) / WEEK_MILLISECONDS) + 1;
};

const makeWeeklyBuckets = (
  rangeStart: number,
  rangeEnd: number,
  formatter: Intl.DateTimeFormat,
): StatisticsTrendWeek[] => {
  const firstMonday = mondayForLocalDate(localDateParts(rangeStart, formatter));
  const lastMonday = mondayForLocalDate(localDateParts(rangeEnd - 1, formatter));
  const weeks: StatisticsTrendWeek[] = [];
  for (let monday = firstMonday; monday <= lastMonday; monday += WEEK_MILLISECONDS) {
    const weekStartDate = new Date(monday);
    weeks.push({
      weekStart: `${String(weekStartDate.getUTCFullYear()).padStart(4, "0")}-${String(weekStartDate.getUTCMonth() + 1).padStart(2, "0")}-${String(weekStartDate.getUTCDate()).padStart(2, "0")}`,
      isoWeek: isoWeekNumber(monday),
      averageViewers: null,
      streamHours: 0,
    });
  }
  return weeks;
};

const observedAverage = (values: readonly (number | null)[]): number | null => {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === 0 ? null : observed.reduce((sum, value) => sum + value, 0) / observed.length;
};

const periodWindows = (
  windows: readonly StatisticsStreamWindow[],
  start: string,
  end: string,
): StatisticsStreamWindow[] => windows.filter((window) => window.streamId !== null &&
  compareStatisticsInstants(window.windowStart, start) >= 0 && compareStatisticsInstants(window.windowStart, end) < 0)
  .sort((left, right) => compareStatisticsInstants(left.windowStart, right.windowStart));

const kpisFor = (windows: readonly StatisticsStreamWindow[], streamCount: number): StatisticsTrendKpis => ({
  streams: streamCount,
  streamHours: windows.length * WINDOW_MILLISECONDS / 3_600_000,
  averageViewers: observedAverage(windows.map(({ viewerCount }) => viewerCount)),
  messagesPerMinute: windows.length === 0
    ? null
    : windows.reduce((sum, window) => sum + window.messages, 0) / (windows.length * WINDOW_MILLISECONDS / 60_000),
});

const weeklyFor = (
  windows: readonly StatisticsStreamWindow[],
  rangeStart: number,
  rangeEnd: number,
  formatter: Intl.DateTimeFormat,
): StatisticsTrendWeek[] => {
  const weeks = makeWeeklyBuckets(rangeStart, rangeEnd, formatter);
  const buckets = new Map(weeks.map((week) => [week.weekStart, { viewers: [] as (number | null)[], count: 0 }]));
  for (const window of windows) {
    const bucket = buckets.get(mondayKeyForLocalDate(localDateParts(Date.parse(window.windowStart), formatter)));
    if (bucket === undefined) continue;
    bucket.viewers.push(window.viewerCount);
    bucket.count += 1;
  }
  return weeks.map((week) => {
    const bucket = buckets.get(week.weekStart);
    return bucket === undefined || bucket.count === 0 ? week : {
      ...week,
      averageViewers: observedAverage(bucket.viewers),
      streamHours: bucket.count * WINDOW_MILLISECONDS / 3_600_000,
    };
  });
};

const heatmapFor = (
  summaries: ReturnType<typeof groupStatisticsWindows>,
  formatter: Intl.DateTimeFormat,
): StatisticsTrendHeatmapCell[] => {
  const buckets = new Map<string, { weekday: number; hour: number; viewers: number[]; streams: number }>();
  for (const summary of summaries) {
    const parts = localDateParts(Date.parse(summary.startedAt), formatter);
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekday = (date.getUTCDay() + 6) % 7;
    const key = `${String(weekday)}:${String(parts.hour)}`;
    const bucket = buckets.get(key) ?? { weekday, hour: parts.hour, viewers: [], streams: 0 };
    if (summary.averageViewers !== null) bucket.viewers.push(summary.averageViewers);
    bucket.streams += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => left.weekday - right.weekday || left.hour - right.hour)
    .map(({ weekday, hour, viewers, streams }) => ({ weekday, hour, averageViewers: observedAverage(viewers), streams }));
};

const categoriesFor = (
  windows: readonly StatisticsStreamWindow[],
  timeline: readonly StatisticsTimelineEvent[],
  rangeEnd: number,
): StatisticsTrendCategory[] => {
  const metadata = timeline.filter(({ kind }) => kind === "channel_metadata")
    .sort((left, right) => compareStatisticsInstants(left.occurredAt, right.occurredAt));
  const accumulators = new Map<string, CategoryAccumulator>();
  let metadataIndex = 0;
  let activeCategory: string | null = null;

  for (const window of windows) {
    const windowStart = Date.parse(window.windowStart);
    const windowEnd = Math.min(windowStart + WINDOW_MILLISECONDS, rangeEnd);
    while (metadataIndex < metadata.length && compareStatisticsInstants(metadata[metadataIndex]?.occurredAt ?? "", window.windowStart) <= 0) {
      activeCategory = statisticsMetadataValues(metadata[metadataIndex] as StatisticsTimelineEvent).category;
      metadataIndex += 1;
    }
    let segmentStart = windowStart;
    while (metadataIndex < metadata.length) {
      const event = metadata[metadataIndex];
      if (event === undefined || compareStatisticsInstants(event.occurredAt, new Date(windowEnd).toISOString()) >= 0) break;
      const eventAt = Math.max(segmentStart, Date.parse(event.occurredAt));
      if (activeCategory !== null && eventAt > segmentStart) {
        addCategorySegment(accumulators, activeCategory, window, eventAt - segmentStart);
      }
      segmentStart = eventAt;
      activeCategory = statisticsMetadataValues(event).category;
      metadataIndex += 1;
    }
    if (activeCategory !== null && windowEnd > segmentStart) {
      addCategorySegment(accumulators, activeCategory, window, windowEnd - segmentStart);
    }
  }

  return [...accumulators.entries()].map(([name, accumulator]) => ({
    name,
    streams: accumulator.streamIds.size,
    streamHours: accumulator.milliseconds / 3_600_000,
    averageViewers: accumulator.viewerMilliseconds === 0 ? null : accumulator.viewerTotal / accumulator.viewerMilliseconds,
    messagesPerMinute: accumulator.milliseconds === 0 ? null : accumulator.messages / (accumulator.milliseconds / 60_000),
  })).sort((left, right) => left.name.localeCompare(right.name));
};

const addCategorySegment = (
  accumulators: Map<string, CategoryAccumulator>,
  name: string,
  window: StatisticsStreamWindow,
  milliseconds: number,
): void => {
  const streamId = window.streamId;
  if (streamId === null || milliseconds <= 0) return;
  const accumulator = accumulators.get(name) ?? {
    streamIds: new Set<string>(), milliseconds: 0, viewerTotal: 0, viewerMilliseconds: 0, messages: 0,
  };
  accumulator.streamIds.add(streamId);
  accumulator.milliseconds += milliseconds;
  accumulator.messages += window.messages * milliseconds / WINDOW_MILLISECONDS;
  if (window.viewerCount !== null) {
    accumulator.viewerTotal += window.viewerCount * milliseconds;
    accumulator.viewerMilliseconds += milliseconds;
  }
  accumulators.set(name, accumulator);
};

/** Aggregates window-backed stream trends and assigns calendar buckets in the channel time zone. */
export const deriveStatisticsTrends = (
  windows: readonly StatisticsStreamWindow[],
  timeline: readonly StatisticsTimelineEvent[],
  input: { weeks: StatisticsTrendsWeeks; now: string; timeZone: string },
): StatisticsTrendsResponse => {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new RangeError("Invalid statistics trends end time.");
  const rangeMilliseconds = input.weeks * 7 * 24 * 60 * 60_000;
  const currentStart = now - rangeMilliseconds;
  const previousStart = now - 2 * rangeMilliseconds;
  const start = new Date(currentStart).toISOString();
  const end = new Date(now).toISOString();
  const previousRangeStart = new Date(previousStart).toISOString();
  const formatter = dateFormatter(input.timeZone);
  const currentWindows = periodWindows(windows, start, end);
  const previousWindows = periodWindows(windows, previousRangeStart, start);
  const summaries = groupStatisticsWindows(currentWindows, timeline);
  const previousSummaries = groupStatisticsWindows(previousWindows, timeline);

  return {
    weeks: input.weeks,
    timeZone: input.timeZone,
    range: { start, end },
    previousRange: { start: previousRangeStart, end: start },
    kpis: kpisFor(currentWindows, summaries.length),
    previousKpis: kpisFor(previousWindows, previousSummaries.length),
    weekly: weeklyFor(currentWindows, currentStart, now, formatter),
    heatmap: heatmapFor(summaries, formatter),
    categories: categoriesFor(currentWindows, timeline, now),
  };
};
