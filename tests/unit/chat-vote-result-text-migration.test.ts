import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { templateTextLength } from "../../src/contracts/template-text-length";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0069_chat_vote_result_text_snapshot.sql"), "utf8");

describe("chat vote result text migration", () => {
  it("snapshots the existing module result text onto open and historical votes", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE channel_modules (channel_id TEXT NOT NULL, module_id TEXT NOT NULL, settings TEXT NOT NULL);
        CREATE TABLE chat_votes (
          channel_id TEXT NOT NULL,
          poll_id TEXT NOT NULL,
          PRIMARY KEY (channel_id, poll_id)
        ) WITHOUT ROWID;
        INSERT INTO channels VALUES ('channel-a');
        INSERT INTO channel_modules VALUES ('channel-a', 'chat_voting', '{"resultText":"Danke {vote.result}"}');
        INSERT INTO chat_votes VALUES ('channel-a', 'open-vote');
      `);

      database.exec(migration);

      expect(database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'open-vote'").get())
        .toEqual({ result_text: "Danke {vote.result}" });
      database.prepare("INSERT INTO chat_votes (channel_id, poll_id) VALUES ('channel-a', 'new-vote')").run();
      expect(database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'new-vote'").get())
        .toEqual({ result_text: null });
    } finally {
      database.close();
    }
  });

  it("preserves logically valid templated result text beyond 500 raw characters", () => {
    const database = new DatabaseSync(":memory:");
    const resultText = "{text.foo}".repeat(100);
    try {
      database.exec(`
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE channel_modules (channel_id TEXT NOT NULL, module_id TEXT NOT NULL, settings TEXT NOT NULL);
        CREATE TABLE chat_votes (
          channel_id TEXT NOT NULL,
          poll_id TEXT NOT NULL,
          PRIMARY KEY (channel_id, poll_id)
        ) WITHOUT ROWID;
      `);
      database.prepare("INSERT INTO channels VALUES ('channel-a')").run();
      database.prepare("INSERT INTO channel_modules VALUES ('channel-a', 'chat_voting', ?)")
        .run(JSON.stringify({ resultText }));
      database.prepare("INSERT INTO chat_votes VALUES ('channel-a', 'long-result-vote')").run();

      database.exec(migration);

      expect(resultText.length).toBeGreaterThan(500);
      expect(templateTextLength(resultText)).toBeLessThanOrEqual(500);
      expect(database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'long-result-vote'").get())
        .toEqual({ result_text: resultText });
    } finally {
      database.close();
    }
  });
});
