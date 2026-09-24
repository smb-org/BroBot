import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("stream-scoped controls migration", () => {
  it("binds controls to a recorded live session and leaves unbound controls pending", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const name of [
        "0000_baseline.sql",
        "0001_eventsub_maintenance_locks.sql",
        "0002_text_command_options.sql",
        "0003_text_command_kinds.sql",
        "0004_channel_controls.sql",
        "0005_clips_default_on.sql",
        "0006_stream_started_at.sql",
        "0007_audit_log_filter_indexes.sql",
        "0008_configuration_revisions_and_alias_index.sql",
        "0009_channel_variables.sql",
      ]) database.exec(migration(name));

      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES
          ('live-channel', 'live-channel', 'Live', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
          ('offline-channel', 'offline-channel', 'Offline', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
          ('unknown-channel', 'unknown-channel', 'Unknown', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
        VALUES
          ('live-channel', 'online', '2026-09-23T09:00:00.000Z', 'eventsub', '2026-09-23T08:00:00.000Z'),
          ('offline-channel', 'offline', '2026-09-23T09:00:00.000Z', 'eventsub', NULL);
        INSERT INTO channel_controls
          (channel_id, muted, mute_until_stream_end, paused, pause_until_stream_end, updated_at)
        VALUES
          ('live-channel', 1, 1, 1, 1, '2026-09-23T08:30:00.000Z'),
          ('offline-channel', 1, 1, 0, 0, '2026-09-23T08:30:00.000Z'),
          ('unknown-channel', 0, 0, 1, 1, '2026-09-23T08:30:00.000Z');
      `);
      database.exec(migration("0010_stream_scoped_controls.sql"));

      expect(database.prepare(
        `SELECT channel_id, muted, mute_until_stream_end, mute_stream_started_at,
                paused, pause_until_stream_end, pause_stream_started_at
           FROM channel_controls ORDER BY channel_id`,
      ).all()).toEqual([
        {
          channel_id: "live-channel", muted: 1, mute_until_stream_end: 1,
          mute_stream_started_at: "2026-09-23T08:00:00.000Z",
          paused: 1, pause_until_stream_end: 1, pause_stream_started_at: "2026-09-23T08:00:00.000Z",
        },
        {
          channel_id: "offline-channel", muted: 1, mute_until_stream_end: 1,
          mute_stream_started_at: null,
          paused: 0, pause_until_stream_end: 0, pause_stream_started_at: null,
        },
        {
          channel_id: "unknown-channel", muted: 0, mute_until_stream_end: 0,
          mute_stream_started_at: null,
          paused: 1, pause_until_stream_end: 1, pause_stream_started_at: null,
        },
      ]);
      expect(database.prepare(
        `SELECT channel_id, checked_at, eventsub_changed_at
           FROM channel_stream_state ORDER BY channel_id`,
      ).all()).toEqual([
        { channel_id: "live-channel", checked_at: "2026-09-23T09:00:00.000Z", eventsub_changed_at: "2026-09-23T09:00:00.000Z" },
        { channel_id: "offline-channel", checked_at: "2026-09-23T09:00:00.000Z", eventsub_changed_at: "2026-09-23T09:00:00.000Z" },
      ]);
    } finally {
      database.close();
    }
  });
});
