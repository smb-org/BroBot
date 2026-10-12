import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("channel module initialization migration", () => {
  it("marks previously enabled rows initialized and leaves never-enabled rows pending", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration("0000_baseline.sql"));
      const insertChannel = database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES (?, ?, ?, '2026-10-12', '2026-10-12')`,
      );
      const insertModule = database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'test', ?, ?)",
      );
      const insertAudit = database.prepare(
        `INSERT INTO audit_log
          (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json, module_id)
         VALUES (?, 'user-1', '2026-10-12', ?, ?, ?, '{}', 'test')`,
      );
      for (const channelId of ["active", "previously-enabled", "default-enabled", "never-enabled"]) {
        insertChannel.run(channelId, channelId, channelId);
      }
      insertModule.run("active", 1, '{"custom":"active"}');
      insertModule.run("previously-enabled", 0, '{"custom":"preserve"}');
      insertModule.run("default-enabled", 0, '{"custom":"default"}');
      insertModule.run("never-enabled", 0, '{"custom":"never"}');
      insertAudit.run("audit-enabled", "previously-enabled", "module.enabled", "null");
      insertAudit.run("audit-default-disabled", "default-enabled", "module.disabled", '{"enabled":true}');
      insertAudit.run("audit-never-disabled", "never-enabled", "module.disabled", '{"enabled":false}');

      database.exec(migration("0054_channel_module_initialization.sql"));

      expect(database.prepare(
        "SELECT channel_id, initialized FROM channel_modules ORDER BY channel_id",
      ).all()).toEqual([
        { channel_id: "active", initialized: 1 },
        { channel_id: "default-enabled", initialized: 1 },
        { channel_id: "never-enabled", initialized: 0 },
        { channel_id: "previously-enabled", initialized: 1 },
      ]);
      expect(database.prepare(
        "SELECT settings FROM channel_modules WHERE channel_id = 'previously-enabled'",
      ).get()).toEqual({ settings: '{"custom":"preserve"}' });
    } finally {
      database.close();
    }
  });
});
