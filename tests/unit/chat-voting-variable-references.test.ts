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

  it("reports and rewrites channel variable references in resultText", async () => {
    database = new TestD1Database();
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind("fictional-channel", JSON.stringify({ resultText: "Final score: {var.score}" })).run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
       VALUES ('fictional-channel', 'score', '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z')`,
    ).run();

    const references = chatVotingModule.variableReferences;
    expect(references).toBeDefined();
    await expect(references?.usages(database as unknown as D1Database, "fictional-channel", "score"))
      .resolves.toEqual([{ moduleId: "chat_voting", itemName: "resultText", kind: "template" }]);

    const renameVariable = database.prepare(
      "UPDATE channel_variables SET name = 'points' WHERE channel_id = 'fictional-channel' AND name = 'score'",
    );
    const rewriteSettings = references?.rename(database as unknown as D1Database, "fictional-channel", "score", "points")
      .map((statement) => statement as unknown as TestPreparedStatement) ?? [];
    await database.batch([renameVariable, ...rewriteSettings]);

    expect(database.sqlite.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = 'fictional-channel' AND module_id = 'chat_voting'",
    ).get()).toEqual({ settings: JSON.stringify({ resultText: "Final score: {var.points}" }) });
  });
});
