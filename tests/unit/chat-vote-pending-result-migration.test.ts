import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0071_chat_vote_pending_result_delivery.sql"), "utf8");

describe("chat vote pending result delivery migration", () => {
  it("records every legacy closed result as a reconciliation candidate", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE chat_votes (
          channel_id TEXT NOT NULL,
          poll_id TEXT NOT NULL,
          status TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          result_text TEXT,
          PRIMARY KEY (channel_id, poll_id)
        ) WITHOUT ROWID;
        CREATE TABLE panel_resource_dependencies (
          source_table TEXT NOT NULL,
          resource TEXT NOT NULL,
          PRIMARY KEY (source_table, resource)
        ) WITHOUT ROWID;
        INSERT INTO chat_votes VALUES
          ('announced', 'older-closed', 'closed', '2026-10-16T09:00:00.000Z', 'Older {text.a}'),
          ('announced', 'retrying-closed', 'closed', '2026-10-16T10:00:00.000Z', 'Retry {text.a}'),
          ('announced', 'newer-open', 'open', '2026-10-16T11:00:00.000Z', 'Open {text.b}'),
          ('silent', 'silent-closed', 'closed', '2026-10-16T10:00:00.000Z', 'Silent {text.a}'),
          ('announced', 'empty-result', 'closed', '2026-10-16T12:00:00.000Z', '');
      `);

      database.exec(migration);

      expect(database.prepare(
        "SELECT channel_id, poll_id, result_delivery_pending FROM chat_votes ORDER BY channel_id, opened_at",
      ).all()).toEqual([
        { channel_id: "announced", poll_id: "older-closed", result_delivery_pending: 1 },
        { channel_id: "announced", poll_id: "retrying-closed", result_delivery_pending: 1 },
        { channel_id: "announced", poll_id: "newer-open", result_delivery_pending: 0 },
        { channel_id: "announced", poll_id: "empty-result", result_delivery_pending: 0 },
        { channel_id: "silent", poll_id: "silent-closed", result_delivery_pending: 1 },
      ]);
      expect(database.prepare(
        "SELECT channel_id, poll_id FROM chat_vote_result_delivery_reconciliation ORDER BY channel_id, poll_id",
      ).all()).toEqual([
        { channel_id: "announced", poll_id: "older-closed" },
        { channel_id: "announced", poll_id: "retrying-closed" },
        { channel_id: "silent", poll_id: "silent-closed" },
      ]);
    } finally {
      database.close();
    }
  });
});
