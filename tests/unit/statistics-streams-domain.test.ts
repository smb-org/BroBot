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
      event("channel_metadata", "2026-10-25T12:05:00.000Z", { title: "At stream end", category: { name: "Game C" } }),
    ]);

    expect(summaries[0]).toMatchObject({ title: "At stream end", categories: ["Game A", "Game B", "Game C"] });
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

  it("pages equal window timestamps by stream id without skipping a tied row", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-25T12:00:00.000Z", "stream-a"),
      window("2026-10-25T12:05:00.000Z", "stream-b"),
    ], []).map((summary) => ({ ...summary, cursorAt: "2026-10-25T12:05:00.000Z" }));

    const first = paginateStreamSummaries(summaries, null, 1);
    const second = paginateStreamSummaries(summaries, first.nextCursor, 1);

    expect(first.streams.map(({ streamId }) => streamId)).toEqual(["stream-b"]);
    expect(second.streams.map(({ streamId }) => streamId)).toEqual(["stream-a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not count ten minutes plus one nanosecond as a drop", () => {
    const within = deriveStreamEvents([
      event("stream_offline", "2026-10-25T12:00:00.000000001Z"),
      event("stream_online", "2026-10-25T12:10:00.000000001Z"),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:20:00.000Z");
    const beyond = deriveStreamEvents([
      event("stream_offline", "2026-10-25T12:00:00.000000001Z"),
      event("stream_online", "2026-10-25T12:10:00.000000002Z"),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:20:00.000Z");

    expect(within.map(({ type }) => type)).toEqual(["drop"]);
    expect(beyond.map(({ type }) => type)).toEqual(["offline", "start"]);
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

  it("keeps a same-id reconnect in one window-bounded stream and derives its drop", () => {
    const online = (occurredAt: string): StatisticsTimelineEvent => ({ kind: "stream_online", occurredAt, detail: {} });
    const timeline = [
      online("2026-10-24T10:00:00.000Z"),
      event("stream_offline", "2026-10-24T10:06:00.000Z"),
      online("2026-10-24T10:08:00.000Z"),
    ];
    const summaries = groupStatisticsWindows([
      window("2026-10-24T10:00:00.000Z", "stream-a"),
      window("2026-10-24T10:05:00.000Z", "stream-a"),
    ], timeline);
    const events = deriveStreamEvents(timeline, "2026-10-24T10:00:00.000Z", "2026-10-24T10:10:00.000Z");

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ streamId: "stream-a", startedAt: "2026-10-24T10:00:00.000Z", endedAt: "2026-10-24T10:10:00.000Z" });
    expect(events.filter(({ type }) => type === "drop")).toEqual([
      expect.objectContaining({ at: "2026-10-24T10:06:00.000Z", recoveredAt: "2026-10-24T10:08:00.000Z", durationSeconds: 120 }),
    ]);
  });

  it("ends a stream without an offline event at the end of its last window", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-24T10:00:00.000Z", "stream-a"),
      window("2026-10-24T10:05:00.000Z", "stream-a"),
    ], []);

    expect(summaries[0]).toMatchObject({ endedAt: "2026-10-24T10:10:00.000Z", durationSeconds: 600 });
  });

  it("includes timeline events at the exact window end instant", () => {
    const events = deriveStreamEvents([
      event("clip_created", "2026-10-25T12:05:00.000000000Z", { clipId: "at-end" }),
      event("clip_created", "2026-10-25T12:05:00.000000001Z", { clipId: "after-end" }),
      event("stream_offline", "2026-10-25T12:05:00.000000000Z"),
      event("stream_online", "2026-10-25T12:05:00.000000001Z"),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:05:00.000Z");

    expect(events.filter(({ type }) => type === "clip")).toEqual([
      expect.objectContaining({ clipId: "at-end", at: "2026-10-25T12:05:00.000000000Z" }),
    ]);
    expect(events.filter(({ type }) => type === "drop")).toHaveLength(0);
    expect(events.filter(({ type }) => type === "offline")).toHaveLength(1);
  });

  it("allows events in a shared five-minute bucket to appear on both streams", () => {
    const summaries = groupStatisticsWindows([
      window("2026-10-25T12:00:00.000Z", "stream-a"),
      window("2026-10-25T12:00:00.000Z", "stream-b"),
    ], [event("clip_created", "2026-10-25T12:02:00.000Z", { clipId: "shared-bucket" })]);

    expect(summaries.map(({ streamId, clips }) => `${streamId}:${String(clips)}`).sort((left, right) => left.localeCompare(right)))
      .toEqual(["stream-a:1", "stream-b:1"]);
  });

  it("associates emote spikes only with a matching stream window start", () => {
    const streamWindows = [
      window("2026-10-25T12:00:00.000Z", "stream-a"),
      window("2026-10-25T12:10:00.000Z", "stream-a"),
    ];
    const events = deriveStreamEvents([
      event("emote_spike", "2026-10-25T12:05:00.000Z", { windowStart: "2026-10-25T12:00:00.000Z", emotes: 30 }),
      event("emote_spike", "2026-10-25T12:10:00.000Z", { windowStart: "2026-10-25T12:05:00.000Z", emotes: 50 }),
      event("emote_spike", "2026-10-25T12:15:00.000Z", { windowStart: "2026-10-25T12:10:00.000Z", emotes: 60 }),
    ], "2026-10-25T12:00:00.000Z", "2026-10-25T12:15:00.000Z", streamWindows);

    expect(events.filter(({ type }) => type === "emoteSpike").map(({ emotes }) => emotes)).toEqual([30, 60]);
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
