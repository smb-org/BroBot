import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { requestChatVoteClose } from "../../src/modules/chat_voting/service";
import { TestD1Database } from "./test-d1";

interface LegacyVoteFixture {
  preset: "yes_no" | "scale_5" | "options_n" | "digit_01" | "digit_12" | "free_text";
  kind: "yes_no" | "options" | "free_text";
  labels: readonly string[];
  counts: readonly number[];
  results?: string;
}

const fixtures: readonly LegacyVoteFixture[] = [
  { preset: "yes_no", kind: "yes_no", labels: ["Yes", "No"], counts: [4, 2] },
  { preset: "scale_5", kind: "options", labels: ["Very low", "Low", "Mid", "High", "Very high"], counts: [1, 2, 3, 4, 5] },
  { preset: "options_n", kind: "options", labels: ["A", "B", "C"], counts: [1, 0, 2] },
  { preset: "digit_01", kind: "options", labels: ["No", "Yes"], counts: [3, 7] },
  { preset: "digit_12", kind: "options", labels: ["First", "Second"], counts: [5, 2] },
  { preset: "free_text", kind: "free_text", labels: [], counts: [], results: '[{"term":"kappa","count":2,"approved":true}]' },
];

const migration = (filename: string): string => readFileSync(resolve(import.meta.dirname, `../../migrations/${filename}`), "utf8");

const createPreKindDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
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
  `);
  const insertChannel = database.prepare("INSERT INTO channels (channel_id) VALUES (?)");
  for (const fixture of fixtures) insertChannel.run(`fixture-${fixture.preset}`);
  insertChannel.run("trigger-channel");
  database.exec(migration("0029_chat_voting.sql"));
  database.exec(migration("0032_chat_voting_requested_duration.sql"));
  database.exec(migration("0038_chat_voting_text_presets.sql"));
  database.exec(migration("0039_chat_voting_term_approvals.sql"));
  database.exec(migration("0045_chat_voting_title.sql"));
  return database;
};

const insertLegacyVote = (
  database: DatabaseSync,
  fixture: LegacyVoteFixture,
  status: "open" | "closed",
): void => {
  const freeText = fixture.preset === "free_text";
  const labels = [...fixture.labels];
  const counts = [...fixture.counts];
  const id = `${fixture.preset}-${status}`;
  const closedAt = status === "closed" ? "2026-10-04T10:01:00.000Z" : null;
  const textResults = freeText && status === "closed" ? fixture.results ?? "[]" : null;
  const voterCount = status === "closed"
    ? freeText ? 2 : counts.reduce((sum, count) => sum + count, 0)
    : null;
  database.prepare(`
    INSERT INTO chat_votes
      (channel_id, poll_id, preset, option_count, labels_json, text_mode, term_filter_ready,
       status, opened_at, closes_at, closed_at, requested_duration_seconds, close_reason,
       counts_json, voter_count, text_results_json, more_terms, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 60, 'timer', ?, ?, ?, ?, ?)
  `).run(
    `fixture-${fixture.preset}`,
    id,
    fixture.preset,
    labels.length,
    JSON.stringify(labels),
    freeText ? "first_word" : null,
    freeText ? 1 : null,
    status,
    "2026-10-04T10:00:00.000Z",
    "2026-10-04T10:01:00.000Z",
    closedAt,
    status === "closed" ? JSON.stringify(counts) : null,
    voterCount,
    textResults,
    freeText && status === "closed" ? 1 : null,
    `Fixture ${fixture.preset}?`,
  );
};

describe("chat voting kind migration", () => {
  let databases: TestD1Database[] = [];

  afterEach(() => {
    for (const database of databases) database.close();
    databases = [];
  });

  it("maps all six legacy presets while preserving labels, totals, titles, and term approvals", () => {
    const database = createPreKindDatabase();
    try {
      for (const fixture of fixtures) {
        insertLegacyVote(database, fixture, "open");
        insertLegacyVote(database, fixture, "closed");
      }
      database.prepare(`
        INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?)
      `).run("fixture-free_text", "free_text-open", "kappa", "2026-10-04T10:00:30.000Z", "fixture-moderator");
      database.prepare(`
        INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?)
      `).run("fixture-free_text", "free_text-closed", "burger", "2026-10-04T10:00:45.000Z", "fixture-moderator");

      database.exec(migration("0046_chat_voting_kind.sql"));

      const rows = database.prepare(`
        SELECT poll_id, kind, preset, legacy_written, labels_json, counts_json, title
          FROM chat_votes ORDER BY poll_id
      `).all() as Array<Record<string, unknown>>;
      const expected = fixtures.flatMap((fixture) => ["closed", "open"].map((status) => ({
        poll_id: `${fixture.preset}-${status}`,
        kind: fixture.kind,
        preset: fixture.preset,
        legacy_written: 1,
        labels_json: JSON.stringify(fixture.labels),
        counts_json: status === "closed" ? JSON.stringify(fixture.counts) : null,
        title: `Fixture ${fixture.preset}?`,
      }))).sort((left, right) => left.poll_id < right.poll_id ? -1 : left.poll_id > right.poll_id ? 1 : 0);
      expect(rows).toEqual(expected);
      expect(database.prepare(`
        SELECT poll_id, term, approved_at, approved_by FROM chat_vote_term_approvals ORDER BY poll_id
      `).all()).toEqual([
        { poll_id: "free_text-closed", term: "burger", approved_at: "2026-10-04T10:00:45.000Z", approved_by: "fixture-moderator" },
        { poll_id: "free_text-open", term: "kappa", approved_at: "2026-10-04T10:00:30.000Z", approved_by: "fixture-moderator" },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      for (const fixture of fixtures.filter(({ preset }) => preset !== "free_text")) {
        const closed = rows.find((row) => row.poll_id === `${fixture.preset}-closed`);
        expect(JSON.parse(String(closed?.labels_json))).toEqual(fixture.labels);
        expect(JSON.parse(String(closed?.counts_json))).toEqual(fixture.counts);
      }
      const textClosed = rows.find((row) => row.poll_id === "free_text-closed");
      expect(database.prepare("SELECT text_results_json, more_terms FROM chat_votes WHERE poll_id = 'free_text-closed'").get())
        .toEqual({ text_results_json: fixtures.find(({ preset }) => preset === "free_text")?.results, more_terms: 1 });
      expect(textClosed?.kind).toBe("free_text");
    } finally {
      database.close();
    }
  });

  it("fills kind and marks old-worker inserts as legacy-written", () => {
    const database = createPreKindDatabase();
    try {
      database.exec(migration("0046_chat_voting_kind.sql"));
      database.prepare(`
        INSERT INTO chat_votes
          (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at, close_reason)
        VALUES ('trigger-channel', 'old-worker-poll', 'yes_no', 2, '["Yes","No"]', 'open', 'a', 'b', 'limit')
      `).run();
      expect(database.prepare(`
        SELECT kind, legacy_written FROM chat_votes WHERE channel_id = 'trigger-channel' AND poll_id = 'old-worker-poll'
      `).get()).toEqual({ kind: "yes_no", legacy_written: 1 });
    } finally {
      database.close();
    }
  });

  it("does not let a delayed legacy-close write touch the replacement vote", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await database.prepare(`
      INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
      VALUES ('race-channel', 'fictional-race', 'Fictional Race', 'now', 'now')
    `).bind().run();
    await database.prepare(`
      INSERT INTO chat_votes
        (channel_id, poll_id, kind, preset, legacy_written, option_count, labels_json,
         status, opened_at, closes_at, close_reason)
      VALUES ('race-channel', 'old-poll', 'options', 'digit_01', 1, 2, '["No","Yes"]',
              'open', '2026-10-04T10:00:00.000Z', '2026-10-04T14:00:00.000Z', 'limit')
    `).bind().run();

    const actual = createChatVotingRepository(database as unknown as D1Database);
    const repository: ChatVotingRepository = {
      ...actual,
      async requestManualClose(channelId, pollId, authorization, legacyOnly) {
        await database.prepare(`
          UPDATE chat_votes SET status = 'closed', closed_at = '2026-10-04T10:01:00.000Z',
            counts_json = '[0,0]', voter_count = 0
        WHERE channel_id = 'race-channel' AND poll_id = 'old-poll'
        `).bind().run();
        await database.prepare(`
          INSERT INTO chat_votes
            (channel_id, poll_id, kind, preset, legacy_written, option_count, labels_json,
             status, opened_at, closes_at, close_reason)
          VALUES ('race-channel', 'new-poll', 'yes_no', 'yes_no', 0, 2, '["Yes","No"]',
                  'open', '2026-10-04T10:02:00.000Z', '2026-10-04T14:02:00.000Z', 'limit')
        `).bind().run();
        return await actual.requestManualClose(channelId, pollId, authorization, legacyOnly);
      },
    };
    const scheduleClose = vi.fn(() => Promise.resolve());

    const result = await requestChatVoteClose(repository, "race-channel", scheduleClose, undefined, {
      pollId: "old-poll",
      legacyOnly: true,
    });

    expect(result).toBeNull();
    expect(scheduleClose).not.toHaveBeenCalled();
    await expect(database.prepare("SELECT status, close_reason FROM chat_votes WHERE poll_id = 'new-poll'").bind().first())
      .resolves.toEqual({ status: "open", close_reason: "limit" });
  });
});
