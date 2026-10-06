import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0029_chat_voting.sql"), "utf8");
const requestedDurationMigration = readFileSync(resolve(import.meta.dirname, "../../migrations/0032_chat_voting_requested_duration.sql"), "utf8");
const textPresetMigration = readFileSync(resolve(import.meta.dirname, "../../migrations/0038_chat_voting_text_presets.sql"), "utf8");

describe("chat voting migration", () => {
  it("backfills requested timer durations without treating the four-hour hard limit as a request", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE channel_modules (
          channel_id TEXT NOT NULL,
          module_id TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          settings TEXT NOT NULL,
          UNIQUE (channel_id, module_id),
          FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
        );
        INSERT INTO channels (channel_id) VALUES ('fictional-channel');
      `);
      database.exec(migration);
      const insertLegacyVote = database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at,
           closed_at, close_reason, counts_json, voter_count)
        VALUES ('fictional-channel', ?, 'yes_no', 2, '["Yes","No"]', 'closed', ?, ?, ?, ?, '[0,0]', 0)
      `);
      insertLegacyVote.run("legacy-timed", "2026-10-04T10:00:00.000Z", "2026-10-04T10:01:30.000Z", "2026-10-04T10:01:30.000Z", "timer");
      insertLegacyVote.run("legacy-hard-limit", "2026-10-04T10:00:00.000Z", "2026-10-04T14:00:00.000Z", "2026-10-04T14:00:00.000Z", "limit");

      database.exec(requestedDurationMigration);
      database.exec(textPresetMigration);

      expect(database.prepare(`
        SELECT poll_id, requested_duration_seconds
          FROM chat_votes
         ORDER BY poll_id
      `).all()).toEqual([
        { poll_id: "legacy-hard-limit", requested_duration_seconds: null },
        { poll_id: "legacy-timed", requested_duration_seconds: 90 },
      ]);
    } finally {
      database.close();
    }
  });

  it("seeds enabled module settings and stores aggregate results with one open vote per channel", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE channel_modules (
          channel_id TEXT NOT NULL,
          module_id TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          settings TEXT NOT NULL,
          UNIQUE (channel_id, module_id),
          FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
        );
        INSERT INTO channels (channel_id) VALUES ('fictional-channel');
      `);
      database.exec(migration);
      database.exec(requestedDurationMigration);
      database.exec(textPresetMigration);

      const moduleRow = database.prepare(
        "SELECT enabled, settings FROM channel_modules WHERE channel_id = 'fictional-channel' AND module_id = 'chat_voting'",
      ).get() as { enabled: number; settings: string };
      expect(moduleRow.enabled).toBe(1);
      expect(JSON.parse(moduleRow.settings)).toMatchObject({ autoCloseSeconds: 0, announceResult: true, resultText: "{vote.result}" });

      const insertOpen = database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at,
           requested_duration_seconds, close_reason)
        VALUES (?, ?, 'yes_no', 2, '["Yes","No"]', 'open', '2026-10-04T10:00:00.000Z',
                '2026-10-04T14:00:00.000Z', ?, 'limit')
      `);
      insertOpen.run("fictional-channel", "poll-a", null);
      expect(() => insertOpen.run("fictional-channel", "bad-duration", 0)).toThrow();
      expect(() => insertOpen.run("fictional-channel", "poll-b", 60)).toThrow();
      expect(() => database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at, close_reason)
        VALUES ('fictional-channel', 'bad-labels', 'yes_no', 2, '["Yes"]', 'open', 'a', 'b', 'limit')
      `).run()).toThrow();

      database.prepare(`
        UPDATE chat_votes
           SET status = 'closed', closed_at = '2026-10-04T11:00:00.000Z', counts_json = '[3,1]', voter_count = 4
         WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-a'
      `).run();
      insertOpen.run("fictional-channel", "poll-b", 60);
      database.prepare(`
        UPDATE chat_votes SET close_reason = 'manual'
         WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-b'
      `).run();
      database.prepare(`
        UPDATE chat_votes
           SET status = 'closed', closed_at = '2026-10-04T11:00:00.000Z', counts_json = '[0,0]', voter_count = 0
         WHERE poll_id = 'poll-b'
      `).run();

      database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, text_mode, term_filter_ready,
           status, opened_at, closes_at, close_reason)
        VALUES ('fictional-channel', 'text-poll', 'free_text', 0, '[]', 'first_word', 1,
                'open', '2026-10-04T10:00:00.000Z', '2026-10-04T14:00:00.000Z', 'limit')
      `).run();
      database.prepare(`
        UPDATE chat_votes
           SET status = 'closed', closed_at = '2026-10-04T11:00:00.000Z', counts_json = '[]', voter_count = 2,
               text_results_json = '[{"term":"kappa","count":2,"approved":true}]', more_terms = 3
         WHERE poll_id = 'text-poll'
      `).run();
      expect(() => database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, text_mode, status, opened_at, closes_at, close_reason)
        VALUES ('fictional-channel', 'text-missing-filter', 'free_text', 0, '[]', 'whole_message',
                'open', 'a', 'b', 'limit')
      `).run()).toThrow();

      expect(database.prepare(
        "SELECT counts_json, voter_count, requested_duration_seconds FROM chat_votes WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-a'",
      ).get()).toEqual({ counts_json: "[3,1]", voter_count: 4, requested_duration_seconds: null });
      expect(database.prepare(
        "SELECT requested_duration_seconds FROM chat_votes WHERE channel_id = 'fictional-channel' AND poll_id = 'poll-b'",
      ).get()).toEqual({ requested_duration_seconds: 60 });
      expect(database.prepare(
        "SELECT preset, option_count, text_mode, term_filter_ready, text_results_json, more_terms FROM chat_votes WHERE poll_id = 'text-poll'",
      ).get()).toEqual({
        preset: "free_text",
        option_count: 0,
        text_mode: "first_word",
        term_filter_ready: 1,
        text_results_json: '[{"term":"kappa","count":2,"approved":true}]',
        more_terms: 3,
      });
      const columns = database.prepare("PRAGMA table_info(chat_votes)").all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toContain("voter_user_id");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
