import { afterEach, describe, expect, it } from "vitest";

import type { ModuleTimelineEvent } from "../../src/modules/contract";
import { writeChannelTimelineEvent } from "../../src/worker/db/timeline-events";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const onlineEvent: Extract<ModuleTimelineEvent, { kind: "stream_online" }> = {
  kind: "stream_online",
  identity: "online-1",
  occurredAt: "2026-10-25T12:00:00.000Z",
  streamId: "stream-1",
  detail: { startedAt: "2026-10-25T11:55:00.000Z" },
};
const offlineEvent: Extract<ModuleTimelineEvent, { kind: "stream_offline" }> = {
  kind: "stream_offline",
  identity: "offline-1",
  occurredAt: "2026-10-25T12:05:00.000Z",
  detail: {},
};

const events: ModuleTimelineEvent[] = [
  onlineEvent,
  offlineEvent,
  {
    kind: "channel_metadata",
    identity: "metadata-1",
    occurredAt: "2026-10-25T12:06:00.000Z",
    detail: { title: "Current title", category: { id: "game-1", name: "Current category" } },
  },
  { kind: "clip_created", identity: "clip-1", occurredAt: "2026-10-25T12:08:00.000Z", detail: { clipId: "clip-1" } },
  { kind: "ad_break", identity: "ad-1", occurredAt: "2026-10-25T12:09:00.000Z", detail: { durationSeconds: 90, startedAt: "2026-10-25T12:09:00.000Z" } },
  {
    kind: "emote_spike",
    identity: "2026-10-25T12:10:00.000Z",
    occurredAt: "2026-10-25T12:15:00.000Z",
    detail: { windowStart: "2026-10-25T12:10:00.000Z", emotes: 30, medianEmotes: 5, baselineWindows: 12, minimumEmotes: 10, multiplier: 3 },
  },
];

describe("channel timeline events", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it.each(events)("stores $kind once for its event identity", async (event) => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", event);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", event);

    const rows = await database.prepare(
      "SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events WHERE channel_id = ?",
    ).bind("channel-a").all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      kind: event.kind,
      stream_id: event.kind === "stream_online" ? event.streamId : null,
    });
    expect(JSON.parse(rows.results[0]?.detail_json ?? "null") as unknown).not.toHaveProperty("userId");
  });

  it("deduplicates lifecycle redeliveries by timestamp and payload stream id, not message id", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", onlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      ...onlineEvent,
      identity: "redelivered-with-another-message-id",
    });
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", offlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      ...offlineEvent,
      identity: "offline-redelivered-with-another-message-id",
    });

    const rows = await database.prepare(
      "SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events WHERE channel_id = ? ORDER BY kind",
    ).bind("channel-a").all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>();
    expect(rows.results).toEqual([
      {
        kind: "stream_offline",
        stream_id: null,
        occurred_at: "2026-10-25T12:05:00.000Z",
        detail_json: "{}",
      },
      {
        kind: "stream_online",
        stream_id: "stream-1",
        occurred_at: "2026-10-25T12:00:00.000Z",
        detail_json: JSON.stringify({ startedAt: "2026-10-25T11:55:00.000Z" }),
      },
    ]);
  });

  it("stores raw online and offline facts without deriving stream drops", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", onlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", offlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      ...onlineEvent,
      identity: "recovery",
      occurredAt: "2026-10-25T12:09:00.000Z",
    });

    const rows = await database.prepare(
      "SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events WHERE channel_id = ? ORDER BY occurred_at",
    ).bind("channel-a").all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>();
    expect(rows.results).toEqual([
      {
        kind: "stream_online",
        stream_id: "stream-1",
        occurred_at: "2026-10-25T12:00:00.000Z",
        detail_json: JSON.stringify({ startedAt: "2026-10-25T11:55:00.000Z" }),
      },
      { kind: "stream_offline", stream_id: null, occurred_at: "2026-10-25T12:05:00.000Z", detail_json: "{}" },
      {
        kind: "stream_online",
        stream_id: "stream-1",
        occurred_at: "2026-10-25T12:09:00.000Z",
        detail_json: JSON.stringify({ startedAt: "2026-10-25T11:55:00.000Z" }),
      },
    ]);
  });

  it("leaves stream association null for non-online events while a stream is current", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await writeEventSubStreamState(
      database as unknown as D1Database,
      "channel-a",
      "online",
      "2026-10-25T12:00:00.000Z",
      "2026-10-25T11:55:00.000Z",
      "current-stream",
    );

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      kind: "ad_break",
      identity: "ad-1",
      occurredAt: "2026-10-25T12:01:00.000Z",
      detail: { durationSeconds: 60, startedAt: "2026-10-25T12:01:00.000Z" },
    });

    const row = await database.prepare(
      "SELECT stream_id FROM channel_timeline_events WHERE channel_id = ? AND kind = 'ad_break'",
    ).bind("channel-a").first<{ stream_id: string | null }>();
    expect(row).toEqual({ stream_id: null });
  });

  it("keeps distinct metadata observations at the same time when their content differs", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    const occurredAt = "2026-10-25T12:06:00.000Z";

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      kind: "channel_metadata",
      identity: "metadata-1",
      occurredAt,
      detail: { title: "First", category: null },
    });
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      kind: "channel_metadata",
      identity: "metadata-2",
      occurredAt,
      detail: { title: "Second", category: null },
    });
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      kind: "channel_metadata",
      identity: "metadata-redelivery",
      occurredAt,
      detail: { title: "Second", category: null },
    });

    const rows = await database.prepare(
      "SELECT detail_json FROM channel_timeline_events WHERE channel_id = ? AND kind = 'channel_metadata'",
    ).bind("channel-a").all<{ detail_json: string }>();
    expect(rows.results.map(({ detail_json }) => JSON.parse(detail_json) as unknown).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    )).toEqual([
      { title: "First", category: null },
      { title: "Second", category: null },
    ]);
  });
});
