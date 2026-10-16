import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("clips automatic cooldown migration", () => {
  it("raises enabled automatic clips to the minimum without changing disabled settings", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < "0066_clips_automatic_cooldown.sql")
        .sort((left, right) => left.localeCompare(right));
      for (const migration of priorMigrations) database.exec(readMigration(migration));

      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('channel-a', 'channel-a', 'Channel A', 'now', 'now')`,
      ).run();
      const insert = database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('channel-a', ?, 1, ?)",
      );
      insert.run("clips", JSON.stringify({ automaticClipsEnabled: true, automaticCooldownSeconds: 0 }));
      insert.run("clips-disabled", JSON.stringify({ automaticClipsEnabled: false, automaticCooldownSeconds: 0 }));

      database.exec(readMigration("0066_clips_automatic_cooldown.sql"));

      const values = database.prepare(
        "SELECT module_id, settings, revision FROM channel_modules ORDER BY module_id",
      ).all() as Array<{ module_id: string; settings: string; revision: number }>;
      expect(values.map((row) => ({
        moduleId: row.module_id,
        settings: JSON.parse(row.settings) as unknown,
        revision: row.revision,
      }))).toEqual([
        { moduleId: "clips", settings: { automaticClipsEnabled: true, automaticCooldownSeconds: 60 }, revision: 2 },
        { moduleId: "clips-disabled", settings: { automaticClipsEnabled: false, automaticCooldownSeconds: 0 }, revision: 1 },
      ]);
    } finally {
      database.close();
    }
  });
});
