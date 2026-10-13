import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { purgeExpiredGameSearchCache, writeCachedGameList } from "../../src/worker/db/game-search-cache";
import { TestD1Database } from "./test-d1";

describe("game search cache retention", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("deletes expired rows in bounded batches", async () => {
    for (let index = 0; index < 300; index += 1) {
      await database.prepare(
        `INSERT INTO twitch_game_search_cache (cache_key, games_json, expires_at_ms, updated_at_ms)
         VALUES (?, '[]', 10, 0)`,
      ).bind(`expired:${String(index)}`).run();
    }

    await writeCachedGameList(database as unknown as D1Database, "search:current", [], 10);
    const afterOneBatch = await database.prepare(
      "SELECT COUNT(*) AS count FROM twitch_game_search_cache WHERE expires_at_ms <= 10",
    ).first<{ count: number }>();
    expect(afterOneBatch?.count).toBe(50);

    await purgeExpiredGameSearchCache(database as unknown as D1Database, 10);
    const afterTwoBatches = await database.prepare(
      "SELECT COUNT(*) AS count FROM twitch_game_search_cache WHERE expires_at_ms <= 10",
    ).first<{ count: number }>();
    expect(afterTwoBatches?.count).toBe(0);
  });

  it("keeps the retained cache within its entry limit", async () => {
    database.sqlite.exec(`
      WITH RECURSIVE entries(id) AS (
        SELECT 1
        UNION ALL
        SELECT id + 1 FROM entries WHERE id < 2001
      )
      INSERT INTO twitch_game_search_cache (cache_key, games_json, expires_at_ms, updated_at_ms)
      SELECT 'search:' || id, '[]', 5000, id FROM entries;
    `);

    await purgeExpiredGameSearchCache(database as unknown as D1Database, 1000);
    const retained = await database.prepare(
      "SELECT COUNT(*) AS count FROM twitch_game_search_cache WHERE expires_at_ms > 1000",
    ).first<{ count: number }>();
    expect(retained?.count).toBe(2000);
  });
});
