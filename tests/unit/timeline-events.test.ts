import { afterEach, describe, expect, it } from "vitest";

import type { ModuleTimelineEvent } from "../../src/modules/contract";
import { writeChannelTimelineEvent } from "../../src/worker/db/timeline-events";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const onlineEvent: Extract<ModuleTimelineEvent, { kind: "stream_online" }> = {
  kind: "stream_online",
  identity: "online-1",
  occurredAt: "2026-10-25T12:00:00.000Z",
  streamId: "stream-1",
  detail: { startedAt: "2026-10-25T12:00:00.000Z" },
};
const offlineEvent: Extract<ModuleTimelineEvent, { kind: "stream_offline" }> = {
  kind: "stream_offline",
  identity: "offline-1",
  occurredAt: "2026-10-25T12:05:00.000Z",
  streamId: null,
  detail: {},
};

const events: ModuleTimelineEvent[] = [
  onlineEvent,
  offlineEvent,
  { kind: "title_change", identity: "title-1", occurredAt: "2026-10-25T12:06:00.000Z", streamId: "stream-1", detail: { oldTitle: "Old title", newTitle: "New title" } },
  { kind: "category_change", identity: "category-1", occurredAt: "2026-10-25T12:07:00.000Z", streamId: "stream-1", detail: { oldCategory: { id: "old-id", name: "Old category" }, newCategory: { id: "new-id", name: "New category" } } },
  { kind: "clip_created", identity: "clip-1", occurredAt: "2026-10-25T12:08:00.000Z", streamId: "stream-1", detail: { clipId: "clip-1" } },
  { kind: "ad_break", identity: "ad-1", occurredAt: "2026-10-25T12:09:00.000Z", streamId: "stream-1", detail: { durationSeconds: 90, startedAt: "2026-10-25T12:09:00.000Z" } },
  { kind: "emote_spike", identity: "2026-10-25T12:10:00.000Z", occurredAt: "2026-10-25T12:15:00.000Z", streamId: "stream-1", detail: { windowStart: "2026-10-25T12:10:00.000Z", emotes: 30, medianEmotes: 5, baselineWindows: 12, minimumEmotes: 10, multiplier: 3 } },
];

describe("channel timeline events", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it.each(events)("stores $kind once for its natural identity", async (event) => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", event);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", event);

    const rows = await database.prepare(
      "SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events WHERE channel_id = ?",
    ).bind("channel-a").all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ kind: event.kind, stream_id: event.streamId ?? null });
    expect(JSON.parse(rows.results[0]?.detail_json ?? "null") as unknown).not.toHaveProperty("userId");
  });

  it("derives one drop when a late offline event completes a same-broadcast pair", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", onlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      ...onlineEvent, identity: "online-2", occurredAt: "2026-10-25T12:09:00.000Z",
    });
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", offlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", offlineEvent);

    const drops = await database.prepare(
      `SELECT stream_id, occurred_at, detail_json FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'stream_drop'`,
    ).bind("channel-a").all<{ stream_id: string; occurred_at: string; detail_json: string }>();
    expect(drops.results).toEqual([{
      stream_id: "stream-1",
      occurred_at: "2026-10-25T12:09:00.000Z",
      detail_json: JSON.stringify({ gapSeconds: 240 }),
    }]);
  });

  it("does not mark a new broadcast as a drop", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");

    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", onlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", offlineEvent);
    await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
      ...onlineEvent, identity: "online-2", occurredAt: "2026-10-25T12:09:00.000Z", streamId: "stream-2",
    });

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_timeline_events WHERE channel_id = ? AND kind = 'stream_drop'",
    ).bind("channel-a").first()).resolves.toEqual({ count: 0 });
  });

  it.each([{ gapSeconds: 600, expectedDrops: 1 }, { gapSeconds: 601, expectedDrops: 0 }])(
    "uses the inclusive ten-minute drop limit ($gapSeconds seconds)",
    async ({ gapSeconds, expectedDrops }) => {
      database = new TestD1Database();
      await insertChannel(database, "channel-a");
      const offlineAt = "2026-10-25T12:05:00.000Z";
      const onlineAt = new Date(Date.parse(offlineAt) + gapSeconds * 1_000).toISOString();

      await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", onlineEvent);
      await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
        ...offlineEvent, occurredAt: offlineAt,
      });
      await writeChannelTimelineEvent(database as unknown as D1Database, "channel-a", {
        ...onlineEvent, identity: `recovery-${String(gapSeconds)}`, occurredAt: onlineAt,
      });

      await expect(database.prepare(
        "SELECT COUNT(*) AS count FROM channel_timeline_events WHERE channel_id = ? AND kind = 'stream_drop'",
      ).bind("channel-a").first()).resolves.toEqual({ count: expectedDrops });
    },
  );
});
