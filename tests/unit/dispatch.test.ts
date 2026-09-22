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

const CHAT_TYPE = "channel.chat.message";
const NOW = "2026-09-19T12:00:00.000Z";
const keyRing = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

/**
 * A module double. `MODULES` is empty, and the tests must not assume a real
 * module ever exists.
 */
const fakeModule = (
  id: string,
  handleEvent: (event: ModuleEvent) => ModuleResult | Promise<ModuleResult>,
  eventSubTypes: readonly string[] = [CHAT_TYPE],
): BotModule => ({
  id,
  settingsSchema: z.object({ prefix: z.string() }),
  defaultSettings: { prefix: "!" },
  eventSubTypes,
  handleEvent,
});

const silentModule = (id: string) => fakeModule(id, () => ({ actions: [], diagnostics: [] }));

const activation = (moduleId: string, enabled = true, settings = '{"prefix":"!"}') =>
  ({ moduleId, enabled, settings });

const environment = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: keyRing,
});

const chatResponse = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

/** Reads the JSON body of a chat call without blindly casting it. */
const bodyOf = (fetcher: ReturnType<typeof chatResponse>, index = 0): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const sent = () => chatResponse({ data: [{ is_sent: true, message_id: "nachricht-1" }] });

const withBot = async (database: TestD1Database): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(keyRing)),
    refreshTokenCiphertext: await encryptJson({ token: "refresh" }, parseKeyRing(keyRing)),
    expiresAt: "2026-09-20T00:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertAppAccessToken(
    database,
    await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
    "2099-09-21T00:00:00.000Z",
    NOW,
    NOW,
  );
};

const eventLog = async (database: TestD1Database) => {
  const result = await database.prepare(
    "SELECT module_id, code, detail_json FROM event_log ORDER BY rowid",
  ).all<{ module_id: string; code: string; detail_json: string }>();
  return result.results;
};

/** Registers every registry module as enabled; dispatch reads from the database. */
const activate = async (database: TestD1Database, channelId: string, moduleId: string): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{\"prefix\":\"!\"}')",
  ).bind(channelId, moduleId).run();
};

const runDispatch = async (
  database: TestD1Database,
  registry: readonly BotModule[],
  fetcher: typeof fetch,
  channelId = "kanal-a",
  subscriptionType = CHAT_TYPE,
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
    receivedAt: NOW,
  },
    fetcher,
    registry,
  );
};

describe("module selection", () => {
  it("skips disabled modules", () => {
    const { matches } = selectModulesForEvent(
      [activation("modul-a", false)],
      CHAT_TYPE,
      [silentModule("modul-a")],
    );
    expect(matches).toEqual([]);
  });

  it("skips modules not responsible for this event type", () => {
    const { matches } = selectModulesForEvent(
      [activation("modul-a")],
      CHAT_TYPE,
      [fakeModule("modul-a", () => ({ actions: [], diagnostics: [] }), ["channel.raid"])],
    );
    expect(matches).toEqual([]);
  });

  it("reports an activation the registry doesn't know", () => {
    const { matches, unknownModules } = selectModulesForEvent([activation("verschwunden")], CHAT_TYPE, []);
    expect(matches).toEqual([]);
    expect(unknownModules).toEqual(["verschwunden"]);
  });
});

describe("dispatch and execution", () => {
  it("sends a module's chat message and logs the success", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "chat", text: "hallo", replyToMessageId: "nachricht-0" }],
        diagnostics: [{ code: "modul.geantwortet" }],
      }))], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(bodyOf(fetcher)).toMatchObject({
        broadcaster_id: "kanal-a",
        sender_id: "bot-1",
        message: "hallo",
        reply_parent_message_id: "nachricht-0",
      });
      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["modul.geantwortet", "host.chat.sent"]);
      expect(JSON.parse(rows[1]?.detail_json ?? "{}" )).toEqual({ messageId: "nachricht-1", text: "hallo" });
    } finally {
      database.close();
    }
  });

  it("treats a dropped message as a failure despite HTTP 200", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      // Twitch responds to an AutoMod rejection with 200 and is_sent: false.
      const fetcher = chatResponse({
        data: [{ is_sent: false, drop_reason: { code: "automod_held", message: "gehalten" } }],
      });
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher);

      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["host.chat.failed"]);
      expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({ reason: "automod_held", text: "hallo" });
    } finally {
      database.close();
    }
  });

  it("preserves the order of actions", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [
          { kind: "chat", text: "erste" },
          { kind: "chat", text: "zweite" },
        ],
        diagnostics: [],
      }))], fetcher);

      const texts = fetcher.mock.calls.map((_call, index) => bodyOf(fetcher, index).message);
      expect(texts).toEqual(["erste", "zweite"]);
    } finally {
      database.close();
    }
  });

  it("doesn't let a throwing module take the others down with it", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [
        fakeModule("modul-kaputt", () => { throw new Error("kaputt"); }),
        fakeModule("modul-heil", () => ({ actions: [{ kind: "chat", text: "trotzdem" }], diagnostics: [] })),
      ], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const rows = await eventLog(database);
      expect(rows.map((row) => `${row.module_id}:${row.code}`)).toEqual([
        "modul-kaputt:host.module.error",
        "modul-heil:host.chat.sent",
      ]);
    } finally {
      database.close();
    }
  });

  it("doesn't silently drop an overlay action", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "overlay", type: "konfetti", payload: {} }],
        diagnostics: [],
      }))], fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["host.overlay.not_executed"]);
    } finally {
      database.close();
    }
  });

  it("sends exclusively to the event's channel", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await insertChannel(database, "kanal-b");
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        // The module only describes text; it can't specify a target channel at
        // all. The host takes it from the verified event.
        actions: [{ kind: "chat", text: "hallo" }],
        diagnostics: [],
      }))], fetcher, "kanal-b");

      expect(bodyOf(fetcher).broadcaster_id).toBe("kanal-b");
    } finally {
      database.close();
    }
  });

  it("passes the module the actor together with the resolved channel role", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await insertMember(database, "kanal-a", "user-1", "operator");
      let actor: ModuleEvent["actor"] = null;
      await runDispatch(database, [fakeModule("modul-a", (event) => {
        actor = event.actor;
        return { actions: [], diagnostics: [] };
      })], sent());

      expect(actor).toEqual({ userId: "user-1", login: "alice", role: "operator" });
    } finally {
      database.close();
    }
  });

  it("forwards chat status separately from the panel role and clears it when there's no chat context", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await insertMember(database, "kanal-a", "user-1", "operator");
      const statuses: Array<{ role: ModuleEvent["actor"]; chatStatus: ModuleEvent["chatStatus"] }> = [];
      const chatModule = fakeModule("chat-modul", (event) => {
        statuses.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      });
      const raidModule = fakeModule("raid-modul", (event) => {
        statuses.push({ role: event.actor, chatStatus: event.chatStatus });
        return { actions: [], diagnostics: [] };
      }, ["channel.raid"]);

      await runDispatch(database, [chatModule], sent());
      await runDispatch(database, [raidModule], sent(), "kanal-a", "channel.raid");

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
      await withBot(database);
      let chatStatus: ModuleEvent["chatStatus"] = null;
      const chatModule = fakeModule("chat-modul", (event) => {
        chatStatus = event.chatStatus;
        return { actions: [], diagnostics: [] };
      });

      await runDispatch(
        database,
        [chatModule],
        sent(),
        "kanal-a",
        CHAT_TYPE,
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
      await withBot(database);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
      ).bind("kanal-a", "verschwunden").run();
      await runDispatch(database, [], sent());

      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["host.module.unknown"]);
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
      const moduleA = fakeModule("modul-a", () => ({
        actions: [],
        diagnostics: [{ code: "modul.eins" }],
      }));
      const moduleB = fakeModule("modul-b", () => ({
        actions: [],
        diagnostics: [{ code: "modul.zwei" }],
      }));
      await activate(database, "kanal-a", "modul-a");
      await activate(database, "kanal-a", "modul-b");

      await dispatchEventSubNotification(
        env,
        {
          channelId: "kanal-a",
          subscriptionType: CHAT_TYPE,
          triggerId: "ausloeser-1",
          payload: {},
          receivedAt: NOW,
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
