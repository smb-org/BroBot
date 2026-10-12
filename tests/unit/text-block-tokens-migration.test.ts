import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { validTextBlock } from "../../src/modules/text_library/domain";
import { templateTextLength } from "../../src/template";
import { handleTimerAlarm } from "../../src/modules/timers";
import { adsSettingsSchema } from "../../src/modules/ads/contracts";
import { raidSettingsSchema } from "../../src/modules/raid/contracts";
import { TestPreparedStatement } from "./test-d1";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("text block token migration", () => {
  it("moves timer and FAQ content to free text and preserves pending stream-start alarms", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const target = "0055_text_block_tokens.sql";
      const targetIndex = migrationFiles.indexOf(target);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const priorMigrations = migrationFiles.slice(0, targetIndex);
      expect(priorMigrations).toContain("0054_channel_module_initialization.sql");
      for (const file of priorMigrations) database.exec(readMigration(file));

      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channela', 'Channel A', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at)
        VALUES ('channel-a', 'social', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_library_settings (channel_id, revision, graph_revision, updated_at)
        VALUES ('channel-a', 4, 7, '2026-10-12T00:00:00.000Z');
        INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
        VALUES ('channel-a', 'welcome', 'social', 1, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
        VALUES ('channel-a', 'welcome', 'default', 0, '{}', '["Hello {welcome} {viewers}"]');
        INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
        VALUES ('channel-a', 'long_example', 'social', 1, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
        VALUES ('channel-a', 'long_example', 'default', 0, '{}', '["${"x".repeat(491)}{welcome}"]');
        INSERT INTO text_commands (channel_id, command_name, response_text, template_fields_json, timeout_fallback_text, created_at, updated_at, timeout_reason)
        VALUES ('channel-a', 'hello', 'Hello {welcome}, {viewers}', '{"label":"{welcome} {viewers}"}', 'Try {welcome} again.', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'Blocked by {welcome}.');
        INSERT INTO text_commands (channel_id, command_name, response_text, template_fields_json, timeout_fallback_text, timeout_reason, created_at, updated_at)
        VALUES ('channel-a', 'long', '${"x".repeat(491)}{welcome}', '${JSON.stringify({ label: `${"x".repeat(491)}{welcome}` })}', '${"x".repeat(491)}{welcome}', '${"x".repeat(491)}{welcome}', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO timers (timer_id, channel_id, name, enabled, block_name, trigger_type, trigger_json, revision, next_run_at, next_run_stream_id, created_at, updated_at)
        VALUES ('timer-a', 'channel-a', 'Reminder', 1, 'welcome', 'stream_start', '{"type":"stream_start","minutes":10}', 7, '2026-10-12T00:10:00.000Z', 'stream-a', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO faq_entries (faq_id, channel_id, name, matcher_type, matcher_json, answer_block, created_at, updated_at)
        VALUES ('faq-a', 'channel-a', 'Greeting', 'keywords', '{"patterns":["hello"]}', 'welcome', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('channel-a', 'ads', 1, '${JSON.stringify({ automatic: `${"x".repeat(491)}{welcome}`, manual: "Manual" })}');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('channel-a', 'raid', 1, '${JSON.stringify({ textLong: `${"x".repeat(491)}{welcome}`, textShort: "Short" })}');
        INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
        VALUES ('overlay-a', 'channel-a', 'Welcome', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text)
        VALUES ('element-a', 'channel-a', 'overlay-a', 'text', 'Overlay {welcome} {viewers}');
        INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text)
        VALUES ('element-long', 'channel-a', 'overlay-a', 'text', '${"x".repeat(91)}{welcome}');
      `);

      database.exec(readMigration(target));

      expect(database.prepare("PRAGMA table_info(timers)").all().map((column) => (column as { name: string }).name))
        .not.toContain("block_name");
      expect(database.prepare("PRAGMA table_info(faq_entries)").all().map((column) => (column as { name: string }).name))
        .not.toContain("answer_block");
      expect(database.prepare("SELECT message_text FROM timers WHERE timer_id = 'timer-a'").get())
        .toEqual({ message_text: "{text.welcome}" });
      expect(database.prepare("SELECT answer_text FROM faq_entries WHERE faq_id = 'faq-a'").get())
        .toEqual({ answer_text: "{text.welcome}" });
      expect(database.prepare("SELECT response_text FROM text_commands WHERE command_name = 'hello'").get())
        .toEqual({ response_text: "Hello {text.welcome}, {viewers}" });
      expect(database.prepare("SELECT timeout_fallback_text, template_fields_json FROM text_commands WHERE command_name = 'hello'").get())
        .toEqual({ timeout_fallback_text: "Try {text.welcome} again.", template_fields_json: '{"label":"{text.welcome} {viewers}"}' });
      expect(database.prepare("SELECT timeout_reason FROM text_commands WHERE command_name = 'hello'").get())
        .toEqual({ timeout_reason: "Blocked by {text.welcome}." });
      expect(database.prepare("SELECT texts_json FROM text_block_variants WHERE block_name = 'welcome'").get())
        .toEqual({ texts_json: '["Hello {text.welcome} {viewers}"]' });
      expect(database.prepare("SELECT texts_json FROM text_block_variants WHERE block_name = 'long_example'").get())
        .toEqual({ texts_json: JSON.stringify([`${"x".repeat(491)}{text.welcome}`]) });
      const migratedMaximumBlock = `${"x".repeat(491)}{text.welcome}`;
      expect(migratedMaximumBlock).toHaveLength(505);
      expect(templateTextLength(migratedMaximumBlock)).toBe(500);
      expect(validTextBlock({
        name: "long_example",
        categoryId: "social",
        games: [],
        variants: [{ id: "default", conditions: {}, texts: [migratedMaximumBlock] }],
      })).toBe(true);
      const migratedCommand = database.prepare("SELECT response_text, template_fields_json, timeout_fallback_text, timeout_reason, revision FROM text_commands WHERE command_name = 'long'").get() as {
        response_text: string; template_fields_json: string; timeout_fallback_text: string; timeout_reason: string; revision: number;
      };
      expect(migratedCommand).toMatchObject({
        response_text: `${"x".repeat(491)}{text.welcome}`,
        timeout_fallback_text: `${"x".repeat(491)}{text.welcome}`,
        timeout_reason: `${"x".repeat(491)}{text.welcome}`,
        revision: 2,
      });
      expect(JSON.parse(migratedCommand.template_fields_json)).toEqual({ label: `${"x".repeat(491)}{text.welcome}` });
      expect(templateTextLength(migratedCommand.response_text)).toBe(500);
      expect(adsSettingsSchema.safeParse(JSON.parse((database.prepare("SELECT settings FROM channel_modules WHERE module_id = 'ads'").get() as { settings: string }).settings)).success).toBe(true);
      expect(raidSettingsSchema.safeParse(JSON.parse((database.prepare("SELECT settings FROM channel_modules WHERE module_id = 'raid'").get() as { settings: string }).settings)).success).toBe(true);
      expect(database.prepare("SELECT revision FROM timers WHERE timer_id = 'timer-a'").get()).toEqual({ revision: 7 });
      expect(database.prepare("SELECT revision FROM faq_entries WHERE faq_id = 'faq-a'").get()).toEqual({ revision: 2 });
      expect(database.prepare("SELECT revision FROM text_blocks WHERE block_name = 'long_example'").get()).toEqual({ revision: 2 });
      expect(database.prepare("SELECT revision FROM text_blocks WHERE block_name = 'welcome'").get()).toEqual({ revision: 2 });
      expect(database.prepare("SELECT revision FROM channel_modules WHERE module_id = 'ads'").get()).toEqual({ revision: 2 });
      expect(database.prepare("SELECT revision FROM channel_modules WHERE module_id = 'raid'").get()).toEqual({ revision: 2 });
      expect(database.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = 'channel-a'").get()).toEqual({ graph_revision: 8 });
      expect(database.prepare("SELECT text FROM overlay_elements WHERE element_id = 'element-a'").get())
        .toEqual({ text: "Overlay {text.welcome} {viewers}" });
      expect(database.prepare("SELECT text FROM overlay_elements WHERE element_id = 'element-long'").get())
        .toEqual({ text: `${"x".repeat(91)}{text.welcome}` });
      expect(database.prepare("SELECT revision FROM overlays WHERE overlay_id = 'overlay-a'").get()).toEqual({ revision: 2 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const d1Database = {
        prepare: (sql: string) => new TestPreparedStatement(database, database.prepare(sql), sql),
      } as unknown as D1Database;
      const sends: string[] = [];
      const alarmContext = {
        DB: d1Database,
        channelId: "channel-a",
        clear: () => Promise.resolve(),
        schedule: () => Promise.resolve(),
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-a", startedAt: "2026-10-12T00:00:00.000Z" }),
        renderTemplate: () => Promise.resolve({ text: "Migrated reminder" }),
        sendChat: (_text: string, idempotencyKey: string) => {
          sends.push(idempotencyKey);
          return Promise.resolve({ sent: true, reason: null, retryable: false });
        },
      } as unknown as Parameters<typeof handleTimerAlarm>[0];
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse("2026-10-12T00:10:00.000Z"));
        await handleTimerAlarm(alarmContext, "timer:timer-a", Date.parse("2026-10-12T00:10:00.000Z"), 7);
      } finally {
        vi.useRealTimers();
      }
      expect(sends).toHaveLength(1);
      expect(database.prepare("SELECT next_run_at FROM timers WHERE timer_id = 'timer-a'").get())
        .toEqual({ next_run_at: null });
    } finally {
      database.close();
    }
  });

  it("limits text block content by semantic length while allowing namespace overhead", () => {
    const validBoundary = `${"x".repeat(491)}{text.welcome}`;
    const tooLong = `${"x".repeat(492)}{text.welcome}`;
    const makeBlock = (text: string) => ({
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: [text] }],
    });

    expect(templateTextLength(validBoundary)).toBe(500);
    expect(validTextBlock(makeBlock(validBoundary))).toBe(true);
    expect(templateTextLength(tooLong)).toBe(501);
    expect(validTextBlock(makeBlock(tooLong))).toBe(false);
  });
});
