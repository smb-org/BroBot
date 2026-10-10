import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0047_chat_vote_templates.sql"), "utf8");

const databaseWithLegacySettings = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
    CREATE TABLE channel_modules (
      channel_id TEXT NOT NULL REFERENCES channels(channel_id),
      module_id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      settings TEXT NOT NULL,
      UNIQUE (channel_id, module_id)
    );
  `);
  const insertChannel = database.prepare("INSERT INTO channels (channel_id) VALUES (?)");
  const insertSettings = database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)");
  insertChannel.run("configured");
  insertSettings.run("configured", JSON.stringify({
    autoCloseSeconds: 120,
    yesNoLabels: " Ja | Nein ",
    zeroOneLabels: "No|Yes",
    oneTwoLabels: "eins|zwei",
    scaleLabels: "Very low|Low|Mid|High|Very high",
    optionLabels: "Pizza|Burger|Kebab",
  }));
  insertChannel.run("broken");
  insertSettings.run("broken", JSON.stringify({
    yesNoLabels: "Solo",
    scaleLabels: "Same| same |High|Mid|Top",
    optionLabels: " Alpha || Gamma ",
  }));
  database.exec(migration);
  return database;
};

describe("chat vote template migration", () => {
  it("creates the template table, migrates trimmed labels, and keeps malformed labels for start-time validation", () => {
    const database = databaseWithLegacySettings();
    try {
      expect(database.prepare("PRAGMA table_info(chat_vote_templates)").all().map((column) => (column as { name: string }).name)).toEqual([
        "id", "channel_id", "shortcut", "title", "labels", "free_text_mode", "duration_seconds", "revision",
        "legacy_alias", "last_used_at", "created_at", "updated_at",
      ]);
      const rows = database.prepare(`
        SELECT channel_id, shortcut, title, labels, duration_seconds, legacy_alias
          FROM chat_vote_templates ORDER BY channel_id, shortcut
      `).all() as Array<{ channel_id: string; shortcut: string; title: string; labels: string; duration_seconds: number; legacy_alias: string }>;
      const configured = rows.filter((row) => row.channel_id === "configured");
      expect(configured.map(({ shortcut, title, labels, duration_seconds, legacy_alias }) => ({
        shortcut, title, labels: JSON.parse(labels) as string[], duration_seconds, legacy_alias,
      }))).toEqual([
        { shortcut: "janein", title: "Ja/Nein", labels: ["Ja", "Nein"], duration_seconds: 120, legacy_alias: "yesno" },
        { shortcut: "janein2", title: "Ja/Nein", labels: ["No", "Yes"], duration_seconds: 120, legacy_alias: "zeroOne" },
        { shortcut: "janein3", title: "Ja/Nein", labels: ["eins", "zwei"], duration_seconds: 120, legacy_alias: "oneTwo" },
        { shortcut: "optionen", title: "Optionen", labels: ["Pizza", "Burger", "Kebab"], duration_seconds: 120, legacy_alias: "options" },
        { shortcut: "skala", title: "Skala", labels: ["Very low", "Low", "Mid", "High", "Very high"], duration_seconds: 120, legacy_alias: "scale" },
      ]);
      const broken = rows.filter((row) => row.channel_id === "broken");
      expect(broken.map((row) => ({ alias: row.legacy_alias, shortcut: row.shortcut, labels: JSON.parse(row.labels) as string[] }))).toEqual([
        { alias: "options", shortcut: "optionen", labels: ["Alpha", "", "Gamma"] },
        { alias: "scale", shortcut: "skala", labels: ["Same", "same", "High", "Mid", "Top"] },
      ]);
      expect(rows.some((row) => row.channel_id === "broken" && row.legacy_alias === "yesno")).toBe(false);
      expect(database.prepare("SELECT settings FROM channel_modules WHERE channel_id = 'configured'").get())
        .toEqual({ settings: JSON.stringify({
          autoCloseSeconds: 120,
          yesNoLabels: " Ja | Nein ",
          zeroOneLabels: "No|Yes",
          oneTwoLabels: "eins|zwei",
          scaleLabels: "Very low|Low|Mid|High|Very high",
          optionLabels: "Pizza|Burger|Kebab",
        }) });
    } finally {
      database.close();
    }
  });

  it("keeps alias provenance indexed on migrated templates for command resolution", () => {
    const database = databaseWithLegacySettings();
    try {
      expect(database.prepare("SELECT shortcut, legacy_alias FROM chat_vote_templates WHERE channel_id = ? AND legacy_alias = ?")
        .get("configured", "zeroOne")).toEqual({ shortcut: "janein2", legacy_alias: "zeroOne" });
      expect(database.prepare("PRAGMA index_list(chat_vote_templates)").all().map((row) => (row as { name: string }).name))
        .toEqual(expect.arrayContaining(["chat_vote_templates_channel_shortcut_idx", "chat_vote_templates_channel_last_used_idx"]));
    } finally {
      database.close();
    }
  });
});
