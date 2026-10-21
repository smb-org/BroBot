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
        (id, channel_id, shortcut, title, labels, answer_colors, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
       VALUES ('template-dinner', 'fictional-channel', NULL, 'Dinner vote', '["Pizza","Burger"]', '["#5b8cff","#ff9f43"]', NULL, 120, 1, NULL, NULL,
         '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z', 'Dinner result: {var.score}')`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
       VALUES ('fictional-channel', 'score', '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, answer_colors_json, status, opened_at, closes_at, close_reason, title, result_text)
       VALUES ('fictional-channel', 'poll-open', 'yes_no', 2, '["Yes","No"]', '["#5b8cff","#ff9f43"]', 'open',
         '2026-10-04T10:00:00.000Z', '2026-10-04T10:02:00.000Z', 'timer', 'Running vote', 'Running result: {var.score}')`,
    ).run();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, answer_colors_json, status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count, title, result_text)
       VALUES ('fictional-channel', 'poll-closed', 'yes_no', 2, '["Yes","No"]', '["#5b8cff","#ff9f43"]', 'closed',
         '2026-10-03T10:00:00.000Z', '2026-10-03T10:02:00.000Z', '2026-10-03T10:01:00.000Z', 'timer', '[1,0]', 1,
         'Closed vote', 'Closed result: {var.score}')`,
    ).run();

    const references = chatVotingModule.variableReferences;
    expect(references).toBeDefined();
    await expect(references?.usages(database as unknown as D1Database, "fictional-channel", "score"))
      .resolves.toEqual([
        { moduleId: "chat_voting", itemName: "startText", kind: "template" },
        { moduleId: "chat_voting", itemName: "resultText", kind: "template" },
        { moduleId: "chat_voting", itemName: "Dinner vote", kind: "template" },
        { moduleId: "chat_voting", itemName: "Running vote", kind: "template" },
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
    expect(database.sqlite.prepare(
      "SELECT result_text FROM chat_votes WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-open'",
    ).get()).toEqual({ result_text: "Running result: {var.points}" });
    expect(database.sqlite.prepare(
      "SELECT result_text FROM chat_votes WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-closed'",
    ).get()).toEqual({ result_text: "Closed result: {var.score}" });

    await database.prepare(
      "UPDATE chat_votes SET status = 'closed', closed_at = ?, counts_json = '[0,0]', voter_count = 0 WHERE channel_id = ? AND poll_id = ?",
    ).bind("2026-10-04T10:03:00.000Z", "fictional-channel", "poll-open").run();
    await expect(references?.usages(database as unknown as D1Database, "fictional-channel", "points"))
      .resolves.toEqual([
        { moduleId: "chat_voting", itemName: "startText", kind: "template" },
        { moduleId: "chat_voting", itemName: "resultText", kind: "template" },
        { moduleId: "chat_voting", itemName: "Dinner vote", kind: "template" },
        { moduleId: "chat_voting", itemName: "Running vote", kind: "template" },
      ]);
  });

  it("supplies saved result text to text block reference tracking", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      `INSERT INTO chat_vote_templates
        (id, channel_id, shortcut, title, labels, answer_colors, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
       VALUES ('template-dinner', 'fictional-channel', NULL, 'Dinner vote', '["Pizza","Burger"]', '["#5b8cff","#ff9f43"]', NULL, 120, 1, NULL, NULL,
         '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z', 'Result: {text.summary}')`,
    ).run();

    await expect(chatVotingModule.templateUsageSources?.(database as unknown as D1Database, "fictional-channel"))
      .resolves.toEqual([{ text: "Result: {text.summary}", kind: "event", label: "chat_voting.Dinner vote" }]);
  });
});
