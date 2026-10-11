import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const latestPriorMigration = "0052_chat_vote_templates.sql";
const migrationPath = resolve(migrationsDirectory, "0053_chat_votes_drop_preset.sql");

const createDatabaseThroughLatestPriorMigration = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b))) {
    if (filename > latestPriorMigration) break;
    database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
  }
  return database;
};

const insertChannel = (database: DatabaseSync, channelId: string): void => {
  database.prepare(`
    INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
    VALUES (?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')
  `).run(channelId, channelId, channelId);
};

const insertLegacyPresetVote = (
  database: DatabaseSync,
  preset: string,
  status: "open" | "closed",
): void => {
  const isFreeText = preset === "free_text";
  const isClosed = status === "closed";
  const labels = preset === "scale_5" ? ["Very low", "Low", "Mid", "High", "Very high"]
    : preset === "free_text" ? [] : ["Yes", "No"];
  const counts = labels.map((_, index) => index + 1);
  const channelId = `legacy-${preset}-${status}`;
  insertChannel(database, channelId);
  database.prepare(`
    INSERT INTO chat_votes
      (channel_id, poll_id, preset, option_count, labels_json, text_mode, term_filter_ready,
       status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count,
       text_results_json, more_terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z',
            ?, 'timer', ?, ?, ?, ?)
  `).run(
    channelId,
    preset,
    preset,
    labels.length,
    JSON.stringify(labels),
    isFreeText ? "first_word" : null,
    isFreeText ? 1 : null,
    status,
    isClosed ? "2026-10-10T00:01:00.000Z" : null,
    isClosed ? JSON.stringify(counts) : null,
    isClosed ? (isFreeText ? 2 : counts.reduce((sum, count) => sum + count, 0)) : null,
    isClosed && isFreeText ? '[{"term":"kappa","count":2,"approved":true}]' : null,
    isClosed && isFreeText ? 1 : null,
  );
};

const insertKindOnlyVote = (
  database: DatabaseSync,
  channelId: string,
  kind: "yes_no" | "options" | "free_text",
  status: "open" | "closed",
): void => {
  const isFreeText = kind === "free_text";
  const isClosed = status === "closed";
  const labels = isFreeText ? [] : ["First", "Second"];
  const counts = labels.map(() => 0);
  insertChannel(database, channelId);
  database.prepare(`
    INSERT INTO chat_votes
      (channel_id, poll_id, kind, option_count, labels_json, text_mode, term_filter_ready,
       status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count,
       text_results_json, more_terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z',
            ?, 'timer', ?, ?, ?, ?)
  `).run(
    channelId,
    `${kind}-${status}`,
    kind,
    labels.length,
    JSON.stringify(labels),
    isFreeText ? "whole_message" : null,
    isFreeText ? 1 : null,
    status,
    isClosed ? "2026-10-10T00:01:00.000Z" : null,
    isClosed ? JSON.stringify(counts) : null,
    isClosed ? (isFreeText ? 1 : 0) : null,
    isClosed && isFreeText ? '[{"term":"pizza","count":1,"approved":false}]' : null,
    isClosed && isFreeText ? 0 : null,
  );
};

describe("chat votes drop preset migration", () => {
  it("keeps vote kinds and approvals while removing legacy columns and trigger", () => {
    const database = createDatabaseThroughLatestPriorMigration();
    try {
      const presets = ["yes_no", "scale_5", "options_n", "digit_01", "digit_12", "free_text"] as const;
      for (const preset of presets) {
        insertLegacyPresetVote(database, preset, preset === "free_text" || preset === "scale_5" ? "closed" : "open");
      }
      expect(database.prepare(`
        SELECT poll_id, kind, legacy_written FROM chat_votes WHERE channel_id LIKE 'legacy-%' ORDER BY channel_id
      `).all()).toEqual([
        { poll_id: "digit_01", kind: "options", legacy_written: 1 },
        { poll_id: "digit_12", kind: "options", legacy_written: 1 },
        { poll_id: "free_text", kind: "free_text", legacy_written: 1 },
        { poll_id: "options_n", kind: "options", legacy_written: 1 },
        { poll_id: "scale_5", kind: "options", legacy_written: 1 },
        { poll_id: "yes_no", kind: "yes_no", legacy_written: 1 },
      ]);
      insertKindOnlyVote(database, "kind-yes-no", "yes_no", "open");
      insertKindOnlyVote(database, "kind-options", "options", "closed");
      insertKindOnlyVote(database, "kind-free-text", "free_text", "closed");

      database.exec("DROP TRIGGER chat_votes_fill_legacy_kind_after_insert");
      insertChannel(database, "legacy-null-kind");
      database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at, close_reason)
        VALUES ('legacy-null-kind', 'orphaned-legacy-row', 'digit_12', 2, '["A","B"]', 'open', 'a', 'b', 'manual')
      `).run();

      database.prepare(`
        INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?)
      `).run("legacy-free_text-closed", "free_text", "kappa", "2026-10-10T00:00:30.000Z", "legacy-moderator");
      database.prepare(`
        INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?)
      `).run("kind-free-text", "free_text-closed", "pizza", "2026-10-10T00:00:45.000Z", "kind-moderator");

      database.exec(readFileSync(migrationPath, "utf8"));

      expect(database.prepare("SELECT channel_id, poll_id, kind, status FROM chat_votes ORDER BY channel_id, poll_id").all()).toEqual([
        { channel_id: "kind-free-text", poll_id: "free_text-closed", kind: "free_text", status: "closed" },
        { channel_id: "kind-options", poll_id: "options-closed", kind: "options", status: "closed" },
        { channel_id: "kind-yes-no", poll_id: "yes_no-open", kind: "yes_no", status: "open" },
        { channel_id: "legacy-digit_01-open", poll_id: "digit_01", kind: "options", status: "open" },
        { channel_id: "legacy-digit_12-open", poll_id: "digit_12", kind: "options", status: "open" },
        { channel_id: "legacy-free_text-closed", poll_id: "free_text", kind: "free_text", status: "closed" },
        { channel_id: "legacy-null-kind", poll_id: "orphaned-legacy-row", kind: "options", status: "open" },
        { channel_id: "legacy-options_n-open", poll_id: "options_n", kind: "options", status: "open" },
        { channel_id: "legacy-scale_5-closed", poll_id: "scale_5", kind: "options", status: "closed" },
        { channel_id: "legacy-yes_no-open", poll_id: "yes_no", kind: "yes_no", status: "open" },
      ]);
      expect(database.prepare(`
        SELECT channel_id, poll_id, term, approved_at, approved_by
          FROM chat_vote_term_approvals ORDER BY channel_id, poll_id, term
      `).all()).toEqual([
        { channel_id: "kind-free-text", poll_id: "free_text-closed", term: "pizza", approved_at: "2026-10-10T00:00:45.000Z", approved_by: "kind-moderator" },
        { channel_id: "legacy-free_text-closed", poll_id: "free_text", term: "kappa", approved_at: "2026-10-10T00:00:30.000Z", approved_by: "legacy-moderator" },
      ]);

      const columns = database.prepare("PRAGMA table_info(chat_votes)").all() as Array<{ name: string; notnull: number }>;
      expect(columns.map(({ name }) => name)).not.toContain("preset");
      expect(columns.map(({ name }) => name)).not.toContain("legacy_written");
      expect(columns.find(({ name }) => name === "kind")?.notnull).toBe(1);
      expect(database.prepare("PRAGMA index_list(chat_votes)").all().map((row) => (row as { name: string }).name))
        .toEqual(expect.arrayContaining(["chat_votes_one_open_per_channel", "chat_votes_channel_opened_idx"]));
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
        .map((row) => (row as { name: string }).name);
      expect(triggers).not.toContain("chat_votes_fill_legacy_kind_after_insert");
      expect(triggers).toEqual(expect.arrayContaining([
        "panel_rev_chat_votes_insert", "panel_rev_chat_votes_update", "panel_rev_chat_votes_delete",
      ]));

      insertChannel(database, "invalid-null-kind");
      expect(() => database.prepare(`
        INSERT INTO chat_votes (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, close_reason)
        VALUES ('invalid-null-kind', 'null-kind', NULL, 2, '["Yes","No"]', 'open', 'a', 'b', 'manual')
      `).run()).toThrow();
      insertChannel(database, "invalid-free-text");
      expect(() => database.prepare(`
        INSERT INTO chat_votes (channel_id, poll_id, kind, option_count, labels_json, text_mode, term_filter_ready,
                                status, opened_at, closes_at, close_reason)
        VALUES ('invalid-free-text', 'invalid-free-text', 'free_text', 2, '["A","B"]', 'first_word', 1,
                'open', 'a', 'b', 'manual')
      `).run()).toThrow();

      insertChannel(database, "post-rebuild");
      const before = database.prepare(`
        SELECT revision FROM panel_resource_revisions
         WHERE channel_id = 'post-rebuild' AND resource = 'module:chat_voting:recent'
      `).get() as { revision: number } | undefined;
      database.prepare(`
        INSERT INTO chat_votes (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, close_reason)
        VALUES ('post-rebuild', 'after-rebuild', 'yes_no', 2, '["Yes","No"]', 'open', 'a', 'b', 'manual')
      `).run();
      const after = database.prepare(`
        SELECT revision FROM panel_resource_revisions
         WHERE channel_id = 'post-rebuild' AND resource = 'module:chat_voting:recent'
      `).get() as { revision: number } | undefined;
      expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    } finally {
      database.close();
    }
  });
});
