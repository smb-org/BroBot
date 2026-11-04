import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

const applyMigrationsBeforePolls = (database: DatabaseSync): void => {
  for (const name of readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith(".sql") && filename < "0088_polls.sql")
    .sort((left, right) => left.localeCompare(right))) {
    database.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
  }
};

describe("polls migration", () => {
  it("creates entries and runs, tracks run changes, preserves runs after entry deletion, and enforces duration bounds", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforePolls(database);
      database.exec(readFileSync(resolve(migrationsDirectory, "0088_polls.sql"), "utf8"));
      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('channel_polls', 'polls_demo', 'Polls demo', '2026-11-04', '2026-11-04')`,
      ).run();

      const tables = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map(({ name }) => name));
      expect(tables).toContain("polls_entries");
      expect(tables).toContain("polls_runs");

      database.prepare(
        `INSERT INTO polls_entries (
           channel_id, entry_id, kind, title, choices_json, duration_seconds,
           channel_points_voting_enabled, channel_points_per_vote, revision, created_at, updated_at
         ) VALUES (?, ?, 'prediction', ?, ?, 30, 0, NULL, 1, ?, ?)`,
      ).run("channel_polls", "entry_polls", "Fictional title", '["First outcome","Second outcome"]', "2026-11-04", "2026-11-04");

      const revisionBeforeRun = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:polls:data'",
      ).get("channel_polls") as { revision: number };
      database.prepare(
        `INSERT INTO polls_runs (
           channel_id, run_id, kind, twitch_id, entry_id, source, title, choices_json, status,
           started_at, ends_at, locked_at, ended_at, winning_choice_id, last_event_at, terminal_payload_json
         ) VALUES (?, ?, 'prediction', ?, ?, 'brobot', ?, ?, 'active', ?, ?, NULL, NULL, NULL, ?, NULL)`,
      ).run(
        "channel_polls", "run_polls", "twitch_run_polls", "entry_polls", "Fictional title",
        '[{"id":"outcome_first","title":"First outcome","votes":null,"users":0,"channelPoints":0},{"id":"outcome_second","title":"Second outcome","votes":null,"users":0,"channelPoints":0}]',
        "2026-11-04T12:00:00.000Z", "2026-11-04T12:00:30.000Z", "2026-11-04T12:00:00.000Z",
      );
      const revisionAfterRun = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:polls:data'",
      ).get("channel_polls") as { revision: number };
      expect(revisionAfterRun.revision).toBe(revisionBeforeRun.revision + 1);

      database.prepare("DELETE FROM polls_entries WHERE channel_id = ? AND entry_id = ?")
        .run("channel_polls", "entry_polls");
      expect(database.prepare("SELECT entry_id FROM polls_runs WHERE channel_id = ? AND run_id = ?")
        .get("channel_polls", "run_polls")).toEqual({ entry_id: null });

      expect(() => database.prepare(
        `INSERT INTO polls_entries (
           channel_id, entry_id, kind, title, choices_json, duration_seconds,
           channel_points_voting_enabled, channel_points_per_vote, revision, created_at, updated_at
         ) VALUES (?, ?, 'poll', ?, ?, 10, 0, NULL, 1, ?, ?)`,
      ).run("channel_polls", "entry_short", "Short poll", '["One","Two"]', "2026-11-04", "2026-11-04"))
        .toThrow();
    } finally {
      database.close();
    }
  });
});
