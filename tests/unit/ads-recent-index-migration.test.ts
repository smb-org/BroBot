import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(import.meta.dirname, "../../migrations");
const readMigration = (name: string): string => readFileSync(path.join(migrationsDirectory, name), "utf8");

describe("recent ad event index migration", () => {
  it("indexes the filtered recent-ad lookup", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readMigration("0000_baseline.sql"));
      database.exec(readMigration("0085_efficiency_c_dashboard_polling.sql"));

      const plan = database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT created_at, detail_json
           FROM event_log
          WHERE channel_id = ? AND module_id = 'ads' AND code = 'ads.announcement'
          ORDER BY created_at DESC, event_id DESC
          LIMIT ?`,
      ).all("channel-a", 5) as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join(" ")).toMatch(/event_log_recent_ads_idx/u);
    } finally {
      database.close();
    }
  });
});
