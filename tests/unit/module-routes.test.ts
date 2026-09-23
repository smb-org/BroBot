import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule } from "../../src/modules/contract";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

// This suite supplies small module doubles to keep route activation checks
// focused on persistence and authorization, independent of product modules.
const testModuleSchema = z.object({ betrag: z.number() });
let prepareEnableCommand = false;
const testModule: BotModule<typeof testModuleSchema> = {
  id: "test-modul",
  settingsSchema: testModuleSchema,
  defaultSettings: { betrag: 42 },
  eventSubTypes: ["channel.chat.message"],
  onEnable: ({ DB, prepareModuleAudit, now }, channelId) => {
    if (!prepareEnableCommand || prepareModuleAudit === undefined) return;
    const mutation = DB.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
       SELECT ?, 'befehle', '', 'list', 1, 'everyone', 5, NULL, ?, ?
        WHERE changes() > 0
          AND NOT EXISTS (
            SELECT 1 FROM text_commands
             WHERE channel_id = ? AND command_name = 'befehle'
          )`,
    ).bind(channelId, now, now, channelId);
    return [
      mutation,
      prepareModuleAudit({
        channelId,
        moduleId: "test-modul",
        action: "test-modul.settings_changed",
        before: null,
        after: { name: "befehle", kind: "list", enabled: true, minimumTier: "everyone", text: "", cooldownSeconds: 5 },
      }, now),
    ];
  },
};

const mandatoryTestModule: BotModule<typeof testModuleSchema> = {
  id: "channel_events",
  mandatory: true,
  settingsSchema: testModuleSchema,
  defaultSettings: { betrag: 42 },
};

const clipsTestSchema = z.object({});
const defaultEnabledTestModule: BotModule<typeof clipsTestSchema> = {
  id: "clips",
  defaultEnabled: true,
  settingsSchema: clipsTestSchema,
  defaultSettings: {},
};

vi.mock("../../src/modules/registry", () => ({ MODULES: [testModule, mandatoryTestModule, defaultEnabledTestModule] }));

const { createCsrfToken } = await import("../../src/worker/auth/csrf");
const { createSessionCookie } = await import("../../src/worker/auth/session");
const { panelRouter } = await import("../../src/worker/panel/routes");

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: key(3) }, retired: [] }),
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

const auditCount = async (database: TestD1Database): Promise<number> => {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
  return row?.count ?? 0;
};

const insertBotAndAppToken = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
  ).bind("2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
  const keys = environmentKeys.SESSION_ENCRYPTION_KEYS;
  const ciphertext = await encryptJson({ token: "app-token" }, parseKeyRing(keys));
  await database.prepare(
    `INSERT INTO twitch_app_access_token
      (id, access_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
  ).bind(ciphertext, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const remoteSubscription = (channelId: string, id: string) => ({
  id,
  type: "channel.chat.message",
  version: "1",
  status: "enabled",
  condition: { broadcaster_user_id: channelId, user_id: "bot-user" },
  transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
});

// Shared flow for the denial cases: create membership with a role
// in a channel, attempt a PATCH against a (possibly different) target channel,
// check the expected error status and unchanged final state.
const expectDeniedPatch = async (
  database: TestD1Database,
  environment: Env,
  options: {
    memberChannelId: string;
    role: "broadcaster" | "manager" | "operator";
    targetChannelId: string;
    extraChannelIds?: string[];
    expectedStatus: number;
  },
): Promise<void> => {
  await insertChannel(database, options.memberChannelId);
  for (const extraChannelId of options.extraChannelIds ?? []) {
    await insertChannel(database, extraChannelId);
  }
  await insertLoginIdentityAndSession(database, "user-1");
  await insertMember(database, options.memberChannelId, "user-1", options.role);

  const response = await panelRouter.fetch(
    await requestFor("user-1", `/api/channels/${options.targetChannelId}/modules/test-modul`, "PATCH", { enabled: true }),
    environment,
  );

  expect(response.status).toBe(options.expectedStatus);
  await expect(auditCount(database)).resolves.toBe(0);
};

describe("Module management in the panel", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
    prepareEnableCommand = false;
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("returns the registry modules with default settings in the empty state", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules"),
      environment,
    );
    const body = await response.json<{ modules: Array<{ id: string; enabled: boolean; settings: string; mandatory: boolean }> }>();

    expect(response.status).toBe(200);
    expect(body.modules).toEqual([
      { id: "test-modul", enabled: false, settings: '{"betrag":42}', mandatory: false },
      { id: "channel_events", enabled: true, settings: '{"betrag":42}', mandatory: true },
      // No fallback: a default-enabled module with no row reports disabled,
      // exactly like any other module. Only a real row makes it enabled.
      { id: "clips", enabled: false, settings: "{}", mandatory: false },
    ]);
  });

  it("enables a module for a broadcaster and writes exactly one audit entry", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    const body = await response.json<{ module: { id: string; enabled: boolean; settings: string; mandatory: boolean } }>();

    expect(response.status).toBe(200);
    expect(body.module).toEqual({ id: "test-modul", enabled: true, settings: '{"betrag":42}', mandatory: false });
    await expect(auditCount(database)).resolves.toBe(1);

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules"),
      environment,
    );
    const list = await listResponse.json<{ modules: Array<{ id: string; enabled: boolean; settings: string; mandatory: boolean }> }>();
    expect(list.modules).toEqual([
      { id: "test-modul", enabled: true, settings: '{"betrag":42}', mandatory: false },
      { id: "channel_events", enabled: true, settings: '{"betrag":42}', mandatory: true },
      { id: "clips", enabled: false, settings: "{}", mandatory: false },
    ]);
  });

  it("toggles a default-enabled module off and keeps it off with no fallback resurrecting it", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const enable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/clips", "PATCH", { enabled: true }),
      environment,
    );
    expect(enable.status).toBe(200);

    const disable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/clips", "PATCH", { enabled: false }),
      environment,
    );
    expect(disable.status).toBe(200);

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules"),
      environment,
    );
    const list = await listResponse.json<{ modules: Array<{ id: string; enabled: boolean }> }>();
    expect(list.modules).toContainEqual(expect.objectContaining({ id: "clips", enabled: false }));
  });

  it("rejects disabling mandatory channel events with the closed API error", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/channel_events", "PATCH", { enabled: false }),
      environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "module_mandatory" });
    await expect(auditCount(database)).resolves.toBe(0);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_modules WHERE module_id = 'channel_events'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("binds the activation and the dependent list command atomically", async () => {
    prepareEnableCommand = true;
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const first = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    expect(first.status).toBe(200);
    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'").run();
    const beforeReenable = await auditCount(database);
    const second = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(second.status).toBe(200);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands").first())
      .resolves.toEqual({ count: 1 });
    await expect(auditCount(database)).resolves.toBe(beforeReenable + 1);

    await insertChannel(database, "kanal-b");
    await insertMember(database, "kanal-b", "user-1", "broadcaster");
    const beforeFailedAudit = await auditCount(database);
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-b' AND user_id = 'user-1'").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    environment.DB = racingDatabase;
    const failed = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-b/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(failed.status).toBe(409);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_modules WHERE channel_id = 'kanal-b'").first())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands WHERE channel_id = 'kanal-b'").first())
      .resolves.toEqual({ count: 0 });
    await expect(auditCount(database)).resolves.toBe(beforeFailedAudit);
  });

  it("creates the chat subscription immediately when enabling", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [remoteSubscription("kanal-a", "subscription-a")] }), { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(database.prepare(
      "SELECT status, subscription_id, reason FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-a", reason: null });
  });

  it("removes the chat subscription immediately when disabling", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBotAndAppToken(database);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'test-modul', 1, '{"betrag":42}')`,
    ).run();
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, updated_at)
       VALUES ('kanal-a', 'channel.chat.message', 'subscription-a', 'eventsub-v1', 'enabled', NULL, ?)`,
    ).bind("2026-09-18T00:00:00.000Z").run();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [remoteSubscription("kanal-a", "subscription-a")],
        pagination: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.twitch.tv/helix/eventsub/subscriptions?id=subscription-a", expect.objectContaining({ method: "DELETE" }));
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "missing", subscription_id: null });
  });

  it("still responds with 200 on a failed immediate creation and stores the error", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockRejectedValueOnce(new Error("Twitch nicht erreichbar"));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(database.prepare(
      "SELECT status, subscription_id, reason FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "error", subscription_id: null, reason: "network_error" });
  });

  it("doesn't create a subscription without channel:bot consent and stores no Twitch error", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBotAndAppToken(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, updated_at)
       VALUES ('kanal-a', 'channel.chat.message', 'subscription-a', 'eventsub-v1', 'enabled', NULL, ?)`,
    ).bind("2026-09-18T00:00:00.000Z").run();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [remoteSubscription("kanal-a", "subscription-a")],
        pagination: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("?id=subscription-a");
    await expect(database.prepare(
      "SELECT status, subscription_id, reason FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "missing", subscription_id: null, reason: "channel_or_consent_missing" });
  });

  it("denies an operator the ability to enable a module", async () => {
    await expectDeniedPatch(database, environment, {
      memberChannelId: "kanal-a",
      role: "operator",
      targetChannelId: "kanal-a",
      expectedStatus: 403,
    });
  });

  it("rejects a module unknown to the registry", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/unbekanntes-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(404);
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("denies activation in a foreign channel despite a valid session", async () => {
    await expectDeniedPatch(database, environment, {
      memberChannelId: "kanal-a",
      role: "broadcaster",
      targetChannelId: "kanal-b",
      extraChannelIds: ["kanal-b"],
      expectedStatus: 403,
    });
  });

  it("keeps previously written settings when disabling", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false }),
      environment,
    );
    const body = await response.json<{ module: { id: string; enabled: boolean; settings: string; mandatory: boolean } }>();

    expect(response.status).toBe(200);
    expect(body.module).toEqual({ id: "test-modul", enabled: false, settings: '{"betrag":42}', mandatory: false });
    await expect(auditCount(database)).resolves.toBe(2);
  });

  it("rejects a second module settings editor with the current revision and record", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'test-modul', 1, '{"betrag":42}')`,
    ).run();
    const path = "/api/channels/kanal-a/modules/test-modul/settings";
    const loadedA = await panelRouter.fetch(await requestFor("user-1", path), environment);
    const loaded = await loadedA.json<{ settings: { betrag: number }; revision: number }>();
    expect(loaded).toEqual({ settings: { betrag: 42 }, revision: 1 });

    const savedA = await panelRouter.fetch(
      await requestFor("user-1", path, "PATCH", { revision: loaded.revision, settings: { betrag: 41 } }),
      environment,
    );
    expect(savedA.status).toBe(200);
    await expect(savedA.json()).resolves.toMatchObject({ settings: { betrag: 41 }, revision: 2 });

    const savedB = await panelRouter.fetch(
      await requestFor("user-1", path, "PATCH", { revision: loaded.revision, settings: { betrag: 40 } }),
      environment,
    );
    expect(savedB.status).toBe(409);
    await expect(savedB.json()).resolves.toEqual({
      error: "module_settings_changed_concurrently",
      current: { settings: { betrag: 41 }, revision: 2 },
    });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ settings: '{"betrag":41}', revision: 2 });
  });
});
