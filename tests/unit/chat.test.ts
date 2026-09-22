import { describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { sendChatMessage } from "../../src/worker/chat";
import { insertAppAccessToken } from "./fixtures";
import { TestD1Database } from "./test-d1";

const SCHLUESSEL = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const environment = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: SCHLUESSEL,
});

const seedBot = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: "unlesbare-bot-chiffre",
    refreshTokenCiphertext: "unlesbare-refresh-chiffre",
    expiresAt: "2026-09-20T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  const appTokenCiphertext = await encryptJson({ token: "app-token" }, parseKeyRing(SCHLUESSEL));
  await insertAppAccessToken(
    database,
    appTokenCiphertext,
    "2099-09-21T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z",
  );
};

describe("Helix-Chat", () => {
  it("sendet mit App-Token, Bot-ID, Kanal-ID und for_source_only false", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        data: [{ is_sent: true, message_id: "nachricht-1" }],
      }), { status: 200 }));

      await expect(sendChatMessage(environment(database), "kanal-a", "hallo", undefined, fetcher)).resolves.toMatchObject({
        sent: true,
        reason: null,
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(url).toBe("https://api.twitch.tv/helix/chat/messages");
      expect(init?.headers).toEqual({
        "Client-ID": "client-id",
        Authorization: "Bearer app-token",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>).toEqual({
        broadcaster_id: "kanal-a",
        sender_id: "bot-1",
        message: "hallo",
        for_source_only: false,
      });
    } finally {
      database.close();
    }
  });

  /**
   * Der Aufruf wird im EventSub-Webhook abgewartet, und Twitch erwartet dort
   * eine Antwort in zehn Sekunden. Ohne Zeitlimit kostet ein haengender
   * Helix-Aufruf das Abo -- ein Ausfall, den niemand meldet.
   */
  it("gibt dem Helix-Aufruf ein Zeitlimit mit und meldet es getrennt vom Netzfehler", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database);
      const timeoutError = Object.assign(new Error("abgelaufen"), { name: "TimeoutError" });
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(timeoutError);

      await expect(sendChatMessage(environment(database), "kanal-a", "hallo", undefined, fetcher))
        .resolves.toMatchObject({ sent: false, reason: "timeout" });

      const [, init] = fetcher.mock.calls[0] ?? [];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      database.close();
    }
  });

  it("unterscheidet einen Netzfehler weiterhin vom Zeitlimit", async () => {
    const database = new TestD1Database();
    try {
      await seedBot(database);
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("kein Netz"));

      await expect(sendChatMessage(environment(database), "kanal-a", "hallo", undefined, fetcher))
        .resolves.toMatchObject({ sent: false, reason: "network_error" });
    } finally {
      database.close();
    }
  });
});
