import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { belaboxModule } from "../../src/modules/belabox";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

const database = (env as unknown as { DB: D1Database }).DB;

beforeAll(runMigrations);

const insertMinute = async (channelId: string, minuteAt: string, bitrate: number): Promise<void> => {
  await database.prepare(
    `INSERT INTO belabox_minutes
      (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
       bitrate_sum, rtt_max, rtt_sum, dropped_delta)
     VALUES (?, ?, 'stream-a', 1, 1, ?, ?, ?, 20, 20, 1)`,
  ).bind(channelId, minuteAt, bitrate, bitrate, bitrate).run();
};

describe("BELABOX bitrate history on real D1 migrations", () => {
  it("rolls minutes up exactly once and purges old minute rows only after the roll-up", async () => {
    const channelId = `belabox-history-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertMinute(channelId, "2026-09-01T10:00:00.000Z", 1_000);
    await insertMinute(channelId, "2026-09-01T10:01:00.000Z", 3_000);
    await insertMinute(channelId, "2026-10-05T11:50:00.000Z", 2_000);

    const now = "2026-10-05T12:00:00.000Z";
    await belaboxModule.scheduledMaintenance?.(database, now);
    await belaboxModule.scheduledMaintenance?.(database, now);

    const windows = await database.prepare(
      `SELECT window_start, bitrate_min, bitrate_max, bitrate_avg, sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? ORDER BY window_start`,
    ).bind(channelId).all();
    expect(windows.results).toEqual([
      { window_start: Date.parse("2026-09-01T10:00:00.000Z"), bitrate_min: 1_000, bitrate_max: 3_000, bitrate_avg: 2_000, sample_count: 2 },
      { window_start: Date.parse("2026-10-05T11:50:00.000Z"), bitrate_min: 2_000, bitrate_max: 2_000, bitrate_avg: 2_000, sample_count: 1 },
    ]);
    const minutes = await database.prepare(
      "SELECT minute_at FROM belabox_minutes WHERE channel_id = ? ORDER BY minute_at",
    ).bind(channelId).all();
    expect(minutes.results).toEqual([{ minute_at: "2026-10-05T11:50:00.000Z" }]);
  });

  it("publishes a live revision for a real minute update but not for roll-up bookkeeping", async () => {
    const channelId = `belabox-history-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertMinute(channelId, "2026-10-05T11:00:00.000Z", 1_000);
    const liveRevision = async (): Promise<number | null> => (await database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:belabox:live'",
    ).bind(channelId).first<{ revision: number }>())?.revision ?? null;
    const before = await liveRevision();
    expect(before).not.toBeNull();

    await belaboxModule.scheduledMaintenance?.(database, "2026-10-05T12:00:00.000Z");
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ? AND rolled_up_at IS NOT NULL",
    ).bind(channelId).first()).resolves.toEqual({ count: 1 });
    expect(await liveRevision()).toBe(before);

    await database.prepare(
      "UPDATE belabox_minutes SET samples = samples + 1, bitrate_sum = bitrate_sum + 10 WHERE channel_id = ?",
    ).bind(channelId).run();
    expect(await liveRevision()).toBe((before ?? 0) + 1);
  });

  it("rolls up at most 64 windows per run and continues on the next run", async () => {
    const channelId = `belabox-history-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const start = Date.parse("2026-10-01T00:00:00.000Z");
    for (let index = 0; index < 70; index += 1) {
      await insertMinute(channelId, new Date(start + index * 300_000).toISOString(), 1_000);
    }
    const now = new Date(start + 80 * 300_000).toISOString();
    const windowCount = async (): Promise<unknown> => database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_bitrate_windows WHERE channel_id = ?",
    ).bind(channelId).first();

    await belaboxModule.scheduledMaintenance?.(database, now);
    await expect(windowCount()).resolves.toEqual({ count: 64 });
    await belaboxModule.scheduledMaintenance?.(database, now);
    await expect(windowCount()).resolves.toEqual({ count: 70 });
  });
});
