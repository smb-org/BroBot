import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("API source token migration", () => {
  it("rewrites stored source references to {api.<name>} across template fields", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < "0060_api_source_namespace.sql")
        .sort((left, right) => left.localeCompare(right));
      for (const name of priorMigrations) database.exec(migration(name));
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('token-channel', 'token-channel', 'Token Channel', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO api_sources (channel_id, source_name, url, expression)
        VALUES ('token-channel', 'sunset', 'https://api.example.test/sunset', '$.sunset');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('token-channel', 'test_module', 1, '{"message":"{api_source.value sunset}"}');
        INSERT INTO text_commands (channel_id, command_name, response_text, kind, template_fields_json,
          timeout_fallback_text, timeout_reason, created_at, updated_at)
        VALUES ('token-channel', 'sunset', '{api_source.value sunset}', 'text',
          '{"usageText":"{api_source.value sunset}"}', '{api_source.value sunset}', '{api_source.value sunset}',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO timers (timer_id, channel_id, name, message_text, trigger_type, trigger_json, created_at, updated_at)
        VALUES ('timer-1', 'token-channel', 'Sunset', '{api_source.value sunset}', 'interval', '{}',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
        VALUES ('faq-1', 'token-channel', 'Sunset', '{}', '{api_source.value sunset}',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT OR IGNORE INTO text_library_categories (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
        VALUES ('token-channel', 'info', 'info', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO text_blocks (channel_id, block_name, category_id, games_json, revision, created_at, updated_at)
        VALUES ('token-channel', 'sunset_block', 'info', '[]', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
        VALUES ('token-channel', 'sunset_block', 'default', 0, '{}', '["{api_source.value sunset}"]');
        INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
        VALUES ('overlay-1', 'token-channel', 'Overlay', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
        INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text)
        VALUES ('element-1', 'token-channel', 'overlay-1', 'text', '{api_source.value sunset}');
        INSERT INTO chat_vote_templates (id, channel_id, title, labels, created_at, updated_at)
        VALUES ('vote-1', 'token-channel', '{api_source.value sunset}', '["{api_source.value sunset}"]',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      `);

      database.exec(migration("0060_api_source_namespace.sql"));

      expect(database.prepare("SELECT settings FROM channel_modules WHERE channel_id = 'token-channel' AND module_id = 'test_module'").get())
        .toEqual({ settings: '{"message":"{api.sunset}"}' });
      expect(database.prepare("SELECT response_text, template_fields_json, timeout_fallback_text, timeout_reason FROM text_commands WHERE channel_id = 'token-channel'").get())
        .toEqual({ response_text: "{api.sunset}", template_fields_json: '{"usageText":"{api.sunset}"}', timeout_fallback_text: "{api.sunset}", timeout_reason: "{api.sunset}" });
      expect(database.prepare("SELECT message_text FROM timers WHERE timer_id = 'timer-1'").get()).toEqual({ message_text: "{api.sunset}" });
      expect(database.prepare("SELECT answer_text FROM faq_entries WHERE faq_id = 'faq-1'").get()).toEqual({ answer_text: "{api.sunset}" });
      expect(database.prepare("SELECT texts_json FROM text_block_variants WHERE block_name = 'sunset_block'").get())
        .toEqual({ texts_json: '["{api.sunset}"]' });
      expect(database.prepare("SELECT text FROM overlay_elements WHERE element_id = 'element-1'").get()).toEqual({ text: "{api.sunset}" });
      expect(database.prepare("SELECT title, labels FROM chat_vote_templates WHERE id = 'vote-1'").get())
        .toEqual({ title: "{api.sunset}", labels: '["{api.sunset}"]' });
      expect(database.prepare("SELECT last_fetched_at, last_status, last_error FROM api_sources WHERE source_name = 'sunset'").get())
        .toEqual({ last_fetched_at: null, last_status: null, last_error: null });
    } finally {
      database.close();
    }
  });
});
