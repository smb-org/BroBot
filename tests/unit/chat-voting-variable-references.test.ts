import { afterEach, describe, expect, it } from "vitest";

import { chatVotingModule } from "../../src/modules/chat_voting";
import { insertChannel } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

describe("chat voting template variable references", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    if (database !== null) database.close();
    database = null;
  });

  it("reports and rewrites channel variable references in both announcement templates", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind("fictional-channel", JSON.stringify({ startText: "Vote: {var.score}", resultText: "Final score: {var.score}" })).run();
    await database.prepare(
      `INSERT INTO chat_vote_templates
        (id, channel_id, shortcut, title, labels, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
       VALUES ('template-dinner', 'fictional-channel', NULL, 'Dinner vote', '["Pizza","Burger"]', NULL, 120, 1, NULL, NULL,
         '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z', 'Dinner result: {var.score}')`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
       VALUES ('fictional-channel', 'score', '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z')`,
    ).run();

    const references = chatVotingModule.variableReferences;
    expect(references).toBeDefined();
    await expect(references?.usages(database as unknown as D1Database, "fictional-channel", "score"))
      .resolves.toEqual([
        { moduleId: "chat_voting", itemName: "startText", kind: "template" },
        { moduleId: "chat_voting", itemName: "resultText", kind: "template" },
        { moduleId: "chat_voting", itemName: "Dinner vote", kind: "template" },
      ]);

    const renameVariable = database.prepare(
      "UPDATE channel_variables SET name = 'points' WHERE channel_id = 'fictional-channel' AND name = 'score'",
    );
    const rewriteSettings = references?.rename(database as unknown as D1Database, "fictional-channel", "score", "points")
      .map((statement) => statement as unknown as TestPreparedStatement) ?? [];
    await database.batch([renameVariable, ...rewriteSettings]);

    expect(database.sqlite.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = 'fictional-channel' AND module_id = 'chat_voting'",
    ).get()).toEqual({ settings: JSON.stringify({ startText: "Vote: {var.points}", resultText: "Final score: {var.points}" }) });
    expect(database.sqlite.prepare(
      "SELECT result_text FROM chat_vote_templates WHERE channel_id = 'fictional-channel' AND id = 'template-dinner'",
    ).get()).toEqual({ result_text: "Dinner result: {var.points}" });
  });

  it("supplies saved result text to text block reference tracking", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      `INSERT INTO chat_vote_templates
        (id, channel_id, shortcut, title, labels, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
       VALUES ('template-dinner', 'fictional-channel', NULL, 'Dinner vote', '["Pizza","Burger"]', NULL, 120, 1, NULL, NULL,
         '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z', 'Result: {text.summary}')`,
    ).run();

    await expect(chatVotingModule.templateUsageSources?.(database as unknown as D1Database, "fictional-channel"))
      .resolves.toEqual([{ text: "Result: {text.summary}", kind: "event", label: "chat_voting.Dinner vote" }]);
  });
});
