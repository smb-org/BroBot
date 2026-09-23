import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

const insertChannel = (database: DatabaseSync, channelId: string): void => {
  database.exec(`
    INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
    VALUES ('${channelId}', '${channelId}', '${channelId}', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
  `);
};

describe("clips default-on migration", () => {
  it("backfills an enabled row only for channels that don't already have one", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(resolve(migrationsDirectory, "0000_baseline.sql"), "utf8"));
      insertChannel(database, "channel-missing");
      insertChannel(database, "channel-explicit-off");
      insertChannel(database, "channel-explicit-on");
      database.exec(`
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('channel-explicit-off', 'clips', 0, '{}');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('channel-explicit-on', 'clips', 1, '{"marker":true}');
      `);

      database.exec(readFileSync(resolve(migrationsDirectory, "0005_clips_default_on.sql"), "utf8"));

      const rows = database.prepare(
        `SELECT channel_id, enabled, settings FROM channel_modules WHERE module_id = 'clips' ORDER BY channel_id`,
      ).all();
      expect(rows).toEqual([
        { channel_id: "channel-explicit-off", enabled: 0, settings: "{}" },
        { channel_id: "channel-explicit-on", enabled: 1, settings: '{"marker":true}' },
        { channel_id: "channel-missing", enabled: 1, settings: "{}" },
      ]);
    } finally {
      database.close();
    }
  });
});
