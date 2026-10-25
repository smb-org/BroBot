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
});
