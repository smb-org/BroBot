import { describe, expect, it } from "vitest";

import { registeredTemplateVariablesForChannel } from "../../src/worker/panel/module-routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("registered template variables", () => {
  it("marks blocks explicitly and scopes module declarations to their template context", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO text_library_categories (channel_id, category_id, catalog_key, created_at, updated_at)
         VALUES ('channel-a', 'social', 'social', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
      ).run();
      await database.prepare(
        `INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
         VALUES ('channel-a', 'welcome', 'social', 1, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
      ).run();

      const variables = await registeredTemplateVariablesForChannel(database as unknown as D1Database, "channel-a");

      expect(variables).toEqual(expect.arrayContaining([
        expect.objectContaining({ moduleId: "text_library", name: "welcome", isTextBlock: true }),
        expect.objectContaining({ moduleId: "raid", name: "channel", isTextBlock: false, contexts: ["event"] }),
        expect.objectContaining({ moduleId: "raid", name: "viewers", isTextBlock: false, contexts: ["event"] }),
        expect.objectContaining({ moduleId: "currency", name: "currency.convert", parameters: "currency_pair" }),
      ]));
    } finally {
      database.close();
    }
  });
});
