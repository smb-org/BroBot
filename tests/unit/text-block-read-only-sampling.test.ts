import { describe, expect, it } from "vitest";

import type { ModuleTemplateValueContext } from "../../src/modules/contract";
import { createTextBlockTemplateValueProvider } from "../../src/modules/text_library/adapters/template-expander";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "text-block-read-only-channel";

describe("read-only text block sampling", () => {
  it("samples one alternative without advancing its persisted choice", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES (?, 1, ?)")
        .bind(CHANNEL_ID, "2026-10-18T12:00:00.000Z").run();
      await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, 'social', ?, ?)")
        .bind(CHANNEL_ID, "2026-10-18T12:00:00.000Z", "2026-10-18T12:00:00.000Z").run();
      await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, 'welcome', 'social', 1, ?, ?)")
        .bind(CHANNEL_ID, "2026-10-18T12:00:00.000Z", "2026-10-18T12:00:00.000Z").run();
      await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES (?, 'welcome', 'default', 0, '{}', '[\"Hello\",\"Welcome\"]')")
        .bind(CHANNEL_ID).run();
      const context = {
        DB: database as unknown as D1Database,
        channelId: CHANNEL_ID,
        templateContext: "chat_command",
        knownTemplateVariableNames: new Set(),
        chatStatus: ["viewer"],
        mode: "chat",
        readOnly: true,
        channelLanguage: () => Promise.resolve("en"),
        streamState: () => Promise.resolve("offline"),
        channelInfo: () => Promise.resolve(null),
        channelTimeZone: () => Promise.resolve("UTC"),
        channelLocation: () => Promise.resolve(null),
        renderTemplate: (text: string) => Promise.resolve({ text, diagnostics: [] }),
        addDiagnostic: () => undefined,
        now: Date.parse("2026-10-18T12:00:00.000Z"),
        resolveTemplateConditions: () => Promise.resolve({}),
        random: () => 1,
      } as unknown as ModuleTemplateValueContext;

      const values = await createTextBlockTemplateValueProvider(database as unknown as D1Database, CHANNEL_ID)(["welcome"], context);

      expect(["Hello", "Welcome"]).toContain(values.welcome);
      await expect(database.prepare("SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'welcome'")
        .first()).resolves.toEqual({ last_chosen_index: -1 });
    } finally {
      database.close();
    }
  });
});
