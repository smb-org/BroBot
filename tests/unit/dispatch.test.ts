import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule, ModuleEvent, ModuleResult } from "../../src/modules/contract";
import { dispatchEventSubNotification, selectModulesForEvent } from "../../src/worker/dispatch";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHAT_TYP = "channel.chat.message";
const JETZT = "2026-09-19T12:00:00.000Z";
const schluessel = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

/**
 * Ein Modul-Doppel. `MODULES` ist leer, und die Tests dürfen nicht
 * voraussetzen, dass es je ein echtes Modul gibt.
 */
const modulDoppel = (
  id: string,
  handleEvent: (event: ModuleEvent) => ModuleResult | Promise<ModuleResult>,
  eventSubTypes: readonly string[] = [CHAT_TYP],
): BotModule => ({
  id,
  settingsSchema: z.object({ praefix: z.string() }),
  defaultSettings: { praefix: "!" },
  eventSubTypes,
  handleEvent,
});

const stilles = (id: string) => modulDoppel(id, () => ({ actions: [], diagnostics: [] }));

const aktivierung = (moduleId: string, enabled = true, settings = '{"praefix":"!"}') =>
  ({ moduleId, enabled, settings });

const umgebung = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: schluessel,
});

const chatAntwort = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

/** Liest den JSON-Körper eines Chat-Aufrufs, ohne blind zu casten. */
const koerperVon = (fetcher: ReturnType<typeof chatAntwort>, index = 0): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const gesendet = () => chatAntwort({ data: [{ is_sent: true, message_id: "nachricht-1" }] });

const mitBot = async (database: TestD1Database): Promise<void> => {
  await insertChannel(database, "kanal-a");
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

const protokoll = async (database: TestD1Database) => {
  const result = await database.prepare(
    "SELECT module_id, code, detail_json FROM event_log ORDER BY rowid",
  ).all<{ module_id: string; code: string; detail_json: string }>();
  return result.results;
};

/** Trägt jedes Registry-Modul als aktiviert ein; die Verteilung liest aus der Datenbank. */
const aktiviere = async (database: TestD1Database, channelId: string, moduleId: string): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{\"praefix\":\"!\"}')",
  ).bind(channelId, moduleId).run();
};

const verteile = async (
  database: TestD1Database,
  registry: readonly BotModule[],
  fetcher: typeof fetch,
  channelId = "kanal-a",
  subscriptionType = CHAT_TYP,
  payload: Readonly<Record<string, unknown>> = {
    message: { text: "!hallo" },
    chatter_user_id: "user-1",
    chatter_user_login: "alice",
  },
) => {
  for (const module of registry) await aktiviere(database, channelId, module.id);
  return dispatchEventSubNotification(
  umgebung(database),
  {
    channelId,
    subscriptionType,
    triggerId: "ausloeser-1",
    payload,
    receivedAt: JETZT,
  },
    fetcher,
    registry,
  );
};

describe("Modulauswahl", () => {
  it("übergeht deaktivierte Module", () => {
    const { treffer } = selectModulesForEvent(
      [aktivierung("modul-a", false)],
      CHAT_TYP,
      [stilles("modul-a")],
    );
    expect(treffer).toEqual([]);
  });

  it("übergeht Module, die für diesen Ereignistyp nicht zuständig sind", () => {
    const { treffer } = selectModulesForEvent(
      [aktivierung("modul-a")],
      CHAT_TYP,
      [modulDoppel("modul-a", () => ({ actions: [], diagnostics: [] }), ["channel.raid"])],
    );
    expect(treffer).toEqual([]);
  });

  it("meldet eine Aktivierung, die die Registry nicht kennt", () => {
    const { treffer, unbekannt } = selectModulesForEvent([aktivierung("verschwunden")], CHAT_TYP, []);
    expect(treffer).toEqual([]);
    expect(unbekannt).toEqual(["verschwunden"]);
  });
});

describe("Verteilung und Ausführung", () => {
  it("sendet die Chatnachricht eines Moduls und protokolliert den Erfolg", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [modulDoppel("modul-a", () => ({
        actions: [{ kind: "chat", text: "hallo", replyToMessageId: "nachricht-0" }],
        diagnostics: [{ code: "modul.geantwortet" }],
      }))], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(koerperVon(fetcher)).toMatchObject({
        broadcaster_id: "kanal-a",
        sender_id: "bot-1",
        message: "hallo",
        reply_parent_message_id: "nachricht-0",
      });
      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => zeile.code)).toEqual(["modul.geantwortet", "host.chat.gesendet"]);
      expect(JSON.parse(zeilen[1]?.detail_json ?? "{}" )).toEqual({ messageId: "nachricht-1", text: "hallo" });
    } finally {
      database.close();
    }
  });

  it("wertet eine verworfene Nachricht trotz HTTP 200 als Fehlschlag", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      // Twitch antwortet bei AutoMod-Ablehnung mit 200 und is_sent: false.
      const fetcher = chatAntwort({
        data: [{ is_sent: false, drop_reason: { code: "automod_held", message: "gehalten" } }],
      });
      await verteile(database, [modulDoppel("modul-a", () => ({
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher);

      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => zeile.code)).toEqual(["host.chat.fehlgeschlagen"]);
      expect(JSON.parse(zeilen[0]?.detail_json ?? "{}")).toMatchObject({ grund: "automod_held", text: "hallo" });
    } finally {
      database.close();
    }
  });

  it("hält die Reihenfolge der Aktionen ein", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [modulDoppel("modul-a", () => ({
        actions: [
          { kind: "chat", text: "erste" },
          { kind: "chat", text: "zweite" },
        ],
        diagnostics: [],
      }))], fetcher);

      const texte = fetcher.mock.calls.map((_aufruf, index) => koerperVon(fetcher, index).message);
      expect(texte).toEqual(["erste", "zweite"]);
    } finally {
      database.close();
    }
  });

  it("lässt ein werfendes Modul die übrigen nicht mitreißen", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [
        modulDoppel("modul-kaputt", () => { throw new Error("kaputt"); }),
        modulDoppel("modul-heil", () => ({ actions: [{ kind: "chat", text: "trotzdem" }], diagnostics: [] })),
      ], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => `${zeile.module_id}:${zeile.code}`)).toEqual([
        "modul-kaputt:host.modul.fehler",
        "modul-heil:host.chat.gesendet",
      ]);
    } finally {
      database.close();
    }
  });

  it("verliert eine Overlay-Aktion nicht stillschweigend", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [modulDoppel("modul-a", () => ({
        actions: [{ kind: "overlay", type: "konfetti", payload: {} }],
        diagnostics: [],
      }))], fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => zeile.code)).toEqual(["host.overlay.nicht_ausgefuehrt"]);
    } finally {
      database.close();
    }
  });

  it("sendet ausschließlich in den Kanal des Ereignisses", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertChannel(database, "kanal-b");
      const fetcher = gesendet();
      await verteile(database, [modulDoppel("modul-a", () => ({
        // Das Modul beschreibt nur Text; einen Zielkanal kann es gar nicht
        // angeben. Der Host nimmt ihn aus dem geprüften Ereignis.
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher, "kanal-b");

      expect(koerperVon(fetcher).broadcaster_id).toBe("kanal-b");
    } finally {
      database.close();
    }
  });

  it("übergibt dem Modul den Akteur samt aufgelöster Kanalrolle", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertMember(database, "kanal-a", "user-1", "bediener");
      let akteur: ModuleEvent["actor"] = null;
      await verteile(database, [modulDoppel("modul-a", (event) => {
        akteur = event.actor;
        return { actions: [], diagnostics: [] };
      })], gesendet());

      expect(akteur).toEqual({ userId: "user-1", login: "alice", role: "bediener" });
    } finally {
      database.close();
    }
  });

  it("reicht alle Chatstatus getrennt von der Panelrolle weiter und leert sie ohne Chatbezug", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertMember(database, "kanal-a", "user-1", "bediener");
      const statusse: Array<{ role: ModuleEvent["actor"]; chatStatus: ModuleEvent["chatStatus"] }> = [];
      const chatModul = modulDoppel("chat-modul", (event) => {
        statusse.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      });
      const raidModul = modulDoppel("raid-modul", (event) => {
        statusse.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      }, ["channel.raid"]);

      await verteile(database, [chatModul], gesendet());
      await verteile(database, [raidModul], gesendet(), "kanal-a", "channel.raid");

      expect(statusse).toEqual([
        { role: { userId: "user-1", login: "alice", role: "bediener" }, chatStatus: ["zuschauer"] },
        { role: { userId: "user-1", login: "alice", role: "bediener" }, chatStatus: null },
      ]);
    } finally {
      database.close();
    }
  });

  it("übermittelt VIP und Abonnement gemeinsam aus den Chatbadges", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      let chatStatus: ModuleEvent["chatStatus"] = null;
      const chatModul = modulDoppel("chat-modul", (event) => {
        chatStatus = event.chatStatus;
        return { actions: [], diagnostics: [] };
      });

      await verteile(
        database,
        [chatModul],
        gesendet(),
        "kanal-a",
        CHAT_TYP,
        {
          message: { text: "!hallo" },
          chatter_user_id: "user-1",
          chatter_user_login: "alice",
          badges: [{ set_id: "vip" }, { set_id: "subscriber" }],
        },
      );

      expect(chatStatus).toEqual(["vip", "abonnent"]);
    } finally {
      database.close();
    }
  });

  it("protokolliert eine Aktivierung, die die Registry nicht kennt", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
      ).bind("kanal-a", "verschwunden").run();
      await verteile(database, [], gesendet());

      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => zeile.code)).toEqual(["host.modul.unbekannt"]);
    } finally {
      database.close();
    }
  });

  it("veröffentlicht je Auslöser genau einen Feed-Hinweis", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const publish = vi.fn().mockResolvedValue(undefined);
      const namespace = {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ publish })),
      } as unknown as Env["CHANNEL"];
      const environment = { ...umgebung(database), CHANNEL: namespace };
      const moduleA = modulDoppel("modul-a", () => ({
        actions: [],
        diagnostics: [{ code: "modul.eins" }],
      }));
      const moduleB = modulDoppel("modul-b", () => ({
        actions: [],
        diagnostics: [{ code: "modul.zwei" }],
      }));
      await aktiviere(database, "kanal-a", "modul-a");
      await aktiviere(database, "kanal-a", "modul-b");

      await dispatchEventSubNotification(
        environment,
        {
          channelId: "kanal-a",
          subscriptionType: CHAT_TYP,
          triggerId: "ausloeser-1",
          payload: {},
          receivedAt: JETZT,
        },
        fetch,
        [moduleA, moduleB],
      );

      expect(publish).toHaveBeenCalledTimes(1);
      const [message] = publish.mock.calls[0] as [{ payload: { entries: unknown[] } }, string];
      expect(message.payload.entries).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
