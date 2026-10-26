import { describe, expect, it } from "vitest";

import { deriveStatisticsTrends } from "../../src/modules/statistics/trends-domain";
import type { StatisticsStreamWindow, StatisticsTimelineEvent } from "../../src/modules/statistics/contracts";

const window = (
  windowStart: string,
  streamId: string,
  values: Partial<StatisticsStreamWindow> = {},
): StatisticsStreamWindow => ({
  windowStart,
  streamId,
  messages: 10,
  emotes: 0,
  viewerCount: 100,
  chatters: null,
  activeChatters: null,
  ...values,
});

const metadata = (occurredAt: string, category: string | null): StatisticsTimelineEvent => ({
  kind: "channel_metadata",
  occurredAt,
  detail: { category: category === null ? null : { name: category } },
});

describe("statistics trends derivation", () => {
  it("uses Monday-based channel-local ISO weeks and keeps repeated DST hours in the same heatmap cell", () => {
    const trends = deriveStatisticsTrends([
      window("2026-10-25T00:30:00.000Z", "before-fallback", { viewerCount: 40 }),
      window("2026-10-25T01:30:00.000Z", "after-fallback", { viewerCount: 60 }),
      window("2026-10-26T01:30:00.000Z", "monday", { viewerCount: 80 }),
    ], [], { weeks: 4, now: "2026-11-02T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.weekly.map(({ weekStart }) => weekStart)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(trends.weekly.map(({ isoWeek }) => isoWeek)).toEqual([41, 42, 43, 44, 45]);
    expect(trends.heatmap).toEqual([
      expect.objectContaining({ weekday: 0, hour: 2, averageViewers: 80, streams: 1 }),
      expect.objectContaining({ weekday: 6, hour: 2, averageViewers: 50, streams: 2 }),
    ]);
  });

  it("compares equal previous and current periods and ignores NULL viewer samples", () => {
    const trends = deriveStatisticsTrends([
      window("2026-09-20T11:00:00.000Z", "previous", { messages: 30, viewerCount: 100 }),
      window("2026-09-20T11:05:00.000Z", "previous", { messages: 20, viewerCount: null }),
      window("2026-10-27T11:00:00.000Z", "current", { messages: 20, viewerCount: 200 }),
      window("2026-10-27T11:05:00.000Z", "current", { messages: 10, viewerCount: 300 }),
    ], [], { weeks: 4, now: "2026-11-02T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.kpis).toMatchObject({ streams: 1, streamHours: 1 / 6, averageViewers: 250, messagesPerMinute: 3 });
    expect(trends.previousKpis).toMatchObject({ streams: 1, streamHours: 1 / 6, averageViewers: 100, messagesPerMinute: 5 });
    expect(trends.range).toEqual({ start: "2026-10-05T12:00:00.000Z", end: "2026-11-02T12:00:00.000Z" });
    expect(trends.previousRange).toEqual({ start: "2026-09-07T12:00:00.000Z", end: "2026-10-05T12:00:00.000Z" });
  });

  it("splits category metrics at channel metadata changes within a five-minute window", () => {
    const trends = deriveStatisticsTrends([
      window("2026-10-21T10:00:00.000Z", "category-stream", { messages: 10, viewerCount: 100 }),
      window("2026-10-21T10:05:00.000Z", "category-stream", { messages: 20, viewerCount: 200 }),
    ], [
      metadata("2026-10-21T09:59:00.000Z", "Game A"),
      metadata("2026-10-21T10:07:00.000Z", "Game B"),
    ], { weeks: 4, now: "2026-10-25T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.categories).toEqual([
      expect.objectContaining({ name: "Game A", streams: 1, streamHours: 7 / 60, averageViewers: 900 / 7, messagesPerMinute: 18 / 7 }),
      expect.objectContaining({ name: "Game B", streams: 1, streamHours: 3 / 60, averageViewers: 200, messagesPerMinute: 4 }),
    ]);
  });

  it("derives streams, heatmap and categories from the windows and metadata together", () => {
    const trends = deriveStatisticsTrends([
      window("2026-09-24T18:00:00.000Z", "previous-stream", { viewerCount: 70 }),
      window("2026-10-20T18:00:00.000Z", "stream-a", { viewerCount: 100 }),
      window("2026-10-20T18:05:00.000Z", "stream-a", { viewerCount: 200 }),
      window("2026-10-22T19:00:00.000Z", "stream-b", { viewerCount: 50 }),
    ], [
      metadata("2026-09-20T09:00:00.000Z", "Game C"),
      metadata("2026-10-20T17:00:00.000Z", "Game A"),
      metadata("2026-10-22T19:02:00.000Z", "Game B"),
    ], { weeks: 4, now: "2026-10-25T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.kpis).toMatchObject({ streams: 2, streamHours: 0.25, averageViewers: 350 / 3 });
    expect(trends.previousKpis).toMatchObject({ streams: 1, averageViewers: 70 });
    expect(trends.heatmap).toEqual([
      { weekday: 1, hour: 20, averageViewers: 150, streams: 1 },
      { weekday: 3, hour: 21, averageViewers: 50, streams: 1 },
    ]);
    expect(trends.categories).toEqual([
      expect.objectContaining({ name: "Game A", streams: 2, streamHours: 12 / 60 }),
      expect.objectContaining({ name: "Game B", streams: 1, streamHours: 3 / 60 }),
    ]);
  });

  it("stays fast on a year of streams with a long metadata history", () => {
    const start = Date.parse("2025-11-01T18:00:00.000Z");
    const windows = Array.from({ length: 300 }, (_, stream) => Array.from({ length: 40 }, (_unused, index) =>
      window(new Date(start + stream * 30 * 3_600_000 + index * 300_000).toISOString(), `stream-${String(stream)}`)),
    ).flat();
    const timeline = Array.from({ length: 6_000 }, (_, index) =>
      metadata(new Date(start - 86_400_000 + index * 3_600_000).toISOString(), `Game ${String(index % 20)}`));
    const began = performance.now();

    const trends = deriveStatisticsTrends(windows, timeline, { weeks: 52, now: "2026-10-31T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.kpis.streams + trends.previousKpis.streams).toBeGreaterThan(200);
    // Coarse guard against per-stream rescans of the whole timeline, not a benchmark.
    expect(performance.now() - began).toBeLessThan(3_000);
  });

  it("returns a fixed set of empty weekly buckets when the selected range has no windows", () => {
    const trends = deriveStatisticsTrends([], [], { weeks: 4, now: "2026-11-02T12:00:00.000Z", timeZone: "Europe/Berlin" });

    expect(trends.kpis).toEqual({ streams: 0, streamHours: 0, averageViewers: null, messagesPerMinute: null });
    expect(trends.weekly).toHaveLength(5);
    expect(trends.weekly.every((week) => week.streamHours === 0 && week.averageViewers === null)).toBe(true);
    expect(trends.heatmap).toEqual([]);
    expect(trends.categories).toEqual([]);
  });
});
