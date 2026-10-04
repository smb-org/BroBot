import { describe, expect, it } from "vitest";

import { purgeExpiredVotekickUserIds } from "../../src/modules/votekick/adapters/d1";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("Votekick migration", () => {
  it("allows one running ballot per channel and retains aggregate history after ID cleanup", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, initiator_user_id, status, threshold, started_at, ends_at)
         VALUES (?, ?, ?, ?, 'running', 5, ?, ?)`,
      ).bind("channel-a", "ballot-running", "sampleviewer-id", "starter-id", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z").run();

      await expect(database.prepare(
        `INSERT INTO votekicks (channel_id, votekick_id, status, threshold, started_at, ends_at)
         VALUES (?, ?, 'running', 5, ?, ?)`,
      ).bind("channel-a", "ballot-second", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z").run()).rejects.toThrow();

      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold, yes_votes, no_votes,
           duration_seconds, started_at, ends_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'passed', 5, 7, 1, 120, ?, ?, ?)`,
      ).bind("channel-a", "ballot-old", "sampleviewer-id", "sampleviewer", "starter-id", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z", "2029-12-01T00:01:00.000Z").run();
      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold, yes_votes, no_votes,
           duration_seconds, started_at, ends_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'passed', 5, 6, 0, 120, ?, ?, ?)`,
      ).bind("channel-a", "ballot-recent", "sampleviewer-id", "sampleviewer", "starter-id", "2030-01-30T00:00:00.000Z", "2030-01-30T00:01:00.000Z", "2030-01-30T00:01:00.000Z").run();

      await purgeExpiredVotekickUserIds(database as unknown as D1Database, "2030-02-01T00:00:00.000Z");
      await expect(database.prepare(
        "SELECT target_user_id, target_login, initiator_user_id, yes_votes, no_votes FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-old").first()).resolves.toEqual({ target_user_id: null, target_login: null, initiator_user_id: null, yes_votes: 7, no_votes: 1 });
      await expect(database.prepare(
        "SELECT target_user_id, target_login, initiator_user_id FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-recent").first()).resolves.toEqual({ target_user_id: "sampleviewer-id", target_login: "sampleviewer", initiator_user_id: "starter-id" });
    } finally {
      database.close();
    }
  });
});
