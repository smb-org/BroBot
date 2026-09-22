import { describe, expect, it, vi } from "vitest";

import { raidModule } from "../../src/modules/raid";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const KEY_RING = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const jsonRecord = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};

describe("Raid dispatch", () => {
  it("sends the full chat text despite a failed shoutout", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await upsertBotIdentity(database as unknown as D1Database, {
        id: 1,
        userId: "bot-1",
        login: "brobot",
        scopesJson: "[]",
        accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(KEY_RING)),
        refreshTokenCiphertext: await encryptJson({ token: "refresh" }, parseKeyRing(KEY_RING)),
        expiresAt: "2026-09-20T00:00:00.000Z",
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      });
      await insertAppAccessToken(
        database,
        await encryptJson({ token: "app-token" }, parseKeyRing(KEY_RING)),
        "2099-09-21T00:00:00.000Z",
        "2026-09-19T00:00:00.000Z",
        "2026-09-19T00:00:00.000Z",
      );
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, ?)",
      ).bind("kanal-a", raidModule.id, JSON.stringify(raidModule.defaultSettings)).run();

      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "gesperrt" }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification({
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
        TOKEN_ENCRYPTION_KEYS: KEY_RING,
      }, {
        channelId: "kanal-a",
        subscriptionType: "channel.raid",
        subscriptionVariant: "incoming",
        triggerId: "raid-trigger",
        payload: {
          from_broadcaster_user_id: "quelle-1",
          from_broadcaster_user_login: "quelle",
          to_broadcaster_user_id: "kanal-a",
          viewers: 8,
        },
        receivedAt: "2026-09-20T10:00:00.000Z",
      }, fetcher, [raidModule]);

      expect(fetcher).toHaveBeenCalledTimes(2);
      const rows = await database.prepare("SELECT code, detail_json FROM event_log ORDER BY rowid").all<{ code: string; detail_json: string }>();
      expect(rows.results.map((row) => row.code)).toEqual([
        "raid.shoutout",
        "host.shoutout.fehlgeschlagen",
        "host.chat.gesendet",
      ]);
      expect(jsonRecord(rows.results[1]?.detail_json ?? "{}")).toMatchObject({ cause: "rate_limited", status: 429 });
      expect(jsonRecord(rows.results[2]?.detail_json ?? "{}").text).toEqual(expect.stringContaining("quelle"));
    } finally {
      database.close();
    }
  });
});
