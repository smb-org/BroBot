import { afterEach, describe, expect, it } from "vitest";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

let database: TestD1Database;
afterEach(() => { database.close(); });

describe("quiz question set migration", () => {
  it("stores channel-owned sets and ordered questions and advances their panel revision", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional_channel");
    await database.prepare(
      "INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind("fictional_channel", "fictional-set", "Space", "2030-01-01", "2030-01-01").run();
    await database.prepare(
      "INSERT INTO quiz_questions (set_id, position, text, options_json, correct_index, enabled) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("fictional-set", 0, "Which planet has rings?", '["Mars","Saturn"]', 1, 1).run();

    await expect(database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:quiz:data'",
    ).bind("fictional_channel").first()).resolves.toEqual({ revision: 2 });
    await expect(database.prepare(
      "SELECT text, position, options_json, correct_index FROM quiz_questions WHERE set_id = ?",
    ).bind("fictional-set").first()).resolves.toEqual({
      text: "Which planet has rings?", position: 0, options_json: '["Mars","Saturn"]', correct_index: 1,
    });
  });

  it("cascades a set deletion to its questions", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional_channel");
    await database.prepare(
      "INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind("fictional_channel", "fictional-set", "Space", "2030-01-01", "2030-01-01").run();
    await database.prepare(
      "INSERT INTO quiz_questions (set_id, position, text, options_json, correct_index, enabled) VALUES (?, 0, ?, ?, 0, 1)",
    ).bind("fictional-set", "Question?", '["A","B"]').run();

    await database.prepare("DELETE FROM quiz_sets WHERE channel_id = ? AND set_id = ?")
      .bind("fictional_channel", "fictional-set").run();

    await expect(database.prepare("SELECT COUNT(*) AS count FROM quiz_questions").first()).resolves.toEqual({ count: 0 });
  });
});
