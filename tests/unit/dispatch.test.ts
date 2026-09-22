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
 * A module double. `MODULES` is empty, and the tests must not assume a real
 * module ever exists.
 */
const moduleDuplicate = (
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

const stilles = (id: string) => moduleDuplicate(id, () => ({ actions: [], diagnostics: [] }));

const activation = (moduleId: string, enabled = true, settings = '{"praefix":"!"}') =>
  ({ moduleId, enabled, settings });

const environment = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: schluessel,
});

const chatResponse = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

/** Reads the JSON body of a chat call without blindly casting it. */
const koerperVon = (fetcher: ReturnType<typeof chatResponse>, index = 0): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const gesendet = () => chatResponse({ data: [{ is_sent: true, message_id: "nachricht-1" }] });

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

/** Registers every registry module as enabled; dispatch reads from the database. */
const activate = async (database: TestD1Database, channelId: string, moduleId: string): Promise<void> => {
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
  for (const module of registry) await activate(database, channelId, module.id);
  return dispatchEventSubNotification(
  environment(database),
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

describe("module selection", () => {
  it("skips disabled modules", () => {
    const { treffer } = selectModulesForEvent(
      [activation("modul-a", false)],
      CHAT_TYP,
      [stilles("modul-a")],
    );
    expect(treffer).toEqual([]);
  });

  it("skips modules not responsible for this event type", () => {
    const { treffer } = selectModulesForEvent(
      [activation("modul-a")],
      CHAT_TYP,
      [moduleDuplicate("modul-a", () => ({ actions: [], diagnostics: [] }), ["channel.raid"])],
    );
    expect(treffer).toEqual([]);
  });

  it("reports an activation the registry doesn't know", () => {
    const { treffer, unbekannt } = selectModulesForEvent([activation("verschwunden")], CHAT_TYP, []);
    expect(treffer).toEqual([]);
    expect(unbekannt).toEqual(["verschwunden"]);
  });
});

describe("dispatch and execution", () => {
  it("sends a module's chat message and logs the success", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [moduleDuplicate("modul-a", () => ({
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

  it("treats a dropped message as a failure despite HTTP 200", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      // Twitch responds to an AutoMod rejection with 200 and is_sent: false.
      const fetcher = chatResponse({
        data: [{ is_sent: false, drop_reason: { code: "automod_held", message: "gehalten" } }],
      });
      await verteile(database, [moduleDuplicate("modul-a", () => ({
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher);

      const zeilen = await protokoll(database);
      expect(zeilen.map((zeile) => zeile.code)).toEqual(["host.chat.fehlgeschlagen"]);
      expect(JSON.parse(zeilen[0]?.detail_json ?? "{}")).toMatchObject({ reason: "automod_held", text: "hallo" });
    } finally {
      database.close();
    }
  });

  it("preserves the order of actions", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [moduleDuplicate("modul-a", () => ({
        actions: [
          { kind: "chat", text: "erste" },
          { kind: "chat", text: "zweite" },
        ],
        diagnostics: [],
      }))], fetcher);

      const texts = fetcher.mock.calls.map((_aufruf, index) => koerperVon(fetcher, index).message);
      expect(texts).toEqual(["erste", "zweite"]);
    } finally {
      database.close();
    }
  });

  it("doesn't let a throwing module take the others down with it", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [
        moduleDuplicate("modul-kaputt", () => { throw new Error("kaputt"); }),
        moduleDuplicate("modul-heil", () => ({ actions: [{ kind: "chat", text: "trotzdem" }], diagnostics: [] })),
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

  it("doesn't silently drop an overlay action", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      const fetcher = gesendet();
      await verteile(database, [moduleDuplicate("modul-a", () => ({
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

  it("sends exclusively to the event's channel", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertChannel(database, "kanal-b");
      const fetcher = gesendet();
      await verteile(database, [moduleDuplicate("modul-a", () => ({
        // The module only describes text; it can't specify a target channel at
        // all. The host takes it from the verified event.
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher, "kanal-b");

      expect(koerperVon(fetcher).broadcaster_id).toBe("kanal-b");
    } finally {
      database.close();
    }
  });

  it("passes the module the actor together with the resolved channel role", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertMember(database, "kanal-a", "user-1", "operator");
      let actor: ModuleEvent["actor"] = null;
      await verteile(database, [moduleDuplicate("modul-a", (event) => {
        actor = event.actor;
        return { actions: [], diagnostics: [] };
      })], gesendet());

      expect(actor).toEqual({ userId: "user-1", login: "alice", role: "operator" });
    } finally {
      database.close();
    }
  });

  it("forwards chat status separately from the panel role and clears it when there's no chat context", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      await insertMember(database, "kanal-a", "user-1", "operator");
      const statuses: Array<{ role: ModuleEvent["actor"]; chatStatus: ModuleEvent["chatStatus"] }> = [];
      const chatModule = moduleDuplicate("chat-modul", (event) => {
        statuses.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      });
      const raidModule = moduleDuplicate("raid-modul", (event) => {
        statuses.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      }, ["channel.raid"]);

      await verteile(database, [chatModule], gesendet());
      await verteile(database, [raidModule], gesendet(), "kanal-a", "channel.raid");

      expect(statuses).toEqual([
        { role: { userId: "user-1", login: "alice", role: "operator" }, chatStatus: ["viewer"] },
        { role: { userId: "user-1", login: "alice", role: "operator" }, chatStatus: null },
      ]);
    } finally {
      database.close();
    }
  });

  it("reports VIP and subscriber together from the chat badges", async () => {
    const database = new TestD1Database();
    try {
      await mitBot(database);
      let chatStatus: ModuleEvent["chatStatus"] = null;
      const chatModule = moduleDuplicate("chat-modul", (event) => {
        chatStatus = event.chatStatus;
        return { actions: [], diagnostics: [] };
      });

      await verteile(
        database,
        [chatModule],
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

      expect(chatStatus).toEqual(["vip", "subscriber"]);
    } finally {
      database.close();
    }
  });

  it("logs an activation the registry doesn't know", async () => {
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

  it("publishes exactly one feed notice per trigger", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const publish = vi.fn().mockResolvedValue(undefined);
      const namespace = {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ publish })),
      } as unknown as Env["CHANNEL"];
      const env = { ...environment(database), CHANNEL: namespace };
      const moduleA = moduleDuplicate("modul-a", () => ({
        actions: [],
        diagnostics: [{ code: "modul.eins" }],
      }));
      const moduleB = moduleDuplicate("modul-b", () => ({
        actions: [],
        diagnostics: [{ code: "modul.zwei" }],
      }));
      await activate(database, "kanal-a", "modul-a");
      await activate(database, "kanal-a", "modul-b");

      await dispatchEventSubNotification(
        env,
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
