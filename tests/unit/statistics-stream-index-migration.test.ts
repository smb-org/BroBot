import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(import.meta.dirname, "../../migrations");
const readMigration = (name: string): string => readFileSync(path.join(migrationsDirectory, name), "utf8");

describe("statistics stream and quota cleanup indexes", () => {
  it("uses stream and window indexes for stream reads and hourly quota cleanup", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readMigration("0000_baseline.sql"));
      database.exec(readMigration("0026_api_sources.sql"));
      database.exec(readMigration("0077_statistics.sql"));
      database.exec(readMigration("0086_efficiency_e_statistics_quota.sql"));

      const streamListPlan = database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT stream_id, MIN(window_start), MAX(window_start)
           FROM channel_statistics
          WHERE channel_id = ? AND stream_id IS NOT NULL
          GROUP BY stream_id
          ORDER BY MAX(window_start) DESC, stream_id DESC
          LIMIT ?`,
      ).all("channel-a", 21) as Array<{ detail: string }>;
      const streamDetailPlan = database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT window_start, stream_id, messages, emotes, viewer_count, chatters, active_chatters
           FROM channel_statistics
          WHERE channel_id = ? AND stream_id = ?
          ORDER BY window_start ASC`,
      ).all("channel-a", "stream-a") as Array<{ detail: string }>;
      const quotaCleanupPlan = database.prepare(
        `EXPLAIN QUERY PLAN
         DELETE FROM api_source_quota WHERE window_start < ?`,
      ).all("2026-01-01T00:00:00.000Z") as Array<{ detail: string }>;

      const streamListDetails = streamListPlan.map(({ detail }) => detail).join(" ");
      const streamDetailDetails = streamDetailPlan.map(({ detail }) => detail).join(" ");
      const quotaCleanupDetails = quotaCleanupPlan.map(({ detail }) => detail).join(" ");
      expect(streamListDetails).toMatch(/channel_statistics_stream_window_idx/u);
      expect(streamListDetails).not.toMatch(/SCAN channel_statistics\b/u);
      expect(streamDetailDetails).toMatch(/channel_statistics_stream_window_idx/u);
      expect(streamDetailDetails).not.toMatch(/SCAN channel_statistics\b/u);
      expect(quotaCleanupDetails).toMatch(/api_source_quota_window_start_idx/u);
      expect(quotaCleanupDetails).not.toMatch(/SCAN api_source_quota\b/u);
    } finally {
      database.close();
    }
  });
});
