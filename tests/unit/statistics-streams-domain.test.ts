import { describe, expect, it } from "vitest";

import {
  deriveStreamEvents,
  groupStatisticsWindows,
  matchBitrateWindows,
  paginateStreamSummaries,
} from "../../src/modules/statistics/streams-domain";
import type { StatisticsStreamWindow, StatisticsTimelineEvent } from "../../src/modules/statistics/contracts";

const window = (windowStart: string, streamId: string | null, values: Partial<StatisticsStreamWindow> = {}): StatisticsStreamWindow => ({
  windowStart,
  streamId,
  messages: 10,
  emotes: 2,
  viewerCount: 100,
  chatters: 20,
  activeChatters: 5,
  ...values,
});

const event = (kind: StatisticsTimelineEvent["kind"], occurredAt: string, detail: Readonly<Record<string, unknown>> = {}): StatisticsTimelineEvent => ({
  kind,
  occurredAt,
  detail,
});

describe("statistics stream derivation", () => {
  it("groups windows by non-null stream id and derives aggregate summary values", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-25T12:00:00.000Z", "stream-a", { messages: 10, viewerCount: 20 }),
      window("2026-10-25T12:05:00.000Z", null, { messages: 999 }),
      window("2026-10-25T12:05:00.000Z", "stream-a", { messages: 30, viewerCount: 40, activeChatters: null }),
      window("2026-10-25T12:10:00.000Z", "stream-b", { messages: 7, viewerCount: null, activeChatters: 3 }),
    ], []);

    expect(summaries).toEqual([
      expect.objectContaining({
        streamId: "stream-b",
        startedAt: "2026-10-25T12:10:00.000Z",
        endedAt: "2026-10-25T12:15:00.000Z",
        durationSeconds: 300,
        averageViewers: null,
        peakViewers: null,
        messages: 7,
        averageActiveChatters: 3,
      }),
      expect.objectContaining({
        streamId: "stream-a",
        startedAt: "2026-10-25T12:00:00.000Z",
        endedAt: "2026-10-25T12:10:00.000Z",
        durationSeconds: 600,
        averageViewers: 30,
        peakViewers: 40,
        peakAt: "2026-10-25T12:05:00.000Z",
        messages: 40,
        averageActiveChatters: 5,
      }),
    ]);
  });

  it("picks the latest title and distinct plain-text categories inside each stream", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-25T12:00:00.000Z", "stream-a"),
    ], [
      event("channel_metadata", "2026-10-25T12:01:00.000Z", { title: "Opening", category: { name: "Game A" } }),
      event("channel_metadata", "2026-10-25T12:02:00.000Z", { title: "Main show", category: { name: "Game B" } }),
      event("channel_metadata", "2026-10-25T12:03:00.000Z", { title: "Main show", category: { name: "Game A" } }),
      event("channel_metadata", "2026-10-25T12:05:00.000Z", { title: "Outside range", category: { name: "Game C" } }),
    ]);

    expect(summaries[0]).toMatchObject({ title: "Main show", categories: ["Game A", "Game B"] });
  });

  it("paginates summaries with an opaque cursor and keeps older rows on the next page", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-25T12:00:00.000Z", "stream-c"),
      window("2026-10-25T12:10:00.000Z", "stream-a"),
      window("2026-10-25T12:05:00.000Z", "stream-b"),
    ], []);

    const first = paginateStreamSummaries(summaries, null, 2);
    const second = paginateStreamSummaries(summaries, first.nextCursor, 2);

    expect(first.streams.map(({ streamId }) => streamId)).toEqual(["stream-a", "stream-b"]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain("stream-b");
    expect(second.streams.map(({ streamId }) => streamId)).toEqual(["stream-c"]);
    expect(second.nextCursor).toBeNull();
  });

  it("derives a drop only when an offline event is followed by an online event within ten minutes", () => {
    const events = deriveStreamEvents([
      event("stream_online", "2026-10-25T12:00:00.000Z"),
      event("stream_offline", "2026-10-25T12:10:00.000Z"),
      event("stream_online", "2026-10-25T12:18:00.000Z"),
      event("stream_offline", "2026-10-25T12:20:00.000Z"),
      event("stream_online", "2026-10-25T12:30:01.000Z"),
      event("stream_offline", "2026-10-25T12:40:00.000Z"),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:50:00.000Z");

    expect(events.filter(({ type }) => type === "drop")).toHaveLength(1);
    expect(events.find(({ type }) => type === "drop")).toMatchObject({
      at: "2026-10-25T12:10:00.000Z",
      recoveredAt: "2026-10-25T12:18:00.000Z",
      durationSeconds: 480,
    });
    expect(events.filter(({ type }) => type === "offline")).toHaveLength(2);
  });

  it("derives title and category transitions from consecutive observations", () => {
    const events = deriveStreamEvents([
      event("channel_metadata", "2026-10-25T12:00:00.000Z", { title: "Starting", category: { name: "Game A" } }),
      event("channel_metadata", "2026-10-25T12:04:00.000Z", { title: "Final title", category: { name: "Game B" } }),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:10:00.000Z");

    expect(events).toContainEqual(expect.objectContaining({
      type: "metadata",
      at: "2026-10-25T12:04:00.000Z",
      oldTitle: "Starting",
      title: "Final title",
      oldCategory: "Game A",
      category: "Game B",
    }));
  });

  it("matches BELABOX windows by time range regardless of their stream ids", () => {
    const windows = matchBitrateWindows([
      { windowStart: 1_798_000_000_000, bitrateAvg: 3_000, bitrateMin: 2_800, bitrateMax: 3_200, bitrateP10: 2_900 },
      { windowStart: Date.parse("2026-10-25T12:00:00.000Z"), bitrateAvg: 5_400, bitrateMin: 5_000, bitrateMax: 5_700, bitrateP10: 5_100 },
      { windowStart: Date.parse("2026-10-25T12:05:00.000Z"), bitrateAvg: 5_500, bitrateMin: 5_100, bitrateMax: 5_800, bitrateP10: 5_200 },
      { windowStart: Date.parse("2026-10-25T12:10:00.000Z"), bitrateAvg: 4_900, bitrateMin: 4_700, bitrateMax: 5_200, bitrateP10: 4_800 },
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:10:00.000Z");

    expect(windows.map(({ bitrateAvg }) => bitrateAvg)).toEqual([5_400, 5_500]);
  });
});
