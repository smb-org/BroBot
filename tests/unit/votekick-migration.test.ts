import { describe, expect, it } from "vitest";

import { createVotekickRepository, purgeExpiredVotekickUserIds } from "../../src/modules/votekick/adapters/d1";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("Votekick migration", () => {
  it("allows one running ballot per channel and retains aggregate history after ID cleanup", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, initiator_user_id, status, threshold, started_at, expires_at)
         VALUES (?, ?, ?, ?, 'running', 5, ?, ?)`,
      ).bind("channel-a", "ballot-running", "sampleviewer-id", "starter-id", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z").run();

      await expect(database.prepare(
        `INSERT INTO votekicks (channel_id, votekick_id, status, threshold, started_at, expires_at)
         VALUES (?, ?, 'running', 5, ?, ?)`,
      ).bind("channel-a", "ballot-second", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z").run()).rejects.toThrow();

      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold, yes_votes, no_votes,
           duration_seconds, started_at, expires_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'passed', 5, 7, 1, 120, ?, ?, ?)`,
      ).bind("channel-a", "ballot-old", "sampleviewer-id", "sampleviewer", "starter-id", "2029-12-01T00:00:00.000Z", "2029-12-01T00:01:00.000Z", "2029-12-01T00:01:00.000Z").run();
      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold, yes_votes, no_votes,
           duration_seconds, started_at, expires_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'passed', 5, 6, 0, 120, ?, ?, ?)`,
      ).bind("channel-a", "ballot-recent", "sampleviewer-id", "sampleviewer", "starter-id", "2030-01-30T00:00:00.000Z", "2030-01-30T00:01:00.000Z", "2030-01-30T00:01:00.000Z").run();

      await purgeExpiredVotekickUserIds(database as unknown as D1Database, "2030-02-01T00:00:00.000Z");
      await expect(database.prepare(
        "SELECT target_user_id, target_login, initiator_user_id, yes_votes, no_votes FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-old").first()).resolves.toEqual({ target_user_id: null, target_login: null, initiator_user_id: null, yes_votes: 7, no_votes: 1 });
      await expect(database.prepare(
        "SELECT target_user_id, target_login, initiator_user_id FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-recent").first()).resolves.toEqual({ target_user_id: "sampleviewer-id", target_login: "sampleviewer", initiator_user_id: "starter-id" });
      const indexes = await database.prepare("PRAGMA index_info(votekicks_channel_history)").all<{ name: string }>();
      expect(indexes.results.map((row) => row.name)).toEqual(["channel_id", "started_at", "votekick_id"]);
    } finally {
      database.close();
    }
  });

  it("serializes concurrent admissions and rechecks recent channel and target cooldowns", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      const input = (id: string, targetUserId: string) => ({
        id,
        targetUserId,
        targetLogin: targetUserId,
        initiatorUserId: `starter-${id}`,
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const concurrent = await Promise.all([
        repository.admit("channel-a", input("ballot-a", "target-a"), startedAt, 300, 1800),
        repository.admit("channel-a", input("ballot-b", "target-b"), startedAt, 300, 1800),
      ]);
      expect(concurrent.filter((result) => result === "admitted")).toHaveLength(1);
      expect(concurrent.filter((result) => result === "busy")).toHaveLength(1);

      const admittedId = await database.prepare("SELECT votekick_id, target_user_id FROM votekicks WHERE status = 'running'")
        .first<{ votekick_id: string; target_user_id: string }>();
      expect(admittedId).not.toBeNull();
      await repository.updateCounts("channel-a", admittedId?.votekick_id ?? "", 5, 0, 2);
      await repository.finish("channel-a", admittedId?.votekick_id ?? "", "passed", 5, 0, 2, 120, startedAt);

      const delayed = await repository.admit(
        "channel-a",
        input("ballot-c", "target-c"),
        new Date(Date.now() + 10).toISOString(),
        300,
        1800,
      );
      expect(delayed).toBe("channel_cooldown");
      await expect(database.prepare("SELECT status FROM votekicks WHERE votekick_id = 'ballot-c'").first()).resolves.toBeNull();

      const targetCooldown = await repository.admit(
        "channel-a",
        input("ballot-target-cooldown", admittedId?.target_user_id ?? "target-a"),
        new Date(Date.now() + 20).toISOString(),
        0,
        1800,
      );
      expect(targetCooldown).toBe("target_cooldown");
    } finally {
      database.close();
    }
  });

  it("persists ballot counts only when the snapshot revision is newer", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      await expect(repository.admit("channel-a", {
        id: "ballot-revision",
        targetUserId: "target-a",
        targetLogin: "target-a",
        initiatorUserId: "starter-a",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      }, startedAt, 300, 1800)).resolves.toBe("admitted");

      await repository.updateCounts("channel-a", "ballot-revision", 3, 1, 4);
      await repository.updateCounts("channel-a", "ballot-revision", 2, 0, 3);
      await repository.finish("channel-a", "ballot-revision", "expired", 2, 0, 3, null, startedAt);

      await expect(database.prepare("SELECT status, yes_votes, no_votes, ballot_revision FROM votekicks WHERE votekick_id = ?")
        .bind("ballot-revision").first()).resolves.toEqual({ status: "expired", yes_votes: 3, no_votes: 1, ballot_revision: 4 });
    } finally {
      database.close();
    }
  });

  it("does not claim a pass from a snapshot older than the persisted ballot", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      await expect(repository.admit("channel-a", {
        id: "ballot-stale-pass",
        targetUserId: "target-a",
        targetLogin: "target-a",
        initiatorUserId: "starter-a",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      }, startedAt, 300, 1800)).resolves.toBe("admitted");

      await repository.updateCounts("channel-a", "ballot-stale-pass", 2, 2, 4);
      await expect(repository.finish("channel-a", "ballot-stale-pass", "passed", 3, 0, 3, 120, startedAt))
        .resolves.toBe(false);
      await expect(database.prepare(
        "SELECT status, yes_votes, no_votes, ballot_revision FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-stale-pass").first()).resolves.toEqual({
        status: "running", yes_votes: 2, no_votes: 2, ballot_revision: 4,
      });
    } finally {
      database.close();
    }
  });

  it("claims a DO-finalized pass once and mirrors its authoritative snapshot", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      await expect(repository.admit("channel-a", {
        id: "ballot-frozen-pass",
        targetUserId: "target-a",
        targetLogin: "target-a",
        initiatorUserId: "starter-a",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      }, startedAt, 300, 1800)).resolves.toBe("admitted");

      await repository.updateCounts("channel-a", "ballot-frozen-pass", 2, 1, 2);
      await expect(repository.finalize("channel-a", "ballot-frozen-pass", "passed", 4, 1, 6, 120, startedAt))
        .resolves.toBe(true);
      await expect(database.prepare(
        "SELECT status, yes_votes, no_votes, ballot_revision, duration_seconds FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-frozen-pass").first()).resolves.toEqual({
        status: "passed", yes_votes: 4, no_votes: 1, ballot_revision: 6, duration_seconds: 120,
      });
      await expect(repository.finalize("channel-a", "ballot-frozen-pass", "passed", 4, 1, 6, 120, startedAt))
        .resolves.toBe(false);
    } finally {
      database.close();
    }
  });

  it("persists the DO expiry tally exactly while conditionally transitioning only a running row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      await expect(repository.admit("channel-a", {
        id: "ballot-expiry-snapshot",
        targetUserId: "target-a",
        targetLogin: "target-a",
        initiatorUserId: "starter-a",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      }, startedAt, 300, 1800)).resolves.toBe("admitted");

      await expect(repository.finalize("channel-a", "ballot-expiry-snapshot", "expired", 4, 2, 6, null, startedAt))
        .resolves.toBe(true);
      await expect(repository.finalize("channel-a", "ballot-expiry-snapshot", "expired", 1, 0, 1, null, startedAt))
        .resolves.toBe(false);
      await expect(database.prepare(
        "SELECT status, yes_votes, no_votes, ballot_revision, duration_seconds FROM votekicks WHERE votekick_id = ?",
      ).bind("ballot-expiry-snapshot").first()).resolves.toEqual({
        status: "expired", yes_votes: 4, no_votes: 2, ballot_revision: 6, duration_seconds: null,
      });
    } finally {
      database.close();
    }
  });

  it("keeps overdue running rows unresolved until the host ballot finalizes them", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
           yes_votes, no_votes, ballot_revision, started_at, expires_at)
         VALUES ('channel-a', 'ballot-overdue', 'target-a', 'target-a', 'starter-a', 'running', 3, 1, 0, 1, ?, ?)`,
      ).bind(new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 1_000).toISOString()).run();
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = new Date().toISOString();
      const result = await repository.admit("channel-a", {
        id: "ballot-after-expiry",
        targetUserId: "target-b",
        targetLogin: "target-b",
        initiatorUserId: "starter-b",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt,
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      }, startedAt, 0, 0);

      expect(result).toBe("busy");
      await expect(database.prepare("SELECT status FROM votekicks WHERE votekick_id = 'ballot-overdue'").first())
        .resolves.toEqual({ status: "running" });
    } finally {
      database.close();
    }
  });
});
