import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("text command options migration", () => {
  it("preserves existing rows as replies and applies defaults to new rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(resolve(migrationsDirectory, "0000_baseline.sql"), "utf8"));
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at)
        VALUES ('channel-a', 'existing', 'Existing response', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
      `);
      database.exec(readFileSync(resolve(migrationsDirectory, "0002_text_command_options.sql"), "utf8"));
      database.exec(readFileSync(resolve(migrationsDirectory, "0003_text_command_kinds.sql"), "utf8"));

      expect(database.prepare(
        `SELECT aliases_json, user_cooldown_seconds, stream_condition, response_type
           FROM text_commands WHERE command_name = 'existing'`,
      ).get()).toEqual({ aliases_json: "[]", user_cooldown_seconds: 0, stream_condition: "any", response_type: "reply" });

      database.prepare(
        `INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at)
         VALUES ('channel-a', 'new', 'New response', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`,
      ).run();
      expect(database.prepare(
        `SELECT aliases_json, user_cooldown_seconds, stream_condition, response_type
           FROM text_commands WHERE command_name = 'new'`,
      ).get()).toEqual({ aliases_json: "[]", user_cooldown_seconds: 0, stream_condition: "any", response_type: "say" });
    } finally {
      database.close();
    }
  });

  it("rejects invalid options through the SQLite CHECK constraints", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(resolve(migrationsDirectory, "0000_baseline.sql"), "utf8"));
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
      `);
      database.exec(readFileSync(resolve(migrationsDirectory, "0002_text_command_options.sql"), "utf8"));
      database.exec(readFileSync(resolve(migrationsDirectory, "0003_text_command_kinds.sql"), "utf8"));
      const insert = database.prepare(
        `INSERT INTO text_commands
          (channel_id, command_name, response_text, aliases_json, user_cooldown_seconds, stream_condition, response_type, created_at, updated_at)
         VALUES ('channel-a', ?, 'Response', ?, ?, ?, ?, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`,
      );
      const invalid = [
        ["bad-stream", "[]", 0, "live", "say"],
        ["bad-response", "[]", 0, "any", "whisper"],
        ["too-many-aliases", JSON.stringify(Array.from({ length: 11 }, (_, index) => `alias${String(index)}`)), 0, "any", "say"],
        ["wrong-json-kind", "{}", 0, "any", "say"],
        ["too-long-cooldown", "[]", 86401, "any", "say"],
      ] as const;
      for (const values of invalid) expect(() => insert.run(...values)).toThrow();
      expect(() => database.prepare(
        `INSERT INTO text_commands (channel_id, command_name, response_text, kind, created_at, updated_at)
         VALUES ('channel-a', 'invalid-kind', 'Response', 'other', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`,
      ).run()).toThrow();
      database.prepare(
        `INSERT INTO text_commands (channel_id, command_name, response_text, kind, template_fields_json, created_at, updated_at)
         VALUES ('channel-a', 'uptime', 'Live', 'uptime', '{"offlineText":"Offline"}', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`,
      ).run();
      expect(database.prepare("SELECT kind, template_fields_json FROM text_commands WHERE command_name = 'uptime'").get())
        .toEqual({ kind: "uptime", template_fields_json: '{"offlineText":"Offline"}' });
    } finally {
      database.close();
    }
  });
});
