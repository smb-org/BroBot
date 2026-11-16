import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("stored overlays migration", () => {
  it("raises the overlay CSS limit while preserving overlays and their elements", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE channel_variables (
          channel_id TEXT NOT NULL,
          name TEXT NOT NULL,
          PRIMARY KEY (channel_id, name)
        );
        CREATE TABLE overlays (
          overlay_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
          width INTEGER NOT NULL DEFAULT 1920 CHECK (width BETWEEN 64 AND 3840),
          height INTEGER NOT NULL DEFAULT 1080 CHECK (height BETWEEN 64 AND 2160),
          css TEXT NOT NULL DEFAULT '' CHECK (length(css) <= 16000),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel_id, overlay_id)
        );
        CREATE INDEX overlays_channel_idx ON overlays(channel_id);
        CREATE TABLE overlay_elements (
          element_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          overlay_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 40),
          variable_name TEXT,
          text TEXT NOT NULL DEFAULT '' CHECK (
            length(text) - 5 * ((length(text) - length(replace(text, '{text.', ''))) / 6) <= 100
          ),
          config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
          x INTEGER NOT NULL DEFAULT 0,
          y INTEGER NOT NULL DEFAULT 0,
          scale_percent INTEGER NOT NULL DEFAULT 100 CHECK (scale_percent BETWEEN 25 AND 400),
          z INTEGER NOT NULL DEFAULT 0,
          in_composition INTEGER NOT NULL DEFAULT 1 CHECK (in_composition IN (0, 1)),
          missing_variable_name TEXT,
          FOREIGN KEY (channel_id, overlay_id) REFERENCES overlays(channel_id, overlay_id) ON DELETE CASCADE,
          FOREIGN KEY (channel_id, variable_name) REFERENCES channel_variables(channel_id, name) ON UPDATE CASCADE
        );
        CREATE INDEX overlay_elements_overlay_idx ON overlay_elements(channel_id, overlay_id);
        CREATE INDEX overlay_elements_variable_idx ON overlay_elements(channel_id, variable_name);
        CREATE TABLE panel_resource_dependencies (source_table TEXT, resource TEXT);
        CREATE TABLE panel_resource_revisions (
          channel_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          revision INTEGER NOT NULL,
          UNIQUE (channel_id, resource)
        );
        INSERT INTO channels (channel_id) VALUES ('channel-a');
        INSERT INTO channel_variables (channel_id, name) VALUES ('channel-a', 'score');
        INSERT INTO overlays (overlay_id, channel_id, name, css, created_at, updated_at)
          VALUES ('overlay-a', 'channel-a', 'Gameplay', 'old css', 'created', 'updated');
        INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name, text)
          VALUES ('element-a', 'channel-a', 'overlay-a', 'variable', 'score', 'Score {value}');
      `);

      database.exec(readMigration("0097_overlay_css_length.sql"));

      expect(database.prepare("SELECT overlay_id, css FROM overlays WHERE overlay_id = 'overlay-a'").get())
        .toEqual({ overlay_id: "overlay-a", css: "old css" });
      expect(database.prepare("SELECT element_id, variable_name, text FROM overlay_elements WHERE element_id = 'element-a'").get())
        .toEqual({ element_id: "element-a", variable_name: "score", text: "Score {value}" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      database.prepare("UPDATE overlays SET css = ? WHERE overlay_id = 'overlay-a'").run("x".repeat(48_000));
      expect(() => database.prepare("UPDATE overlays SET css = ? WHERE overlay_id = 'overlay-a'").run("x".repeat(48_001))).toThrow();
    } finally {
      database.close();
    }
  });

  it("adds overlay tables to a seeded database with tenant and variable foreign keys", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const file of readdirSync(migrationsDirectory).filter((name) => name < "0012_overlays.sql").sort((a, b) => a.localeCompare(b))) {
        database.exec(readMigration(file));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
        INSERT INTO overlay_tokens (token_id, channel_id, token_hash, created_at)
        VALUES ('legacy-token', 'channel-a', 'legacy-hash', '2026-09-24T00:00:00.000Z');
        INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
        VALUES ('channel-a', 'score', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
      `);

      database.exec(readMigration("0012_overlays.sql"));
      database.exec(readMigration("0013_overlay_accesses.sql"));
      database.exec(readMigration("0014_overlay_missing_variable.sql"));
      database.exec(readMigration("0015_ads_countdown_state.sql"));
      database.exec(`
        INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
        VALUES ('overlay-a', 'channel-a', 'Gameplay', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
        INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name, text)
        VALUES ('element-a', 'channel-a', 'overlay-a', 'variable', 'score', 'Score {value}');
      `);

      expect(database.prepare(
        "SELECT width, height, css, revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = 'overlay-a'",
      ).get()).toEqual({ width: 1920, height: 1080, css: "", revision: 1 });
      expect(database.prepare(
        "SELECT variable_name, missing_variable_name, text, scale_percent, in_composition FROM overlay_elements WHERE channel_id = 'channel-a' AND element_id = 'element-a'",
      ).get()).toEqual({ variable_name: "score", missing_variable_name: null, text: "Score {value}", scale_percent: 100, in_composition: 1 });
      expect(database.prepare(
        "SELECT overlay_id, label, secret_envelope FROM overlay_tokens WHERE token_id = 'legacy-token'",
      ).get()).toEqual({ overlay_id: null, label: "", secret_envelope: null });

      database.prepare(
        `INSERT INTO ads_countdown_state
           (channel_id, next_ad_at, duration, snooze_count, snooze_refresh_at, updated_at)
         VALUES ('channel-a', '2026-09-24T12:00:00.000Z', 90, 2, '2026-09-24T12:30:00.000Z', '2026-09-24T11:59:00.000Z')`,
      ).run();
      expect(database.prepare(
        "SELECT next_ad_at, duration, snooze_count, snooze_refresh_at FROM ads_countdown_state WHERE channel_id = 'channel-a'",
      ).get()).toEqual({
        next_ad_at: "2026-09-24T12:00:00.000Z", duration: 90, snooze_count: 2, snooze_refresh_at: "2026-09-24T12:30:00.000Z",
      });

      database.prepare(
        `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, created_at, overlay_id, label, secret_envelope)
         VALUES ('bound-token', 'channel-a', 'bound-hash', '2026-09-24T00:00:00.000Z', 'overlay-a', 'OBS', 'ciphertext')`,
      ).run();
      expect(database.prepare("SELECT overlay_id FROM overlay_tokens WHERE token_id = 'bound-token'").get())
        .toEqual({ overlay_id: "overlay-a" });

      database.prepare("UPDATE channel_variables SET name = 'points' WHERE channel_id = 'channel-a' AND name = 'score'").run();
      expect(database.prepare("SELECT variable_name FROM overlay_elements WHERE element_id = 'element-a'").get())
        .toEqual({ variable_name: "points" });

      expect(() => database.prepare(
        "INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, scale_percent) VALUES ('bad-element', 'channel-a', 'overlay-a', 'variable', 401)",
      ).run()).toThrow();
      expect(() => database.prepare(
        "INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, config_json) VALUES ('bad-json', 'channel-a', 'overlay-a', 'variable', 'not-json')",
      ).run()).toThrow();

      database.prepare("DELETE FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = 'overlay-a'").run();
      expect(database.prepare("SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a'").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT overlay_id FROM overlay_tokens WHERE token_id = 'bound-token'").get())
        .toEqual({ overlay_id: "overlay-a" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
