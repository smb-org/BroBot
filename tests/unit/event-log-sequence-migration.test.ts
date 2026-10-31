import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationName = "0087_event_log_sequence.sql";
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

const applyPriorMigrations = (database: DatabaseSync): void => {
  const previousMigrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < migrationName)
    .sort((left, right) => left.localeCompare(right));
  for (const migration of previousMigrations) database.exec(readMigration(migration));
};

const insertChannel = (database: DatabaseSync, channelId = "channel-a"): void => {
  database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 'now', 'now')`,
  ).run(channelId, channelId, channelId);
};

const insertEvent = (database: DatabaseSync, eventId: string, moduleId = "raid"): void => {
  database.prepare(
    `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id)
     VALUES (?, 'channel-a', '2026-01-01T00:00:00.000Z', ?, 'test', '{}', NULL, ?)`,
  ).run(eventId, moduleId, eventId);
};

describe("event log sequence migration", () => {
  it("preserves rows in rowid order and assigns larger sequence values to new rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyPriorMigrations(database);
      insertChannel(database);
      insertEvent(database, "first");
      insertEvent(database, "second");
      insertEvent(database, "third");
      const oldIds = (database.prepare("SELECT event_id FROM event_log ORDER BY rowid").all() as Array<{ event_id: string }>)
        .map((row) => row.event_id);

      database.exec(readMigration(migrationName));
      const rows = database.prepare("SELECT event_id, seq FROM event_log ORDER BY seq").all() as Array<{ event_id: string; seq: number }>;
      insertEvent(database, "fourth");
      const fourth = database.prepare("SELECT seq FROM event_log WHERE event_id = 'fourth'").get() as { seq: number };

      expect(rows.map((row) => row.event_id)).toEqual(oldIds);
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
      expect(fourth.seq).toBeGreaterThan(3);
    } finally {
      database.close();
    }
  });

  it("does not reuse a deleted maximum sequence after deleting the maximum or every row", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyPriorMigrations(database);
      insertChannel(database);
      database.exec(readMigration(migrationName));
      insertEvent(database, "one");
      insertEvent(database, "two");
      const maximum = database.prepare("SELECT MAX(seq) AS seq FROM event_log").get() as { seq: number };
      database.prepare("DELETE FROM event_log WHERE event_id = 'two'").run();
      insertEvent(database, "three");
      const afterMaximumDelete = database.prepare("SELECT seq FROM event_log WHERE event_id = 'three'").get() as { seq: number };
      database.exec("DELETE FROM event_log");
      insertEvent(database, "four");
      const afterAllDelete = database.prepare("SELECT seq FROM event_log WHERE event_id = 'four'").get() as { seq: number };

      expect(afterMaximumDelete.seq).toBeGreaterThan(maximum.seq);
      expect(afterAllDelete.seq).toBeGreaterThan(afterMaximumDelete.seq);
    } finally {
      database.close();
    }
  });

  it("keeps resource revision triggers, retention suppression, ads revisions and channel cascades", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyPriorMigrations(database);
      insertChannel(database);
      database.exec(readMigration(migrationName));

      insertEvent(database, "ads-event", "ads");
      const afterInsert = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'channel.events'",
      ).get() as { revision: number };
      const adsAfterInsert = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'module:ads:schedule'",
      ).get() as { revision: number };
      database.prepare("DELETE FROM event_log WHERE event_id = 'ads-event'").run();
      const afterDelete = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'channel.events'",
      ).get() as { revision: number };
      const adsAfterDelete = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'module:ads:schedule'",
      ).get() as { revision: number };

      insertEvent(database, "retained");
      database.prepare(
        "INSERT INTO panel_event_log_retention_resources (channel_id, resource) VALUES ('channel-a', 'channel.events')",
      ).run();
      database.prepare("DELETE FROM event_log WHERE event_id = 'retained'").run();
      const afterRetentionDelete = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'channel.events'",
      ).get() as { revision: number };
      database.prepare("DELETE FROM panel_event_log_retention_resources WHERE channel_id = 'channel-a'").run();

      insertEvent(database, "cascade");
      database.prepare("DELETE FROM channels WHERE channel_id = 'channel-a'").run();
      const remaining = database.prepare("SELECT COUNT(*) AS count FROM event_log").get() as { count: number };

      expect(afterInsert.revision).toBe(1);
      expect(adsAfterInsert.revision).toBe(1);
      expect(afterDelete.revision).toBe(2);
      expect(adsAfterDelete.revision).toBe(2);
      expect(afterRetentionDelete.revision).toBe(3);
      expect(remaining.count).toBe(0);
    } finally {
      database.close();
    }
  });

  it("uses the channel sequence index for the high-water and delta queries", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyPriorMigrations(database);
      insertChannel(database);
      database.exec(readMigration(migrationName));
      const plans = [
        database.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(MAX(seq), 0) FROM event_log WHERE channel_id = ?").all("channel-a"),
        database.prepare("EXPLAIN QUERY PLAN SELECT seq, event_id FROM event_log WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?").all("channel-a", 0, 101),
      ] as Array<Array<{ detail: string }>>;

      expect(plans.map((plan) => plan.map((row) => row.detail).join(" ")).every((detail) =>
        detail.includes("event_log_channel_seq_idx"),
      )).toBe(true);
    } finally {
      database.close();
    }
  });
});
