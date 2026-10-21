import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0074_chat_vote_answer_colors.sql"), "utf8");

describe("chat vote answer colors migration", () => {
  it("backfills saved and running vote palettes by answer index and offers existing templates in the cockpit", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE chat_vote_templates (id TEXT PRIMARY KEY, labels TEXT NOT NULL);
        CREATE TABLE chat_votes (poll_id TEXT PRIMARY KEY, labels_json TEXT NOT NULL);
        INSERT INTO chat_vote_templates (id, labels) VALUES ('two', '["Yes","No"]'), ('six', '["A","B","C","D","E","F"]'), ('nine', '["A","B","C","D","E","F","G","H","I"]');
        INSERT INTO chat_votes (poll_id, labels_json) VALUES ('running', '["Pizza","Burger","Kebab"]');
      `);

      database.exec(migration);

      const templates = database.prepare("SELECT id, answer_colors, offer_in_cockpit FROM chat_vote_templates ORDER BY id")
        .all() as Array<{ id: string; answer_colors: string; offer_in_cockpit: number }>;
      expect(templates.map((template) => ({ ...template, answer_colors: JSON.parse(template.answer_colors) as string[] }))).toEqual([
        { id: "nine", answer_colors: ["#5b8cff", "#ff9f43", "#2ed3a3", "#ff6fae", "#ffd45c", "#a47bff", "#68aeff", "#ff665c", "#c3ccdd"], offer_in_cockpit: 1 },
        { id: "six", answer_colors: ["#5b8cff", "#ff9f43", "#2ed3a3", "#ff6fae", "#ffd45c", "#a47bff"], offer_in_cockpit: 1 },
        { id: "two", answer_colors: ["#5b8cff", "#ff9f43"], offer_in_cockpit: 1 },
      ]);
      expect(database.prepare("SELECT answer_colors_json FROM chat_votes WHERE poll_id = 'running'").get())
        .toEqual({ answer_colors_json: '["#5b8cff","#ff9f43","#2ed3a3"]' });
    } finally {
      database.close();
    }
  });
});
