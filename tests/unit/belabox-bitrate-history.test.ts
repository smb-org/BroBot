import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { belaboxModule } from "../../src/modules/belabox";
import { insertChannel } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-bitrate-history-channel";

describe("BELABOX permanent bitrate history", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
  });

  afterEach(() => {
    database.close();
  });

  it("rolls minute metrics into one aligned window with weighted averages and nearest-rank P10", async () => {
    await insertMinute("2026-10-05T12:00:00.000Z", "stream-a", 2, 80, 100, 180, 10, 3);
    await insertMinute("2026-10-05T12:01:00.000Z", "stream-a", 1, 40, 40, 40, 6, 2);
    await insertMinute("2026-10-05T12:02:00.000Z", "stream-a", 3, 50, 90, 210, 30, 4);

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:15:00.000Z");

    const rows = await database.prepare(
      `SELECT window_start, bitrate_min, bitrate_max, bitrate_avg, bitrate_p10, rtt_avg,
              dropped_delta, sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, "stream-a").all<{
      window_start: number;
      bitrate_min: number;
      bitrate_max: number;
      bitrate_avg: number;
      bitrate_p10: number;
      rtt_avg: number;
      dropped_delta: number;
      sample_count: number;
    }>();

    expect(rows.results).toEqual([{
      window_start: Date.parse("2026-10-05T12:00:00.000Z"),
      bitrate_min: 40,
      bitrate_max: 100,
      bitrate_avg: 430 / 6,
      bitrate_p10: 40,
      rtt_avg: 46 / 6,
      dropped_delta: 9,
      sample_count: 6,
    }]);
    const firstWindow = rows.results[0];
    expect(firstWindow).toBeDefined();
    if (firstWindow !== undefined) expect(firstWindow.window_start % 300_000).toBe(0);
  });

  it("keeps stream-boundary windows partial and separates their stream keys", async () => {
    await insertMinute("2026-10-05T12:02:00.000Z", "stream-a", 2, 100, 120, 220, 10, 1);
    await insertMinute("2026-10-05T12:03:00.000Z", "stream-a", 1, 130, 130, 130, 6, 2);
    await insertMinute("2026-10-05T12:04:00.000Z", "stream-a", 1, 140, 140, 140, 8, 3);
    await insertMinute("2026-10-05T12:05:00.000Z", "stream-a", 1, 150, 150, 150, 5, 4);
    await insertMinute("2026-10-05T12:06:00.000Z", "stream-a", 2, 160, 180, 340, 12, 5);
    await insertMinute("2026-10-05T12:04:00.000Z", "stream-b", 1, 900, 900, 900, 9, 1);

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:15:00.000Z");

    const rows = await database.prepare(
      `SELECT stream_id, window_start, sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? ORDER BY window_start, stream_id`,
    ).bind(CHANNEL_ID).all<{ stream_id: string; window_start: number; sample_count: number }>();
    expect(rows.results).toEqual([
      { stream_id: "stream-a", window_start: Date.parse("2026-10-05T12:00:00.000Z"), sample_count: 4 },
      { stream_id: "stream-b", window_start: Date.parse("2026-10-05T12:00:00.000Z"), sample_count: 1 },
      { stream_id: "stream-a", window_start: Date.parse("2026-10-05T12:05:00.000Z"), sample_count: 3 },
    ]);
  });

  it("is idempotent when scheduled maintenance is run twice", async () => {
    await insertMinute("2026-10-05T12:00:00.000Z", "stream-a", 2, 1_000, 1_200, 2_200, 80, 6);

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:15:00.000Z");
    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:15:00.000Z");

    const rows = await database.prepare(
      `SELECT COUNT(*) AS count, SUM(sample_count) AS sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, "stream-a").first<{ count: number; sample_count: number }>();
    expect(rows).toEqual({ count: 1, sample_count: 2 });
  });

  it("includes minute updates committed after candidate selection", async () => {
    await insertMinute("2026-10-05T12:00:00.000Z", "stream-a", 1, 100, 100, 100, 50, 1);
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("WITH candidate_windows"),
      async () => {
        await database.prepare(
          `UPDATE belabox_minutes
              SET samples = 2, bitrate_max = 200, bitrate_sum = 300, rtt_sum = 150, dropped_delta = 3
            WHERE channel_id = ? AND minute_at = ? AND stream_id = ?`,
        ).bind(CHANNEL_ID, "2026-10-05T12:00:00.000Z", "stream-a").run();
      },
    );

    await belaboxModule.scheduledMaintenance?.(interleavedDatabase, "2026-10-05T12:15:00.000Z");

    const row = await database.prepare(
      `SELECT bitrate_max, bitrate_avg, rtt_avg, dropped_delta, sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, "stream-a").first<{
      bitrate_max: number;
      bitrate_avg: number;
      rtt_avg: number;
      dropped_delta: number;
      sample_count: number;
    }>();
    expect(row).toEqual({ bitrate_max: 200, bitrate_avg: 150, rtt_avg: 75, dropped_delta: 3, sample_count: 2 });
  });

  it("rebuilds a changed window using its already rolled-up minute rows", async () => {
    await insertMinute("2026-10-05T12:00:00.000Z", "stream-a", 2, 80, 100, 180, 10, 3);
    await insertMinute("2026-10-05T12:01:00.000Z", "stream-a", 1, 100, 100, 100, 50, 2);
    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:15:00.000Z");
    await database.prepare(
      `UPDATE belabox_minutes
          SET samples = 3, bitrate_max = 160, bitrate_sum = 360, rtt_sum = 90,
              dropped_delta = 4, rolled_up_at = NULL
        WHERE channel_id = ? AND minute_at = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, "2026-10-05T12:00:00.000Z", "stream-a").run();

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:20:00.000Z");

    const row = await database.prepare(
      `SELECT bitrate_min, bitrate_max, bitrate_avg, rtt_avg, dropped_delta, sample_count
         FROM belabox_bitrate_windows WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, "stream-a").first<{
      bitrate_min: number;
      bitrate_max: number;
      bitrate_avg: number;
      rtt_avg: number;
      dropped_delta: number;
      sample_count: number;
    }>();
    expect(row).toEqual({
      bitrate_min: 80,
      bitrate_max: 160,
      bitrate_avg: 115,
      rtt_avg: 35,
      dropped_delta: 6,
      sample_count: 4,
    });
  });

  it("rolls up expired rows before purging them", async () => {
    await insertMinute("2026-09-04T11:50:00.000Z", "old-stream", 1, 700, 700, 700, 20, 3);
    const executedBatchSql: string[] = [];
    const batch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementation(async (statements) => {
      executedBatchSql.push(...statements.map((statement) =>
        (statement as unknown as { sql: string }).sql));
      return batch(statements);
    });

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:00:00.000Z");

    expect(executedBatchSql.findIndex((sql) => sql.includes("INSERT INTO belabox_bitrate_windows")))
      .toBeLessThan(executedBatchSql.findIndex((sql) => sql.includes("DELETE FROM belabox_minutes")));
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_bitrate_windows WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("limits each maintenance run to 1,000 windows and resumes the backlog", async () => {
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    for (let index = 0; index < 1_001; index += 1) {
      const minuteAt = new Date(start + index * 300_000).toISOString();
      await insertMinute(minuteAt, "stream-a", 1, 1_000, 1_000, 1_000, 50, 1);
    }
    const now = new Date(start + 1_002 * 300_000 + 300_000).toISOString();
    let largestBatch = 0;
    const batch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementation(async (statements) => {
      largestBatch = Math.max(largestBatch, statements.length);
      return batch(statements);
    });

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, now);
    const firstRun = await database.prepare(
      `SELECT COUNT(*) AS count FROM belabox_bitrate_windows WHERE channel_id = ?`,
    ).bind(CHANNEL_ID).first<{ count: number }>();
    const pendingAfterFirstRun = await database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ? AND rolled_up_at IS NULL",
    ).bind(CHANNEL_ID).first<{ count: number }>();

    expect(firstRun?.count).toBe(1_000);
    expect(pendingAfterFirstRun?.count).toBe(1);
    expect(largestBatch).toBeLessThanOrEqual(100);

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, now);
    const secondRun = await database.prepare(
      `SELECT COUNT(*) AS count FROM belabox_bitrate_windows WHERE channel_id = ?`,
    ).bind(CHANNEL_ID).first<{ count: number }>();
    expect(secondRun?.count).toBe(1_001);
  });

  async function insertMinute(
    minuteAt: string,
    streamId: string,
    samples: number,
    bitrateMin: number,
    bitrateMax: number,
    bitrateSum: number,
    rttSum: number,
    droppedDelta: number,
  ): Promise<void> {
    await database.prepare(
      `INSERT INTO belabox_minutes
        (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
         bitrate_sum, rtt_max, rtt_sum, dropped_delta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, minuteAt, streamId, samples, samples, bitrateMin, bitrateMax,
      bitrateSum, rttSum, rttSum, droppedDelta).run();
  }
});
