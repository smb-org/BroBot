import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/0101_song_requests_chapters.sql"), "utf8");

describe("song request chapter migration", () => {
  it("adds channel scoped chapters and preserves a chapter name snapshot after deletion", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY);
        CREATE TABLE song_requests_votes (
          ballot_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, request_id TEXT, vote_kind TEXT NOT NULL DEFAULT 'song'
        );
        CREATE TABLE song_requests (channel_id TEXT NOT NULL, stream_id TEXT, state TEXT NOT NULL, observed_at TEXT);
        CREATE TABLE panel_resource_dependencies (
          source_table TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY (source_table, resource)
        );
        CREATE TABLE panel_resource_revisions (
          channel_id TEXT NOT NULL, resource TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY (channel_id, resource)
        );
        INSERT INTO channels (channel_id) VALUES ('fictional-channel');
      `);
      database.exec(migration);

      database.prepare(`INSERT INTO song_requests_chapters
        (channel_id, id, name, tracks_json, offer_in_cockpit, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
        "fictional-channel", "chapter-one", "Night Drive", "[]", 1,
        "2026-11-18T10:00:00.000Z", "2026-11-18T10:00:00.000Z",
      );
      database.prepare(`INSERT INTO song_requests_votes
        (ballot_id, channel_id, request_id, chapter_id, chapter_name_snapshot)
        VALUES (?, ?, ?, ?, ?)`).run("ballot-one", "fictional-channel", "request-one", "chapter-one", "Night Drive");
      database.prepare("DELETE FROM song_requests_chapters WHERE channel_id = ? AND id = ?")
        .run("fictional-channel", "chapter-one");

      expect(database.prepare("SELECT chapter_id, chapter_name_snapshot FROM song_requests_votes WHERE ballot_id = ?")
        .get("ballot-one")).toEqual({ chapter_id: "chapter-one", chapter_name_snapshot: "Night Drive" });
      expect(database.prepare("SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = ?")
        .get("fictional-channel", "module:song_requests:chapters")).toEqual({ revision: 2 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("song_requests_recap_idx")).toEqual({ name: "song_requests_recap_idx" });
    } finally {
      database.close();
    }
  });
});
