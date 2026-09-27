import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("channel location migration", () => {
  it("moves existing sun locations to channels and retains only sun error texts", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      for (let number = 0; number <= 19; number += 1) {
        const prefix = String(number).padStart(4, "0");
        const filename = readdirSync(migrationsDirectory).find((name) => name.startsWith(`${prefix}_`));
        if (filename === undefined) throw new Error(`Missing migration ${prefix}.`);
        database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
      }
      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("migration-channel", "migration-channel", "Migration channel", "now", "now");
      database.prepare(
        `INSERT INTO sun_locations
          (channel_id, name, latitude, longitude, location_time_zone, error_text_de, error_text_en, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("migration-channel", "Tromsø, Norway", 69.6492, 18.9553, "Europe/Oslo", "Fehler DE", "Error EN", 4);
      database.exec(readFileSync(resolve(migrationsDirectory, "0020_channel_location.sql"), "utf8"));

      const channel = database.prepare(
        `SELECT location_name, location_latitude, location_longitude, location_time_zone, location_revision
           FROM channels WHERE channel_id = ?`,
      ).get("migration-channel");
      const sunSettings = database.prepare(
        "SELECT error_text_de, error_text_en, revision FROM sun_settings WHERE channel_id = ?",
      ).get("migration-channel");
      const oldTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sun_locations'",
      ).get();

      expect(channel).toEqual({
        location_name: "Tromsø, Norway",
        location_latitude: 69.6492,
        location_longitude: 18.9553,
        location_time_zone: "Europe/Oslo",
        location_revision: 4,
      });
      expect(sunSettings).toEqual({ error_text_de: "Fehler DE", error_text_en: "Error EN", revision: 4 });
      expect(oldTable).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
