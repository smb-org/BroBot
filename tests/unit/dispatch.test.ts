import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../../src/modules/contract";
import { channelEventsModule } from "../../src/modules/channel_events";
import { dispatchEventSubNotification, needsActiveChatterTracking, selectModulesForEvent } from "../../src/worker/dispatch";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";
import { readChannelControls, readDispatchChannelState, setChannelControl } from "../../src/worker/db/channel-controls";

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

const environment = (database: TestD1Database, publish = vi.fn()) => {
  const channelObject = {
    publish,
    recordChatActivity: vi.fn().mockResolvedValue(0),
    startActiveChatterStream: vi.fn().mockResolvedValue(undefined),
    clearActiveChatters: vi.fn().mockResolvedValue(undefined),
    getActiveChatterCount: vi.fn().mockResolvedValue(0),
    getActiveChatter: vi.fn().mockResolvedValue(null),
    claimAutomatedChatOutput: vi.fn().mockResolvedValue(true),
    recordBotChatMessage: vi.fn().mockResolvedValue(undefined),
    isRecentBotChatMessage: vi.fn().mockResolvedValue(false),
    getChatActivityCount: vi.fn().mockResolvedValue(0),
  };
  return {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: keyRing,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"],
  };
};

const chatResponse = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

/** Reads the JSON body of a chat call without blindly casting it. */
const bodyOf = (fetcher: ReturnType<typeof chatResponse>, index = 0): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const requestedUrl = (input?: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";

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

  it("keeps only mandatory modules while a channel is paused", () => {
    const mandatory = { ...silentModule("mandatory"), mandatory: true };
    const regular = silentModule("regular");
    const { matches } = selectModulesForEvent(
      [activation("mandatory"), activation("regular")],
      CHAT_TYPE,
      [mandatory, regular],
      true,
    );
    expect(matches.map(({ module }) => module.id)).toEqual(["mandatory"]);
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

  it("tracks active chatters only for enabled registered declarations", () => {
    const tracker = { ...silentModule("tracker"), needsActiveChatters: true };
    expect(needsActiveChatterTracking([], [tracker])).toBe(false);
    expect(needsActiveChatterTracking([activation("tracker", false)], [tracker])).toBe(false);
    expect(needsActiveChatterTracking([activation("tracker")], [tracker])).toBe(true);
    expect(needsActiveChatterTracking([activation("unknown")], [tracker])).toBe(false);
    expect(needsActiveChatterTracking([activation("tracker", false)], [{ ...tracker, mandatory: true }])).toBe(true);
  });
});

describe("dispatch and execution", () => {
  it("passes the chatter id through the existing channel object call when tracking is declared", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const tracker = { ...silentModule("tracker"), needsActiveChatters: true };
      await activate(database, "kanal-a", tracker.id);
      const runtime = environment(database);

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: CHAT_TYPE,
        triggerId: "activity-trigger",
        payload: { message: { text: "hello" }, chatter_user_id: "viewer-1", chatter_user_login: "viewer-a" },
        receivedAt: NOW,
      }, vi.fn<typeof fetch>(), [tracker]);

      const object = runtime.CHANNEL.get(runtime.CHANNEL.idFromName("kanal-a")) as unknown as {
        recordChatActivity: ReturnType<typeof vi.fn>;
      };
      expect(object.recordChatActivity).toHaveBeenCalledTimes(1);
      expect(object.recordChatActivity).toHaveBeenCalledWith("viewer-1", true);
    } finally {
      database.close();
    }
  });

  it("exposes active chatter counts and timestamps through the declaring module context", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const observations: Array<{ count: number; seen: unknown }> = [];
      const tracker: BotModule = {
        ...silentModule("tracker"),
        needsActiveChatters: true,
        handleEvent: async (_event, context) => {
          observations.push({
            count: await context.activeChatters.count(60_000),
            seen: await context.activeChatters.seen("viewer-1"),
          });
          return { actions: [], diagnostics: [] };
        },
      };
      await activate(database, "kanal-a", tracker.id);
      const runtime = environment(database);
      const object = runtime.CHANNEL.get(runtime.CHANNEL.idFromName("kanal-a")) as unknown as {
        getActiveChatterCount: ReturnType<typeof vi.fn>;
        getActiveChatter: ReturnType<typeof vi.fn>;
      };
      object.getActiveChatterCount.mockResolvedValue(2);
      object.getActiveChatter.mockResolvedValue({
        firstSeenAt: "2026-09-19T11:00:00.000Z",
        lastSeenAt: "2026-09-19T11:59:00.000Z",
      });

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: CHAT_TYPE,
        triggerId: "active-chatter-context",
        payload: { message: { text: "hello" }, chatter_user_id: "viewer-1", chatter_user_login: "viewer-a" },
        receivedAt: NOW,
      }, vi.fn<typeof fetch>(), [tracker]);

      expect(observations).toEqual([{
        count: 2,
        seen: { firstSeenAt: "2026-09-19T11:00:00.000Z", lastSeenAt: "2026-09-19T11:59:00.000Z" },
      }]);
      expect(object.getActiveChatterCount).toHaveBeenCalledWith(60_000);
      expect(object.getActiveChatter).toHaveBeenCalledWith("viewer-1");
    } finally {
      database.close();
    }
  });

  it.each([
    { source: null, forSourceOnly: true, description: "our channel with a null source" },
    { source: "kanal-a", forSourceOnly: true, description: "our channel ID" },
    { source: "partner-channel", forSourceOnly: false, description: "a partner channel" },
  ])("routes where_asked chat output for $description", async ({ source, forSourceOnly }) => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "chat", text: "Antwort", target: "where_asked" }],
        diagnostics: [],
      }))], fetcher, "kanal-a", CHAT_TYPE, {
        message: { text: "!hallo" },
        chatter_user_id: "user-1",
        chatter_user_login: "alice",
        source_broadcaster_user_id: source,
      });

      expect(bodyOf(fetcher)).toMatchObject({ for_source_only: forSourceOnly });
    } finally {
      database.close();
    }
  });

  it("drops automated chat output when the shared channel limit is occupied", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const deliveryOutcomes: string[] = [];
      const module = fakeModule("automated-module", () => ({
        actions: [{
          kind: "chat",
          text: "Automatic response",
          automated: true,
          onDelivery: (delivery) => {
            deliveryOutcomes.push(delivery);
            return Promise.resolve();
          },
        }],
        diagnostics: [],
      }));
      await activate(database, "kanal-a", module.id);
      const baseEnvironment = environment(database);
      const claimAutomatedChatOutput = vi.fn().mockResolvedValue(false);
      const runtime = {
        ...baseEnvironment,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({
            publish: vi.fn(),
            recordChatActivity: vi.fn().mockResolvedValue(0),
            claimAutomatedChatOutput,
            recordBotChatMessage: vi.fn().mockResolvedValue(undefined),
            isRecentBotChatMessage: vi.fn().mockResolvedValue(false),
            getChatActivityCount: vi.fn().mockResolvedValue(0),
          }),
        },
      } as unknown as Env;
      const fetcher = sent();

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: CHAT_TYPE,
        triggerId: "automated-output-limited",
        payload: {
          message: { text: "A viewer message" },
          chatter_user_id: "viewer-1",
          chatter_user_login: "alice",
        },
        receivedAt: NOW,
      }, fetcher, [module]);

      expect(claimAutomatedChatOutput).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
      expect(deliveryOutcomes).toEqual(["not_attempted"]);
      await expect(eventLog(database)).resolves.toMatchObject([
        { module_id: module.id, code: "host.chat.skipped" },
      ]);
    } finally {
      database.close();
    }
  });

  it("delivers mandatory channel events without an activation and through a disabled legacy row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.offline",
        triggerId: "offline-without-row",
        payload: {},
        receivedAt: NOW,
      }, sent(), [channelEventsModule]);
      await expect(eventLog(database)).resolves.toMatchObject([
        { module_id: "channel_events", code: "channel_events.stream.offline" },
      ]);

      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'channel_events', 0, '{}')`,
      ).run();
      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "online-disabled-row",
        payload: {},
        receivedAt: NOW,
      }, sent(), [channelEventsModule]);
      await expect(eventLog(database)).resolves.toMatchObject([
        { module_id: "channel_events", code: "channel_events.stream.offline" },
        { module_id: "channel_events", code: "channel_events.stream.online" },
      ]);
    } finally {
      database.close();
    }
  });

  it("runs modules while muted but suppresses chat, announcements, and automatic shoutouts", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await database.prepare(
        `INSERT INTO channel_controls (channel_id, muted, muted_until, mute_until_stream_end,
          paused, paused_until, pause_until_stream_end, updated_at)
         VALUES ('kanal-a', 1, NULL, 0, 0, NULL, 0, ?)`
      ).bind(NOW).run();
      let executions = 0;
      const module = fakeModule("modul-a", () => {
        executions += 1;
        return {
          actions: [
            { kind: "chat", text: "Antwort", replyToMessageId: "message-1" },
            { kind: "announcement", text: "Ankündigung" },
            { kind: "shoutout", targetChannelId: "target-channel" },
          ],
          diagnostics: [{ code: "text_commands.triggered" }],
        };
      });
      const fetcher = sent();
      await runDispatch(database, [module], fetcher);

      expect(executions).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      const rows = await eventLog(database);
      expect(rows.map((row) => `${row.module_id}:${row.code}`)).toEqual([
        "modul-a:text_commands.triggered",
        "modul-a:host.action.suppressed",
        "modul-a:host.action.suppressed",
        "modul-a:host.action.suppressed",
      ]);
      expect(rows.slice(1).map((row) => JSON.parse(row.detail_json) as unknown)).toEqual([
        { action: "chat", reason: "channel_muted" },
        { action: "announcement", reason: "channel_muted" },
        { action: "shoutout", reason: "channel_muted" },
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps channel_events logging on stream.offline while the ending session's pause remains stored", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at)
         VALUES ('kanal-a', 'online', ?, 'eventsub', ?, ?, ?)`
      ).bind("2026-09-19T11:00:00.000Z", "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z", "2026-09-19T11:00:00.000Z").run();
      await database.prepare(
        `UPDATE channel_stream_state
            SET started_at_seconds = CAST(strftime('%s', started_at) AS INTEGER),
                started_at_fraction = '',
                eventsub_changed_at_seconds = CAST(strftime('%s', eventsub_changed_at) AS INTEGER),
                eventsub_changed_at_fraction = ''
          WHERE channel_id = 'kanal-a'`,
      ).run();
      await database.prepare(
        `INSERT INTO channel_controls (channel_id, muted, muted_until, mute_until_stream_end,
          mute_stream_started_at, paused, paused_until, pause_until_stream_end, pause_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, NULL, 1, '2026-09-19T10:00:00.000Z', 1, NULL, 1, '2026-09-19T10:00:00.000Z', ?)`
      ).bind(NOW).run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'channel_events', 1, '{}')",
      ).run();

      let regularExecutions = 0;
      const regular = fakeModule("regular", () => {
        regularExecutions += 1;
        return { actions: [], diagnostics: [] };
      }, ["stream.offline"]);
      await activate(database, "kanal-a", "regular");
      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.offline",
        triggerId: "offline-1",
        payload: {},
        receivedAt: NOW,
      }, sent(), [channelEventsModule, regular]);

      expect(regularExecutions).toBe(0);
      await expect(eventLog(database)).resolves.toMatchObject([
        { module_id: "channel_events", code: "channel_events.stream.offline" },
      ]);
      await expect(database.prepare(
        "SELECT muted, mute_until_stream_end, mute_stream_started_at, paused, pause_until_stream_end, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        muted: 1, mute_until_stream_end: 1, mute_stream_started_at: "2026-09-19T10:00:00.000Z",
        paused: 1, pause_until_stream_end: 1, pause_stream_started_at: "2026-09-19T10:00:00.000Z",
      });
      await expect(readDispatchChannelState(database as unknown as D1Database, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { mute: { active: false }, pause: { active: false } },
      });
    } finally {
      database.close();
    }
  });

  it("does not let an older offline handler overwrite a newer stream control", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "operator-1");
      await insertMember(database, "kanal-a", "operator-1", "operator");
      const db = database as unknown as D1Database;
      const environmentValue = environment(database);
      const dispatchStream = (subscriptionType: "stream.online" | "stream.offline", receivedAt: string, startedAt?: string) =>
        dispatchEventSubNotification(environmentValue, {
          channelId: "kanal-a",
          subscriptionType,
          triggerId: `${subscriptionType}-${receivedAt}`,
          payload: startedAt === undefined ? {} : { started_at: startedAt },
          receivedAt,
        }, sent(), [channelEventsModule]);

      const firstStartedAt = "2026-09-19T10:00:00.000Z";
      await dispatchStream("stream.online", "2026-09-19T10:00:01.000Z", firstStartedAt);
      await setChannelControl(db, { userId: "operator-1", sessionId: "session-operator-1" }, "kanal-a", "pause", "until_stream_end", "2026-09-19T10:01:00.000Z");

      let signalEntered: () => void = () => {};
      let releaseHandler: () => void = () => {};
      const enteredHandler = new Promise<void>((resolve) => { signalEntered = resolve; });
      const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
      const delayedOfflineModule: BotModule = {
        ...fakeModule("delayed-offline", async () => {
          signalEntered();
          await handlerGate;
          return { actions: [], diagnostics: [] };
        }, ["stream.offline"]),
        mandatory: true,
      };
      const olderOffline = dispatchEventSubNotification(environmentValue, {
        channelId: "kanal-a",
        subscriptionType: "stream.offline",
        triggerId: "offline-old-session",
        payload: {},
        receivedAt: "2026-09-19T10:05:00.000Z",
      }, sent(), [delayedOfflineModule, channelEventsModule]);
      await enteredHandler;

      const secondStartedAt = "2026-09-19T10:10:00.000Z";
      await dispatchStream("stream.online", "2026-09-19T10:10:01.000Z", secondStartedAt);
      await setChannelControl(db, { userId: "operator-1", sessionId: "session-operator-1" }, "kanal-a", "pause", "until_stream_end", "2026-09-19T10:10:02.000Z");
      releaseHandler();
      await olderOffline;

      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", started_at: secondStartedAt });
      await expect(database.prepare(
        "SELECT paused, pause_until_stream_end, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ paused: 1, pause_until_stream_end: 1, pause_stream_started_at: secondStartedAt });
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-19T10:10:03.000Z")).resolves.toMatchObject({
        controls: { pause: { active: true, mode: "until_stream_end" } },
      });
    } finally {
      database.close();
    }
  });

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

  it("routes an overlay action to overlays that contain its module element", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await database.prepare(
        `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
         VALUES ('overlay-a', 'kanal-a', 'Gameplay', ?, ?)`,
      ).bind(NOW, NOW).run();
      await database.prepare(
        `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json)
         VALUES ('element-a', 'kanal-a', 'overlay-a', 'ads.countdown', 'Werbung', NULL, '', '{}')`,
      ).run();
      await activate(database, "kanal-a", "ads");
      const publish = vi.fn();
      await dispatchEventSubNotification({ ...environment(database, publish) }, {
        channelId: "kanal-a",
        subscriptionType: CHAT_TYPE,
        triggerId: "overlay-action-trigger",
        payload: { message: { text: "!hallo" }, chatter_user_id: "user-1", chatter_user_login: "alice" },
        receivedAt: NOW,
      }, fetcher, [fakeModule("ads", () => ({
        actions: [{ kind: "overlay", type: "konfetti", elementKind: "ads.countdown", payload: {} }],
        diagnostics: [],
      }))]);

      expect(fetcher).not.toHaveBeenCalled();
      expect(publish.mock.calls).toHaveLength(1);
      expect(publish.mock.calls[0]?.[0]).toMatchObject([{
        type: "modul.ads.konfetti",
        payload: {},
        overlayIds: ["overlay-a"],
      }]);
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
      const [messages] = publish.mock.calls[0] as [[{ payload: { entries: unknown[] } }], string];
      const [message] = messages;
      expect(message.payload.entries).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("stores stream.offline and ignores an older stream.online delivery", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const environmentValue = environment(database);
      const dispatch = (subscriptionType: "stream.online" | "stream.offline", receivedAt: string) =>
        dispatchEventSubNotification(environmentValue, {
          channelId: "kanal-a",
          subscriptionType,
          triggerId: `${subscriptionType}-${receivedAt}`,
          payload: {},
          receivedAt,
        }, sent(), []);

      await dispatch("stream.offline", "2026-09-19T12:01:00.000Z");
      await dispatch("stream.online", "2026-09-19T12:00:00.000Z");

      await expect(database.prepare(
        "SELECT state, changed_at, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        state: "offline", changed_at: "2026-09-19T12:01:00.000Z", source: "eventsub",
      });
    } finally {
      database.close();
    }
  });

  it("stores the event's real stream start on stream.online and clears it again on stream.offline (#178)", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const environmentValue = environment(database);

      await dispatchEventSubNotification(environmentValue, {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "online-1",
        payload: { started_at: "2026-09-19T11:55:00.000Z" },
        receivedAt: "2026-09-19T12:00:00.000Z",
      }, sent(), []);

      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", started_at: "2026-09-19T11:55:00.000Z" });

      await dispatchEventSubNotification(environmentValue, {
        channelId: "kanal-a",
        subscriptionType: "stream.offline",
        triggerId: "offline-1",
        payload: {},
        receivedAt: "2026-09-19T12:05:00.000Z",
      }, sent(), []);

      const object = environmentValue.CHANNEL.get(environmentValue.CHANNEL.idFromName("kanal-a"));
      expect(object.clearActiveChatters).toHaveBeenCalledTimes(1);

      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "offline", started_at: null });
    } finally {
      database.close();
    }
  });

  it("starts stream-scoped chatter tracking for an enabled declaration", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const tracker = { ...silentModule("tracker"), needsActiveChatters: true };
      await activate(database, "kanal-a", tracker.id);
      const runtime = environment(database);
      const startedAt = "2026-09-27T12:00:00.000Z";

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "online-tracker",
        payload: { id: "stream-1", started_at: startedAt },
        receivedAt: startedAt,
      }, sent(), [tracker]);

      const object = runtime.CHANNEL.get(runtime.CHANNEL.idFromName("kanal-a"));
      expect(object.startActiveChatterStream).toHaveBeenCalledWith("stream-1", startedAt);
    } finally {
      database.close();
    }
  });

  it("reconciles a delayed online event after Helix offline and binds the pending pause to the next stream", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await database.prepare(
        `INSERT INTO channel_stream_state
          (channel_id, state, changed_at, source, started_at, checked_at)
         VALUES ('kanal-a', 'offline', '2026-09-19T10:00:00.000Z', 'helix', NULL,
                 '2026-09-19T10:00:00.000Z')`,
      ).run();
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, paused, pause_until_stream_end, updated_at)
         VALUES ('kanal-a', 1, 1, '2026-09-19T10:01:00.000Z')`,
      ).run();
      const helixOffline = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "delayed-online",
        payload: { id: "ended-stream", started_at: "2026-09-19T09:55:00.000Z" },
        eventSubTimestamp: "2026-09-19T09:55:00.000Z",
        receivedAt: "2026-09-19T10:02:00.000Z",
      }, helixOffline, []);

      expect(helixOffline).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        `SELECT state, source, changed_at, stream_id
           FROM channel_stream_state WHERE channel_id = 'kanal-a'`,
      ).first()).resolves.toEqual({
        state: "offline", source: "helix", changed_at: "2026-09-19T10:02:00.000Z", stream_id: null,
      });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-19T10:02:01.000Z"))
        .resolves.toMatchObject({ pause: { active: false, pending: true } });
      await expect(database.prepare(
        "SELECT pause_stream_id, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ pause_stream_id: null, pause_stream_started_at: null });

      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "next-online",
        payload: { id: "real-next-stream", started_at: "2026-09-19T10:03:00.000Z" },
        eventSubTimestamp: "2026-09-19T10:03:01.000Z",
        receivedAt: "2026-09-19T10:03:01.000Z",
      }, helixOffline, []);

      await expect(database.prepare(
        `SELECT state, stream_id, started_at
           FROM channel_stream_state WHERE channel_id = 'kanal-a'`,
      ).first()).resolves.toEqual({
        state: "online", stream_id: "real-next-stream", started_at: "2026-09-19T10:03:00.000Z",
      });
      await expect(database.prepare(
        "SELECT pause_stream_id, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        pause_stream_id: "real-next-stream", pause_stream_started_at: "2026-09-19T10:03:00.000Z",
      });
      await expect(readDispatchChannelState(database as unknown as D1Database, "kanal-a", "2026-09-19T10:03:02.000Z"))
        .resolves.toMatchObject({ controls: { pause: { active: true, mode: "until_stream_end" } } });
    } finally {
      database.close();
    }
  });

  it("uses Helix to reconcile an offline event when the current live start is unknown", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertAppAccessToken(
        database,
        await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
        "2099-09-21T00:00:00.000Z",
        NOW,
        NOW,
      );
      await database.prepare(
        `INSERT INTO channel_stream_state
          (channel_id, state, changed_at, source, started_at, checked_at)
         VALUES ('kanal-a', 'online', ?, 'helix', NULL, ?)`,
      ).bind(NOW, NOW).run();
      const startedAt = "2026-09-19T11:55:00.000Z";
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "live-1", started_at: startedAt }] }), { status: 200 }),
      );

      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a",
        subscriptionType: "stream.offline",
        triggerId: "offline-ambiguous",
        payload: {},
        eventSubTimestamp: NOW,
        receivedAt: "2026-09-19T12:00:02.000Z",
      }, fetcher, []);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", started_at: startedAt });
    } finally {
      database.close();
    }
  });

  it("resets variables when EventSub arrives after a Helix online refresh", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables
          (channel_id, name, value, reset_on_stream_start, created_at, updated_at)
         VALUES ('kanal-a', 'score', 42, 1, ?, ?), ('kanal-a', 'kept', 7, 0, ?, ?)`,
      ).bind(NOW, NOW, NOW, NOW).run();
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
         VALUES ('kanal-a', 'online', '2026-09-19T12:00:01.000Z', 'helix', '2026-09-19T11:55:00.000Z')`,
      ).run();

      await dispatchEventSubNotification(environment(database), {
        channelId: "kanal-a", subscriptionType: "stream.online", triggerId: "online-late",
        payload: { started_at: "2026-09-19T11:55:00.000Z" }, receivedAt: NOW, eventSubTimestamp: NOW,
      }, sent(), []);

      await expect(database.prepare("SELECT name, value FROM channel_variables ORDER BY name").all())
        .resolves.toMatchObject({ results: [{ name: "kept", value: 7 }, { name: "score", value: 0 }] });
      await expect(database.prepare("SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ state: "online", source: "eventsub" });
      await expect(database.prepare("SELECT started_at FROM channel_variable_stream_resets WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ started_at: "2026-09-19T11:55:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("resets a stream session once across duplicate stream.online deliveries", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, reset_on_stream_start, created_at, updated_at)
         VALUES ('kanal-a', 'score', 42, 1, ?, ?), ('kanal-a', 'zero', 0, 1, ?, ?)`,
      ).bind(NOW, NOW, NOW, NOW).run();
      await database.prepare(
        `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
         VALUES ('overlay-a', 'kanal-a', 'Gameplay', ?, ?)`,
      ).bind(NOW, NOW).run();
      await database.prepare(
        `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name)
         VALUES ('element-a', 'kanal-a', 'overlay-a', 'variable', 'score')`,
      ).run();
      const publish = vi.fn();
      const env = environment(database, publish);
      const dispatchOnline = (startedAt: string, receivedAt: string, triggerId: string) => dispatchEventSubNotification(env, {
        channelId: "kanal-a", subscriptionType: "stream.online", triggerId,
        payload: { started_at: startedAt }, receivedAt,
      }, sent(), []);

      await dispatchOnline("2026-09-19T11:55:00.000Z", NOW, "online-first");
      await database.prepare("UPDATE channel_variables SET value = 9 WHERE channel_id = 'kanal-a' AND name = 'score'").run();
      await dispatchOnline("2026-09-19T11:55:00.000Z", "2026-09-19T12:00:02.000Z", "online-duplicate");
      await dispatchOnline("2026-09-19T11:54:00.000Z", "2026-09-19T12:00:03.000Z", "online-late-old-session");

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[0]).toMatchObject([
        { type: "stream.state.changed", payload: { state: "online", startedAt: "2026-09-19T11:55:00.000Z" } },
        { type: "variables.changed", payload: {
          set: [{ name: "score", value: 0 }], removed: [], overlayIdsByVariable: { score: ["overlay-a"] },
        } },
      ]);

      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 9 });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'zero'").first())
        .resolves.toEqual({ value: 0 });
      await expect(database.prepare("SELECT started_at FROM channel_variable_stream_resets WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ started_at: "2026-09-19T11:55:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("resets variables again for a new stream after offline", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, reset_on_stream_start, created_at, updated_at)
         VALUES ('kanal-a', 'score', 42, 1, ?, ?)`,
      ).bind(NOW, NOW).run();
      const dispatch = (subscriptionType: "stream.online" | "stream.offline", receivedAt: string, startedAt?: string) =>
        dispatchEventSubNotification(environment(database), {
          channelId: "kanal-a", subscriptionType, triggerId: `${subscriptionType}-${receivedAt}`,
          payload: startedAt === undefined ? {} : { started_at: startedAt }, receivedAt,
        }, sent(), []);

      await dispatch("stream.online", NOW, "2026-09-19T11:55:00.000Z");
      await database.prepare("UPDATE channel_variables SET value = 9 WHERE channel_id = 'kanal-a' AND name = 'score'").run();
      await dispatch("stream.offline", "2026-09-19T12:05:00.000Z");
      await dispatch("stream.online", "2026-09-19T12:10:00.000Z", "2026-09-19T12:09:00.000Z");

      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 0 });
      await expect(database.prepare("SELECT started_at FROM channel_variable_stream_resets WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ started_at: "2026-09-19T12:09:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("switches to a different stream id at an equal started_at instead of treating it as the current session (#192)", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "operator-1");
      await insertMember(database, "kanal-a", "operator-1", "operator");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, reset_on_stream_start, created_at, updated_at)
         VALUES ('kanal-a', 'score', 42, 1, ?, ?)`,
      ).bind(NOW, NOW).run();
      const db = database as unknown as D1Database;
      const environmentValue = environment(database);
      const startedAt = "2026-09-19T11:55:00.000Z";
      const dispatchOnline = (streamId: string, receivedAt: string, triggerId: string) =>
        dispatchEventSubNotification(environmentValue, {
          channelId: "kanal-a", subscriptionType: "stream.online", triggerId,
          payload: { started_at: startedAt, id: streamId }, receivedAt,
        }, sent(), []);

      await dispatchOnline("stream-a", NOW, "online-a");
      await setChannelControl(
        db, { userId: "operator-1", sessionId: "session-operator-1" }, "kanal-a", "pause", "until_stream_end",
        "2026-09-19T11:56:00.000Z",
      );
      await database.prepare("UPDATE channel_variables SET value = 9 WHERE channel_id = 'kanal-a' AND name = 'score'").run();

      // Same started_at, a different Twitch stream id: a genuinely new
      // session (e.g. a quick restart), not a duplicate of the current one.
      await dispatchOnline("stream-b", "2026-09-19T12:00:02.000Z", "online-b");

      await expect(database.prepare(
        "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", stream_id: "stream-b" });
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-19T12:00:03.000Z")).resolves.toMatchObject({
        controls: { pause: { active: false, mode: null } },
      });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 0 });
      await expect(database.prepare("SELECT stream_id FROM channel_variable_stream_resets WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ stream_id: "stream-b" });
    } finally {
      database.close();
    }
  });

  it("memoizes one lazy Helix stream lookup for every module in a dispatch", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const states: string[][] = [];
      const needsState: BotModule = {
        id: "stream-a",
        settingsSchema: z.object({}),
        defaultSettings: {},
        eventSubTypes: [CHAT_TYPE],
        handleEvent: async (_event: ModuleEvent, context: ModuleExecutionContext) => {
          states.push([await context.streamState(), await context.streamState()]);
          return { actions: [], diagnostics: [] };
        },
      };
      const needsStateAgain: BotModule = {
        ...needsState,
        id: "stream-b",
        handleEvent: async (_event, context) => {
          states.push([await context.streamState()]);
          return { actions: [], diagnostics: [] };
        },
      };
      let streamStateReads = 0;
      const wrappedDb = {
        prepare(sql: string) {
          if (/SELECT[\s\S]*FROM channel_stream_state/u.test(sql)) streamStateReads += 1;
          return database.prepare(sql);
        },
        batch: database.batch.bind(database),
      } as unknown as D1Database;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "live-1" }] }), { status: 200 }),
      );
      await activate(database, "kanal-a", "stream-a");
      await activate(database, "kanal-a", "stream-b");
      await dispatchEventSubNotification(
        { ...environment(database), DB: wrappedDb },
        {
          channelId: "kanal-a", subscriptionType: CHAT_TYPE, triggerId: "stream-trigger", payload: {}, receivedAt: NOW,
        },
        fetcher,
        [needsState, needsStateAgain],
      );

      expect(states).toEqual([["online", "online"], ["online"]]);
      expect(streamStateReads).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
      await expect(database.prepare(
        "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix" });
    } finally {
      database.close();
    }
  });

  it("sends announcements with the app token and Twitch's default color", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await database.prepare(
        `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
         VALUES ('kanal-a', 1, ?, NULL)`,
      ).bind(NOW).run();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "announcement", text: "Wichtige Nachricht" }],
        diagnostics: [],
      }))], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("https://api.twitch.tv/helix/chat/announcements?");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("broadcaster_id=kanal-a");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("moderator_id=bot-1");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("for_source_only=true");
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer app-token", "Client-ID": "client-id" },
        body: JSON.stringify({ message: "Wichtige Nachricht" }),
      });
      await expect(eventLog(database)).resolves.toMatchObject([{ code: "host.announcement.sent" }]);
    } finally {
      database.close();
    }
  });

  it("falls back to a chat message without calling Helix when the bot is not a moderator", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      const fetcher = sent();
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "announcement", text: "Wichtige Nachricht" }],
        diagnostics: [],
      }))], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/chat/messages");
      expect(bodyOf(fetcher)).toMatchObject({ for_source_only: true });
      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["host.announcement.failed", "host.chat.sent"]);
      expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
        reason: "not_moderator", outcome: "sent_as_message",
      });
    } finally {
      database.close();
    }
  });

  it.each([401, 403, 503])("falls back to chat after announcement HTTP %i", async (status) => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await database.prepare(
        `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
         VALUES ('kanal-a', 1, ?, NULL)`,
      ).bind(NOW).run();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "denied" }), { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "fallback-1" }] }), { status: 200 }));
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "announcement", text: "Wichtige Nachricht" }],
        diagnostics: [],
      }))], fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/chat/announcements?");
      expect(requestedUrl(fetcher.mock.calls[1]?.[0])).toContain("/helix/chat/messages");
      const rows = await eventLog(database);
      expect(rows.map((row) => row.code)).toEqual(["host.announcement.failed", "host.chat.sent"]);
      // Issue #201 follow-up: Twitch's own explanation used to be dropped
      // here -- sendChatAnnouncement's result carried it, but dispatch only
      // ever copied `status` across into the diagnostic.
      expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
        reason: `http_${String(status)}`, outcome: "sent_as_message", status, twitchMessage: "denied",
      });
    } finally {
      database.close();
    }
  });

  it("truncates a long announcement and records the host diagnostic", async () => {
    const database = new TestD1Database();
    try {
      await withBot(database);
      await database.prepare(
        `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
         VALUES ('kanal-a', 1, ?, NULL)`,
      ).bind(NOW).run();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      await runDispatch(database, [fakeModule("modul-a", () => ({
        actions: [{ kind: "announcement", text: "x".repeat(501) }],
        diagnostics: [],
      }))], fetcher);

      const requestBody = bodyOf(fetcher);
      expect((requestBody.message as string).length).toBe(500);
      expect(requestBody.message).toBe(`${"x".repeat(499)}…`);
      await expect(eventLog(database)).resolves.toMatchObject([
        { code: "template_truncated" }, { code: "host.announcement.sent" },
      ]);
    } finally {
      database.close();
    }
  });

  it("updates the cached channel game straight from a channel.update notification's category", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const updateCachedChannelGameId = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        ...environment(database),
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({ updateCachedChannelGameId }),
        },
      } as unknown as Env;

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: "channel.update",
        triggerId: "update-1",
        payload: { category_id: "509658", category_name: "Just Chatting" },
        receivedAt: NOW,
      }, vi.fn(), []);

      expect(updateCachedChannelGameId).toHaveBeenCalledWith("509658", expect.any(Number));
    } finally {
      database.close();
    }
  });

  it("clears the cached channel game when channel.update reports no category", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const updateCachedChannelGameId = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        ...environment(database),
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({ updateCachedChannelGameId }),
        },
      } as unknown as Env;

      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: "channel.update",
        triggerId: "update-2",
        payload: { category_id: "", category_name: "" },
        receivedAt: NOW,
      }, vi.fn(), []);

      expect(updateCachedChannelGameId).toHaveBeenCalledWith(null, expect.any(Number));
    } finally {
      database.close();
    }
  });

  it("falls back to Helix when the Durable Object's cached game lookup fails", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertAppAccessToken(
        database,
        await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
        "2099-09-21T00:00:00.000Z",
        NOW,
        NOW,
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ title: "Live", game_name: "Some Game", game_id: "77" }] }), { status: 200 }),
      );
      const seenGameIds: (string | null)[] = [];
      const module: BotModule = {
        id: "modul-a",
        settingsSchema: z.object({ prefix: z.string() }),
        defaultSettings: { prefix: "!" },
        eventSubTypes: [CHAT_TYPE],
        handleEvent: async (_event, context) => {
          seenGameIds.push(await context.channelGameId?.() ?? null);
          return { actions: [], diagnostics: [] };
        },
      };
      const runtime = {
        ...environment(database),
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({
            recordChatActivity: vi.fn().mockResolvedValue(0),
            claimAutomatedChatOutput: vi.fn().mockResolvedValue(true),
            isRecentBotChatMessage: vi.fn().mockResolvedValue(false),
            getChatActivityCount: vi.fn().mockResolvedValue(0),
            getCachedChannelGameId: vi.fn().mockRejectedValue(new Error("Durable Object unavailable")),
          }),
        },
      } as unknown as Env;

      await activate(database, "kanal-a", module.id);
      await dispatchEventSubNotification(runtime, {
        channelId: "kanal-a",
        subscriptionType: CHAT_TYPE,
        triggerId: "trigger-1",
        payload: { message: { text: "!hallo" }, chatter_user_id: "user-1", chatter_user_login: "alice" },
        receivedAt: NOW,
      }, fetcher, [module]);

      expect(seenGameIds).toEqual(["77"]);
      expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0])).toContain("/helix/channels?");
    } finally {
      database.close();
    }
  });
});
