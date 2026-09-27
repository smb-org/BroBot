import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("template value provider migration", () => {
  it("moves channel time zones and migrates stored ads variable names", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith(".sql") && file < "0018_template_value_providers.sql").sort()) {
        database.exec(migration(name));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES
          ('fictional-channel', 'fictional-channel', 'Fictional Channel', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z'),
          ('default-channel', 'default-channel', 'Default Channel', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z');
        INSERT INTO text_library_settings (channel_id, time_zone, updated_at)
        VALUES ('fictional-channel', 'UTC', '2026-09-27T00:00:00.000Z');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('fictional-channel', 'ads', 1,
          '{"automatic":"{duration}","manual":"{duration}","prewarningText":"{seconds}"}');
      `);

      database.exec(migration("0018_template_value_providers.sql"));

      expect(database.prepare("SELECT channel_id, time_zone FROM channels ORDER BY channel_id").all()).toEqual([
        { channel_id: "default-channel", time_zone: "Europe/Berlin" },
        { channel_id: "fictional-channel", time_zone: "UTC" },
      ]);
      expect(database.prepare("SELECT settings FROM channel_modules WHERE channel_id = 'fictional-channel' AND module_id = 'ads'").get())
        .toEqual({ settings: '{"automatic":"{ads.duration}","manual":"{ads.duration}","prewarningText":"{ads.seconds}"}' });
      expect(database.prepare("PRAGMA table_info(text_library_settings)").all()).not.toContainEqual(
        expect.objectContaining({ name: "time_zone" }),
      );
    } finally {
      database.close();
    }
  });
});
