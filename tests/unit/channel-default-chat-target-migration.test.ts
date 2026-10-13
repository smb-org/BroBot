import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("channel default chat target migration", () => {
  it("preserves saved entry targets and makes new entries inherit the channel default", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      const migrations = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && Number(/^\d+/u.exec(name)?.[0]) <= 57)
        .sort((left, right) => left.localeCompare(right));
      for (const migration of migrations) database.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));

      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('channel-a', 'channel-a', 'Channel A', 'now', 'now')`,
      ).run();
      database.prepare(
        `INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at, chat_target)
         VALUES ('channel-a', 'hello', 'Hello', 'now', 'now', 'all_chats')`,
      ).run();
      database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, matcher_json, answer_text, chat_target, created_at, updated_at)
         VALUES ('faq-a', 'channel-a', 'Hello', '{"type":"keywords","patterns":["hello"]}', 'Hello', 'where_asked', 'now', 'now')`,
      ).run();
      database.prepare(
        `INSERT INTO timers
          (timer_id, channel_id, name, message_text, trigger_type, trigger_json, chat_target, created_at, updated_at)
         VALUES ('timer-a', 'channel-a', 'Hello', 'Hello', 'interval', '{"type":"interval","minutes":10}', 'all_chats', 'now', 'now')`,
      ).run();

      database.exec(readFileSync(resolve(migrationsDirectory, "0059_channel_default_chat_target.sql"), "utf8"));

      const channel = database.prepare(
        "SELECT default_chat_target, default_chat_target_revision FROM channels WHERE channel_id = 'channel-a'",
      ).get();
      const entries = database.prepare(
        `SELECT chat_target, use_channel_default_target FROM text_commands WHERE channel_id = 'channel-a'
         UNION ALL SELECT chat_target, use_channel_default_target FROM faq_entries WHERE channel_id = 'channel-a'
         UNION ALL SELECT chat_target, use_channel_default_target FROM timers WHERE channel_id = 'channel-a'
         ORDER BY chat_target`,
      ).all();

      expect(channel).toEqual({ default_chat_target: "source_only", default_chat_target_revision: 1 });
      expect(entries).toEqual([
        { chat_target: "all_chats", use_channel_default_target: 0 },
        { chat_target: "all_chats", use_channel_default_target: 0 },
        { chat_target: "where_asked", use_channel_default_target: 0 },
      ]);
    } finally {
      database.close();
    }
  });
});
