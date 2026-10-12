import { describe, expect, it } from "vitest";

import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("FAQ person cooldown migration", () => {
  it("defaults per-person cooldowns to disabled and keys cooldown rows by channel, entry, and user", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await insertChannel(database, "channel-b");
      await database.prepare(
        `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
         VALUES ('entry-1', 'channel-a', 'A', '{"type":"keywords","patterns":["a"]}', 'A', ?, ?),
                ('entry-1', 'channel-b', 'B', '{"type":"keywords","patterns":["b"]}', 'B', ?, ?)`,
      ).bind("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:00.000Z", "2026-09-19T12:00:00.000Z", "2026-09-19T12:00:00.000Z").run();

      await expect(database.prepare("SELECT user_cooldown_seconds FROM faq_entries ORDER BY channel_id")
        .all<{ user_cooldown_seconds: number }>()).resolves.toMatchObject({
        results: [{ user_cooldown_seconds: 0 }, { user_cooldown_seconds: 0 }],
      });

      await database.prepare(
        `INSERT INTO faq_entry_user_cooldowns (channel_id, faq_id, user_id, last_used_at)
         VALUES ('channel-a', 'entry-1', 'viewer-1', '2026-09-19T12:00:00.000Z'),
                ('channel-b', 'entry-1', 'viewer-1', '2026-09-19T12:00:00.000Z')`,
      ).run();
      await expect(database.prepare(
        `INSERT INTO faq_entry_user_cooldowns (channel_id, faq_id, user_id, last_used_at)
         VALUES ('channel-a', 'entry-1', 'viewer-1', '2026-09-19T12:01:00.000Z')`,
      ).run()).rejects.toThrow();
    } finally {
      database.close();
    }
  });
});
