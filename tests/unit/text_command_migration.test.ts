import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("text command options migration", () => {
  it("preserves migrated uptime and followage kinds for token-independent whole-reply fallbacks", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(resolve(migrationsDirectory, "0000_baseline.sql"), "utf8"));
      for (const migration of readdirSync(migrationsDirectory).filter((name) => name > "0000_baseline.sql" && name < "0009_channel_variables.sql").sort()) {
        database.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (channel_id, command_name, response_text, kind, template_fields_json, created_at, updated_at)
        VALUES
          ('channel-a', 'uptime', '{channel} live {uptime}', 'uptime', '{"offlineText":"{channel} is offline"}', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
          ('channel-a', 'followage', '{user} follows {followage}', 'followage', '{"notFollowingText":"Not following","unavailableText":"Unavailable"}', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
      `);
      database.exec(readFileSync(resolve(migrationsDirectory, "0009_channel_variables.sql"), "utf8"));

      expect(database.prepare(
        "SELECT command_name, kind, template_fields_json FROM text_commands ORDER BY command_name",
      ).all()).toEqual([
        { command_name: "followage", kind: "text", template_fields_json: '{"notFollowingText":"Not following","unavailableText":"Unavailable","legacyFallback":true,"legacyKind":"followage"}' },
        { command_name: "uptime", kind: "text", template_fields_json: '{"offlineText":"{channel} is offline","legacyFallback":true,"legacyKind":"uptime"}' },
      ]);
    } finally {
      database.close();
    }
  });

  it("adds an inactive timeout action to existing commands", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of readdirSync(migrationsDirectory).filter((name) => name <= "0027_faq.sql").sort()) {
        database.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at)
        VALUES ('channel-a', 'hello', 'Hello', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
      `);
      database.exec(readFileSync(resolve(migrationsDirectory, "0028_text_command_timeout.sql"), "utf8"));

      expect(database.prepare(
        `SELECT timeout_min_seconds, timeout_max_seconds, timeout_fallback_text
           FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'hello'`,
      ).get()).toEqual({ timeout_min_seconds: null, timeout_max_seconds: null, timeout_fallback_text: null });
    } finally {
      database.close();
    }
  });

  it("moves text commands with timeout actions into the timeout kind without losing command data", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < "0031_text_command_timeout_kind.sql")
        .sort()) {
        database.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO channel_variables (channel_id, name, value, description, reset_on_stream_start, created_at, updated_at)
        VALUES ('channel-a', 'score', 1, '', 0, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (
          channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at,
          kind, enabled, minimum_level, aliases_json, user_cooldown_seconds, stream_condition, response_type,
          template_fields_json, revision, use_count, variable_name, variable_operation, variable_amount,
          games_json, timeout_min_seconds, timeout_max_seconds, timeout_fallback_text, chat_target
        ) VALUES (
          'channel-a', 'roulette', 'Timed out for {timeout.duration}', 12, '2026-09-23T00:01:00.000Z',
          '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 'text', 1, 'vip', '["roll"]', 90,
          'online', 'announcement', '{"usageText":"Try !roulette"}', 4, 7, 'score', 'add', 1, '[]', 30, 300,
          'Timeout failed for {timeout.seconds}', 'all_chats'
        );
        INSERT INTO text_commands (channel_id, command_name, response_text, kind, created_at, updated_at)
        VALUES ('channel-a', 'hello', 'Hello', 'text', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (
          channel_id, command_name, response_text, kind, variable_name, variable_operation, variable_amount,
          timeout_min_seconds, timeout_max_seconds, timeout_fallback_text, created_at, updated_at
        ) VALUES (
          'channel-a', 'silent', '', 'text', 'score', 'add', 1, 30, 30, 'Timeout failed',
          '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'
        );
        INSERT INTO text_command_aliases (channel_id, alias, command_name) VALUES ('channel-a', 'roll', 'roulette');
        INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
        VALUES ('channel-a', 'roulette', 'user-1', '2026-09-23T00:02:00.000Z');
      `);

      database.exec(readFileSync(resolve(migrationsDirectory, "0031_text_command_timeout_kind.sql"), "utf8"));

      expect(database.prepare(
        `SELECT kind, response_text, cooldown_seconds, last_used_at, enabled, minimum_level, aliases_json,
                user_cooldown_seconds, stream_condition, response_type, template_fields_json, revision,
                use_count, variable_name, variable_operation, variable_amount, timeout_min_seconds,
                timeout_max_seconds, timeout_fallback_text, timeout_reason, chat_target
           FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'roulette'`,
      ).get()).toEqual({
        kind: "timeout",
        response_text: "Timed out for {timeout.duration}",
        cooldown_seconds: 12,
        last_used_at: "2026-09-23T00:01:00.000Z",
        enabled: 1,
        minimum_level: "vip",
        aliases_json: '["roll"]',
        user_cooldown_seconds: 90,
        stream_condition: "online",
        response_type: "announcement",
        template_fields_json: '{"usageText":"Try !roulette"}',
        revision: 5,
        use_count: 7,
        variable_name: "score",
        variable_operation: "add",
        variable_amount: 1,
        timeout_min_seconds: 30,
        timeout_max_seconds: 300,
        timeout_fallback_text: "Timeout failed for {timeout.seconds}",
        timeout_reason: null,
        chat_target: "all_chats",
      });
      expect(database.prepare("SELECT kind, revision FROM text_commands WHERE command_name = 'hello'").get())
        .toEqual({ kind: "text", revision: 1 });
      expect(database.prepare(
        `SELECT kind, response_text, variable_name, variable_operation, variable_amount,
                timeout_min_seconds, timeout_max_seconds, timeout_fallback_text
           FROM text_commands WHERE command_name = 'silent'`,
      ).get()).toEqual({
        kind: "timeout",
        response_text: "",
        variable_name: "score",
        variable_operation: "add",
        variable_amount: 1,
        timeout_min_seconds: 30,
        timeout_max_seconds: 30,
        timeout_fallback_text: "Timeout failed",
      });
      expect(database.prepare("SELECT alias, command_name FROM text_command_aliases WHERE channel_id = 'channel-a'").all())
        .toEqual([{ alias: "roll", command_name: "roulette" }]);
      expect(database.prepare("SELECT user_id, last_used_at FROM text_command_user_cooldowns WHERE command_name = 'roulette'").all())
        .toEqual([{ user_id: "user-1", last_used_at: "2026-09-23T00:02:00.000Z" }]);
    } finally {
      database.close();
    }
  });

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
