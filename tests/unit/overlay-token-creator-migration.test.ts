import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("overlay token creator migration", () => {
  it("backfills creator IDs from issuance audit rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const file of readdirSync(migrationsDirectory).filter((name) => name < "0011_overlay_token_creator.sql").sort()) {
        database.exec(migration(file));
      }
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
        INSERT INTO overlay_tokens
          (token_id, channel_id, token_hash, created_at)
        VALUES ('token-a', 'channel-a', 'hash-a', '2026-09-24T00:00:00.000Z');
        INSERT INTO audit_log
          (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
        VALUES ('audit-a', 'creator-a', '2026-09-24T00:00:00.000Z', 'channel-a',
          'overlay.token.issued', '{}', '{"tokenId":"token-a"}');
      `);

      database.exec(migration("0011_overlay_token_creator.sql"));

      expect(database.prepare("SELECT created_by_user_id FROM overlay_tokens WHERE token_id = 'token-a'").get())
        .toEqual({ created_by_user_id: "creator-a" });
    } finally {
      database.close();
    }
  });
});
