import { describe, expect, it, vi } from "vitest";

import { textCommandModule, type TextCommandMinimumTier } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const JETZT = "2026-09-19T12:00:00.000Z";
const schluessel = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const fetcherForChat = () => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "gesendet-1" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
));

const koerper = (fetcher: ReturnType<typeof fetcherForChat>, index: number): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const environment = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: schluessel,
});

const eventFor = (text: string, channelId = "kanal-a", receivedAt = JETZT, triggerId = "trigger-1", badges: readonly { set_id: string }[] = []) => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId,
  payload: {
    message: { text },
    message_id: `chat-${triggerId}`,
    chatter_user_id: "user-1",
    chatter_user_login: "alice",
    broadcaster_user_login: channelId,
    badges,
  },
  receivedAt,
});

const activate = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
  ).bind(channelId, textCommandModule.id).run();
};

const createCommand = async (database: TestD1Database, name = "hallo", minimumTier: TextCommandMinimumTier = "everyone"): Promise<void> => {
  const repository = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] as const }),
  );
  await repository.anlegen({
    channelId: "kanal-a",
    name,
    text: "Hallo {user}",
    kind: "text",
    minimumTier: minimumTier,
    cooldownSeconds: 5,
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
  await insertAppAccessToken(
    database,
    await encryptJson({ token: "app-token" }, parseKeyRing(schluessel)),
    "2099-09-21T00:00:00.000Z",
    JETZT,
    JETZT,
  );
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
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!befehl hinzufuegen foo bar", "kanal-a", JETZT, "trigger-add"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!befehl entfernen foo", "kanal-a", JETZT, "trigger-remove"), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands").first<{ count: number }>())
        .resolves.toEqual({ count: 0 });
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.unbekannt", "text_commands.unbekannt"]);
    } finally {
      database.close();
    }
  });

  it("antwortet nur im Kanal, in dem der Befehl angelegt wurde", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await activate(database, "kanal-b");
      await createCommand(database);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", JETZT, "trigger-2"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-b", JETZT, "trigger-3"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(koerper(fetcher, 0).message).toBe("Hallo alice");
      await expect(eventCodes(database)).resolves.toContain("text_commands.unbekannt");
    } finally {
      database.close();
    }
  });

  it("antwortet bei einem unbekannten Befehl nicht im Chat", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!unbekannt"), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.unbekannt"]);
    } finally {
      database.close();
    }
  });

  it("schweigt beim zweiten Aufruf innerhalb der Abkühlzeit", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", JETZT, "trigger-2"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:01.000Z", "trigger-3"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(eventCodes(database)).resolves.toContain("text_commands.abgekuehlt");
    } finally {
      database.close();
    }
  });

  it("initialisiert den Listenbefehl beim Aktivieren des Moduls", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await textCommandModule.onEnable?.({
        DB: database as unknown as D1Database,
        authorizeMutation: () => ({ sql: "AND 1 = 1", values: [] as const }),
        actor: { userId: "user-1" },
        now: JETZT,
      }, "kanal-a");

      await expect(database.prepare(
        "SELECT command_name, response_text, kind, enabled FROM text_commands",
      ).all()).resolves.toEqual({
        results: [{ command_name: "befehle", response_text: "", kind: "list", enabled: 1 }],
        success: true,
        meta: { changes: 0, size: 0 },
      });
    } finally {
      database.close();
    }
  });

  it("löst einen ausgeschalteten Befehl nicht aus und begründet das im Ereignisprotokoll", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      await database.prepare("UPDATE text_commands SET enabled = 0 WHERE command_name = 'hallo'").run();
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", JETZT, "trigger-disabled-broadcaster", [{ set_id: "broadcaster" }]), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.deaktiviert"]);
    } finally {
      database.close();
    }
  });

  it("lässt Moderatoren einen Moderator-Befehl auslösen und schweigt bei Zuschauern mit Diagnose", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "hallo", "moderator");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", JETZT, "trigger-moderator", [{ set_id: "moderator" }]), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:01.000Z", "trigger-viewer"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const denied = await database.prepare(
        "SELECT code, detail_json FROM event_log WHERE code = 'text_commands.berechtigung'",
      ).first<{ code: string; detail_json: string }>();
      expect(denied?.code).toBe("text_commands.berechtigung");
      expect(JSON.parse(denied?.detail_json ?? "{}" )).toEqual({
        name: "hallo", geforderteStufe: "moderator", vorhandeneStufe: ["viewer"],
      });
    } finally {
      database.close();
    }
  });

  it("wertet Moderatoren ohne Abo und Founder als Abonnenten", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "hallo", "subscriber");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", JETZT, "trigger-moderator", [{ set_id: "moderator" }]), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:06.000Z", "trigger-founder", [{ set_id: "founder" }]), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("listet nur eingeschaltete Befehle", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] as const }),
      );
      await repository.anlegen({ channelId: "kanal-a", name: "befehle", text: "", kind: "list", cooldownSeconds: 5, now: JETZT }, { userId: "user-1" });
      await repository.anlegen({ channelId: "kanal-a", name: "aktiv", text: "Antwort", kind: "text", cooldownSeconds: 5, now: JETZT }, { userId: "user-1" });
      await repository.anlegen({ channelId: "kanal-a", name: "aus", text: "Antwort", kind: "text", cooldownSeconds: 5, now: JETZT }, { userId: "user-1" });
      await database.prepare("UPDATE text_commands SET enabled = 0 WHERE command_name = 'aus'").run();
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!befehle"), fetcher, [textCommandModule]);

      expect(koerper(fetcher, 0).message).toBe("Befehle: !aktiv, !befehle");
    } finally {
      database.close();
    }
  });
});
