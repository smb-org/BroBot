import { describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { sendShoutout } from "../../src/worker/shoutout";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const KEY_RING = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const environment = (database: TestD1Database, keys = KEY_RING) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: keys,
});

const seedBot = async (database: TestD1Database, ciphertext = "lesbar"): Promise<void> => {
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
  const setUpAppToken = async (database: TestD1Database): Promise<void> => {
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(KEY_RING)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z",
    );
  };

  it("sendet einen Shoutout mit App-Token, Bot-ID und Zielparametern", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database, "unlesbare-bot-chiffre");
      await setUpAppToken(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

      await expect(sendShoutout(environment(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: true,
        reason: null,
      });
      expect(fetcher).toHaveBeenCalledWith(
        "https://api.twitch.tv/helix/chat/shoutouts?from_broadcaster_id=kanal-a&to_broadcaster_id=quelle-1&moderator_id=bot-1",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Client-ID": "client-id",
            Authorization: "Bearer app-token",
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
      await seedBot(database, await encryptJson({ token: "bot-token" }, parseKeyRing(KEY_RING)));
      await setUpAppToken(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "slow down" }), { status: 429 }));

      await expect(sendShoutout(environment(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: false,
        reason: "rate_limited",
        detail: { status: 429 },
      });
    } finally {
      database.close();
    }
  });

  it("meldet ein nicht beschaffbares App-Token ohne Helix-Aufruf", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database, "unlesbare-bot-chiffre");
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("App-Token nicht erreichbar"));

      await expect(sendShoutout(environment(database), "kanal-a", "quelle-1", fetcher)).resolves.toMatchObject({
        sent: false,
        reason: "app_token_unavailable",
      });
      expect(fetcher).toHaveBeenCalledWith("https://id.twitch.tv/oauth2/token", expect.anything());
    } finally {
      database.close();
    }
  });

  /** Wie beim Chat: der Aufruf wird im Webhook abgewartet, Twitch gibt zehn Sekunden. */
  it("gibt dem Helix-Aufruf ein Zeitlimit mit und meldet es getrennt vom Netzfehler", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database, "unlesbare-bot-chiffre");
      await setUpAppToken(database);
      const timeoutError = Object.assign(new Error("abgelaufen"), { name: "TimeoutError" });
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(timeoutError);

      await expect(sendShoutout(environment(database), "kanal-a", "ziel-1", fetcher))
        .resolves.toMatchObject({ sent: false, reason: "timeout" });

      const [, init] = fetcher.mock.calls[0] ?? [];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      database.close();
    }
  });
});
