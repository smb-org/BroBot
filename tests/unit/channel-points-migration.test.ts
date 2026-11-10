import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("channel points migration", () => {
  it("creates reward and redemption tables with idempotency and panel resource revisions", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const name of readdirSync(migrationsDirectory)
        .filter((file) => file.endsWith(".sql") && file < "0089_channel_points.sql")
        .sort((left, right) => left.localeCompare(right))) {
        database.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
      }
      database.exec(readFileSync(resolve(migrationsDirectory, "0089_channel_points.sql"), "utf8"));
      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('channel_points', 'points_demo', 'Points Demo', '2026-11-10', '2026-11-10')`,
      ).run();
      database.prepare(
        `INSERT INTO channel_points_rewards (
           channel_id, id, twitch_reward_id, title, cost, is_user_input_required,
           action_module_id, action_id, action_config_json, mode, enabled, twitch_state, created_at, updated_at
         ) VALUES ('channel_points', 'reward_local', 'reward_twitch', 'Fictional reward', 10, 0,
           'channel_points', 'chat-message', '{"message":"Hi"}', 'auto', 1, 'active', 'now', 'now')`,
      ).run();
      database.prepare(
        `INSERT INTO channel_points_redemptions (
           channel_id, redemption_id, reward_id, reward_title, user_id, user_login, user_name,
           user_input, redeemed_at, status, created_at, updated_at
         ) VALUES ('channel_points', 'redemption_one', 'reward_local', 'Fictional reward',
           'viewer_one', 'viewer_demo', 'Viewer Demo', '', 'now', 'received', 'now', 'now')`,
      ).run();
      const before = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:channel_points:data'",
      ).get("channel_points") as { revision: number };
      expect(() => database.prepare(
        `INSERT INTO channel_points_redemptions (
           channel_id, redemption_id, reward_id, reward_title, user_id, user_login, user_name,
           user_input, redeemed_at, status, created_at, updated_at
         ) VALUES ('channel_points', 'redemption_one', 'reward_local', 'Fictional reward',
           'viewer_one', 'viewer_demo', 'Viewer Demo', '', 'now', 'received', 'now', 'now')`,
      ).run()).toThrow();
      database.prepare("UPDATE channel_points_rewards SET cost = 20 WHERE channel_id = 'channel_points'").run();
      const after = database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:channel_points:data'",
      ).get("channel_points") as { revision: number };
      expect(after.revision).toBe(before.revision + 1);
    } finally {
      database.close();
    }
  });
});
