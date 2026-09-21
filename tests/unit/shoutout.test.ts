import { describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/auth/repository";
import { sendShoutout } from "../../src/worker/shoutout";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const SCHLUESSEL = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const umgebung = (database: TestD1Database, keys = SCHLUESSEL) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TOKEN_ENCRYPTION_KEYS: keys,
});

const botEinrichten = async (database: TestD1Database, ciphertext = "lesbar"): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[\"moderator:manage:shoutouts\"]",
    accessTokenCiphertext: ciphertext,
    refreshTokenCiphertext: ciphertext,
    expiresAt: "2026-09-20T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
};

describe("Helix-Shoutout", () => {
  it("sendet einen Shoutout mit Bot-Identität und Zielparametern", async () => {
    const database = new TestD1Database();
    try {
      await botEinrichten(database, await encryptJson({ token: "bot-token" }, parseKeyRing(SCHLUESSEL)));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

      await expect(sendShoutout(umgebung(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: true,
        reason: null,
      });
      expect(fetcher).toHaveBeenCalledWith(
        "https://api.twitch.tv/helix/chat/shoutouts?from_broadcaster_id=kanal-a&to_broadcaster_id=quelle-1&moderator_id=bot-1",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Client-ID": "client-id",
            Authorization: "Bearer bot-token",
          },
        }),
      );
    } finally {
      database.close();
    }
  });

  it("meldet die Twitch-Sperre als rate_limited", async () => {
    const database = new TestD1Database();
    try {
      await botEinrichten(database, await encryptJson({ token: "bot-token" }, parseKeyRing(SCHLUESSEL)));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "slow down" }), { status: 429 }));

      await expect(sendShoutout(umgebung(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: false,
        reason: "rate_limited",
        detail: { status: 429 },
      });
    } finally {
      database.close();
    }
  });

  it("meldet ein unlesbares Bot-Token ohne Helix-Aufruf", async () => {
    const database = new TestD1Database();
    try {
      await botEinrichten(database);
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendShoutout(umgebung(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: false,
        reason: "bot_token_unreadable",
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
