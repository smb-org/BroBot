import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { VOTEKICK_DEFAULT_TEXTS } from "../../src/modules/votekick/contracts/chat-defaults";
import { votekickDefaultSettingsForLanguage } from "../../src/modules/votekick/contracts";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0072_votekick_language_defaults.sql"), "utf8");
const defaultTextFields = ["startText", "passText", "failText", "expiredText", "protectedText", "busyText"] as const;

describe("Votekick language defaults", () => {
  it("localizes untouched English defaults and missing messages for German channels only", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY, language TEXT NOT NULL);
        CREATE TABLE channel_modules (channel_id TEXT NOT NULL, module_id TEXT NOT NULL, settings TEXT NOT NULL);
        INSERT INTO channels VALUES ('de-default', 'de'), ('de-custom', 'de'), ('en-default', 'en');
      `);
      const defaults = VOTEKICK_DEFAULT_TEXTS.en;
      const insert = database.prepare("INSERT INTO channel_modules VALUES (?, 'votekick', ?)");
      insert.run("de-default", JSON.stringify(defaults));
      insert.run("de-custom", JSON.stringify({ ...defaults, startText: "Custom start" }));
      insert.run("en-default", JSON.stringify(defaults));

      database.exec(migration);

      const rows = database.prepare("SELECT channel_id, settings FROM channel_modules ORDER BY channel_id")
        .all() as { channel_id: string; settings: string }[];
      const settings = new Map(rows.map((row) => [row.channel_id, JSON.parse(row.settings) as Record<string, string>]));
      for (const key of defaultTextFields) {
        expect(settings.get("de-default")?.[key]).toBe(VOTEKICK_DEFAULT_TEXTS.de[key]);
        expect(settings.get("en-default")?.[key]).toBe(VOTEKICK_DEFAULT_TEXTS.en[key]);
      }
      expect(settings.get("de-custom")?.startText).toBe("Custom start");
      expect(settings.get("de-custom")?.passText).toBe(VOTEKICK_DEFAULT_TEXTS.de.passText);
    } finally {
      database.close();
    }
  });

  it("provides the same German defaults when a module is enabled on a German channel", () => {
    const defaults = votekickDefaultSettingsForLanguage("de");
    for (const key of defaultTextFields) expect(defaults[key]).toBe(VOTEKICK_DEFAULT_TEXTS.de[key]);
    expect(votekickDefaultSettingsForLanguage("en").startText).toBe(VOTEKICK_DEFAULT_TEXTS.en.startText);
  });
});
