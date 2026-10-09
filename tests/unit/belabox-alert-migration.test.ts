import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { belaboxSettingsSchema } from "../../src/modules/belabox/contracts";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const alertMigration = "0041_belabox_alerts.sql";
const applyMigrationsBeforeAlerts = (database: DatabaseSync): void => {
  for (const name of readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql") && file < alertMigration)
    .sort((a, b) => a.localeCompare(b))) {
    database.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
  }
};

describe("BELABOX alert settings migration", () => {
  it("preserves JSON booleans and defaults existing settings to schema-readable values", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeAlerts(database);
      database.prepare(
        "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at, language) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("belabox-de", "belabox-de", "BELABOX DE", "2026-10-06", "2026-10-06", "de");
      database.prepare(
        "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at, language) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("belabox-en", "belabox-en", "BELABOX EN", "2026-10-06", "2026-10-06", "en");
      database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
      ).run("belabox-de", JSON.stringify({ mode: "interval", intervalSeconds: 15, alertsEnabled: false, chatEnabled: true }));
      database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
      ).run("belabox-en", JSON.stringify({ mode: "interval", intervalSeconds: 5 }));

      database.exec(readFileSync(resolve(migrationsDirectory, alertMigration), "utf8"));

      const readSettings = (channelId: string): Record<string, unknown> => {
        const row = database.prepare(
          "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
        ).get(channelId) as { settings: string };
        return JSON.parse(row.settings) as Record<string, unknown>;
      };
      const existing = belaboxSettingsSchema.safeParse(readSettings("belabox-de"));
      const freshDefaults = belaboxSettingsSchema.safeParse(readSettings("belabox-en"));

      expect(existing.success).toBe(true);
      expect(freshDefaults.success).toBe(true);
      if (existing.success && freshDefaults.success) {
        expect(existing.data).toMatchObject({ alertsEnabled: false, chatEnabled: true });
        expect(freshDefaults.data).toMatchObject({
          alertsEnabled: true,
          chatEnabled: false,
          holdSeconds: 10,
          recoverHoldSeconds: 15,
        });
        expect(freshDefaults.data.lowText).toContain("{belabox.bitrate}");
      }
    } finally {
      database.close();
    }
  });
});
