import { describe, expect, it, vi } from "vitest";

import { textbefehlModul } from "../../src/modules/textbefehle";
import { createTextbefehlRepository } from "../../src/modules/textbefehle/adapters/d1";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { upsertBotIdentity } from "../../src/worker/auth/repository";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const JETZT = "2026-09-19T12:00:00.000Z";
const schluessel = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const fetcherFuerChat = () => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "gesendet-1" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
));

const koerper = (fetcher: ReturnType<typeof fetcherFuerChat>, index: number): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const umgebung = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TOKEN_ENCRYPTION_KEYS: schluessel,
});

const eventFuer = (text: string, channelId = "kanal-a", receivedAt = JETZT, triggerId = "trigger-1") => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId,
  payload: {
    message: { text },
    message_id: `chat-${triggerId}`,
    chatter_user_id: "user-1",
    chatter_user_login: "alice",
    broadcaster_user_login: channelId,
  },
  receivedAt,
});

const aktiviere = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
  ).bind(channelId, textbefehlModul.id).run();
};

const legeBefehlAn = async (database: TestD1Database, name = "hallo"): Promise<void> => {
  const repository = createTextbefehlRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] as const }),
  );
  await repository.anlegen({
    channelId: "kanal-a",
    name,
    text: "Hallo {user}",
    cooldownSekunden: 5,
    now: JETZT,
  }, { userId: "user-1" });
};

const mitBot = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(schluessel)),
    refreshTokenCiphertext: await encryptJson({ token: "refresh" }, parseKeyRing(schluessel)),
    expiresAt: "2026-09-20T00:00:00.000Z",
    createdAt: JETZT,
    updatedAt: JETZT,
  });
};

const eventCodes = async (database: TestD1Database): Promise<string[]> => {
  const result = await database.prepare("SELECT code FROM event_log ORDER BY rowid").all<{ code: string }>();
  return result.results.map((entry) => entry.code);
};

describe("Textbefehle-Modul", () => {
  it("behandelt entfallene Änderungsbefehle als unbekannt und ändert keine Moduldaten", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "bediener");
      await mitBot(database);
      await aktiviere(database, "kanal-a");
      const fetcher = fetcherFuerChat();

      await dispatchEventSubNotification(umgebung(database), eventFuer("!befehl hinzufuegen foo bar", "kanal-a", JETZT, "trigger-add"), fetcher, [textbefehlModul]);
      await dispatchEventSubNotification(umgebung(database), eventFuer("!befehl entfernen foo", "kanal-a", JETZT, "trigger-remove"), fetcher, [textbefehlModul]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(database.prepare("SELECT COUNT(*) AS count FROM textbefehle_commands").first<{ count: number }>())
        .resolves.toEqual({ count: 0 });
      await expect(eventCodes(database)).resolves.toEqual(["textbefehle.unbekannt", "textbefehle.unbekannt"]);
    } finally {
      database.close();
    }
  });

  it("antwortet nur im Kanal, in dem der Befehl angelegt wurde", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await insertMember(database, "kanal-a", "user-1", "bediener");
      await mitBot(database);
      await aktiviere(database, "kanal-a");
      await aktiviere(database, "kanal-b");
      await legeBefehlAn(database);
      const fetcher = fetcherFuerChat();

      await dispatchEventSubNotification(umgebung(database), eventFuer("!hallo", "kanal-a", JETZT, "trigger-2"), fetcher, [textbefehlModul]);
      await dispatchEventSubNotification(umgebung(database), eventFuer("!hallo", "kanal-b", JETZT, "trigger-3"), fetcher, [textbefehlModul]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(koerper(fetcher, 0).message).toBe("Hallo alice");
      await expect(eventCodes(database)).resolves.toContain("textbefehle.unbekannt");
    } finally {
      database.close();
    }
  });

  it("antwortet bei einem unbekannten Befehl nicht im Chat", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "bediener");
      await mitBot(database);
      await aktiviere(database, "kanal-a");
      const fetcher = fetcherFuerChat();

      await dispatchEventSubNotification(umgebung(database), eventFuer("!unbekannt"), fetcher, [textbefehlModul]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(eventCodes(database)).resolves.toEqual(["textbefehle.unbekannt"]);
    } finally {
      database.close();
    }
  });

  it("schweigt beim zweiten Aufruf innerhalb der Abkühlzeit", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "bediener");
      await mitBot(database);
      await aktiviere(database, "kanal-a");
      await legeBefehlAn(database);
      const fetcher = fetcherFuerChat();

      await dispatchEventSubNotification(umgebung(database), eventFuer("!hallo", "kanal-a", JETZT, "trigger-2"), fetcher, [textbefehlModul]);
      await dispatchEventSubNotification(umgebung(database), eventFuer("!hallo", "kanal-a", "2026-09-19T12:00:01.000Z", "trigger-3"), fetcher, [textbefehlModul]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(eventCodes(database)).resolves.toContain("textbefehle.abgekuehlt");
    } finally {
      database.close();
    }
  });
});
