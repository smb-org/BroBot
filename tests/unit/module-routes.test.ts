import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Hono } from "hono";

import type { BotModule, ModuleRouteEnvironment } from "../../src/modules/contract";
import type * as ModuleRegistry from "../../src/modules/registry";
import { belaboxModule } from "../../src/modules/belabox";
import { belaboxDefaultAlertTexts } from "../../src/modules/belabox/contracts/alert-texts";
import { textCommandModule } from "../../src/modules/text_commands";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

// This suite supplies small module doubles to keep route activation checks
// focused on persistence and authorization, independent of product modules.
const testModuleSchema = z.object({ betrag: z.number() });
let prepareEnableCommand = false;
let enableHookCallCount = 0;
const testModuleRoutes = new Hono<ModuleRouteEnvironment>();
testModuleRoutes.get("/ballots/:ballotId", async (context) => {
  const channelId = context.req.param("channelId");
  if (channelId === undefined) throw new Error("Missing parent channel route parameter.");
  const ballot = await context.get("ballots")(channelId).read(context.req.param("ballotId"));
  return context.json({ ballot });
});
const testModule: BotModule<typeof testModuleSchema> = {
  id: "test-modul",
  navigationCategory: "participation",
  settingsSchema: testModuleSchema,
  defaultSettings: { betrag: 42 },
  routes: testModuleRoutes,
  // Mirrors raid's own event-scoped "viewers"/"channel" declarations (#253),
  // so the template-preview tests below can exercise cross-module shadowing
  // without depending on the real raid module.
  templateFields: {
    betrag: [
      { name: "viewers", group: "event", maxLength: 7, sample: "999" },
      { name: "channel", group: "event", maxLength: 25, sample: "raidkanal" },
    ],
  },
  overlayElements: [{
    kind: "test-modul.countdown",
    configVersion: 1,
    defaultSize: { width: 200, height: 80 },
    defaultConfig: {},
    parseConfig: () => ({}),
    load: () => Promise.resolve({ default: () => null }),
  }],
  eventSubTypes: ["channel.chat.message"],
  onEnable: ({ DB, prepareModuleAudit, now }, channelId) => {
    enableHookCallCount += 1;
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
  navigationCategory: "twitch",
  mandatory: true,
  settingsSchema: testModuleSchema,
  defaultSettings: { betrag: 42 },
};

const clipsTestSchema = z.object({});
const defaultEnabledTestModule: BotModule<typeof clipsTestSchema> = {
  id: "clips",
  navigationCategory: "twitch",
  defaultEnabled: true,
  settingsSchema: clipsTestSchema,
  defaultSettings: {},
};

const registeredModules = [testModule, mandatoryTestModule, defaultEnabledTestModule] as BotModule[];

vi.mock("../../src/modules/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleRegistry>()),
  MODULES: registeredModules,
  variablesForModuleTemplateContext: (_module: unknown, variables: readonly unknown[]) => [...variables],
}));

const { createCsrfToken } = await import("../../src/worker/auth/csrf");
const { createSessionCookie } = await import("../../src/worker/auth/session");
const { panelRouter } = await import("../../src/worker/panel/routes");

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

const urlForFetchInput = (input: RequestInfo | URL | undefined): URL => {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("Expected a URL in the Twitch fetch mock.");
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

const insertBroadcastIdentity = async (database: TestD1Database, scopes: string[]): Promise<void> => {
  await insertLoginIdentityAndSession(database, "kanal-a", scopes);
  const accessToken = await encryptJson({ token: "channel-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS));
  await database.prepare(
    "UPDATE twitch_login_identity SET token_scopes_json = ?, access_token_ciphertext = ? WHERE user_id = 'kanal-a'",
  ).bind(JSON.stringify(scopes), accessToken).run();
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
    enableHookCallCount = 0;
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("updates only the authorized broadcaster channel title and category with its channel token", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung", gameId: "509658" }),
      environment,
    );

    expect(response.status).toBe(204);
    expect(twitchFetch).toHaveBeenCalledTimes(1);
    const [input, init] = twitchFetch.mock.calls[0] ?? [];
    const url = urlForFetchInput(input);
    expect(url.pathname).toBe("/helix/channels");
    expect(url.searchParams.get("broadcaster_id")).toBe("kanal-a");
    expect(init?.method).toBe("PATCH");
    const requestBody = init?.body;
    if (typeof requestBody !== "string") throw new Error("Expected a JSON request body.");
    expect(JSON.parse(requestBody)).toEqual({ title: "Neue Sendung", game_id: "509658" });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer channel-token");
  });

  it("denies operators before attempting a broadcast update", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung", gameId: "" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_manage_denied" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("keeps broadcast management scoped to the route channel", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-b", "user-1", "manager");
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Fremder Kanal", gameId: "" }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("requires the broadcaster scope before calling Twitch", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, []);
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung", gameId: "" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_scope_missing" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("caches category searches by normalized query for 24 hours", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      data: [{ id: "42", name: "Zelda: Ocarina of Time", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg" }],
    }), { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    const search = async (query: string): Promise<Response> => panelRouter.fetch(
      await requestFor("user-1", `/api/channels/kanal-a/games?q=${encodeURIComponent(query)}`),
      environment,
    );

    try {
      const first = await search(" Zelda:   Ocarina of Time ");
      const second = await search("ZELDA:\tOcarina of Time");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ games: [{
        id: "42",
        name: "Zelda: Ocarina of Time",
        boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
      }] });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const firstUrl = urlForFetchInput(fetcher.mock.calls[0]?.[0]);
      expect(firstUrl.pathname).toBe("/helix/search/categories");
      expect(firstUrl.searchParams.get("query")).toBe("zelda: ocarina of time");
      expect(firstUrl.searchParams.get("first")).toBe("20");

      vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
      await search("zelda: ocarina of time");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up selected game IDs through Helix games and caches their box art", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const id = urlForFetchInput(input).searchParams.get("id");
      const game = id === "42"
        ? { id: "42", name: "Zelda: Ocarina of Time", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg" }
        : { id: "77", name: "Elden Ring", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/77-{width}x{height}.jpg" };
      return Promise.resolve(new Response(JSON.stringify({ data: [game] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const lookup = async (): Promise<Response> => panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/games?ids=42,77"),
      environment,
    );

    const first = await lookup();
    const second = await lookup();
    const expected = { games: [
      { id: "42", name: "Zelda: Ocarina of Time", boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg" },
      { id: "77", name: "Elden Ring", boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/77-{width}x{height}.jpg" },
    ] };
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual(expected);
    await expect(second.json()).resolves.toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([input]) => urlForFetchInput(input).pathname)).toEqual([
      "/helix/games",
      "/helix/games",
    ]);
    expect(fetcher.mock.calls.map(([input]) => urlForFetchInput(input).searchParams.get("id"))).toEqual(["42", "77"]);
  });

  it("propagates Twitch ID lookup failures and retries instead of caching them", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    let attempt = 0;
    const fetcher = vi.fn(() => {
      attempt += 1;
      return Promise.resolve(attempt === 1
        ? new Response(JSON.stringify({ message: "rate limited" }), { status: 429 })
        : new Response(JSON.stringify({ data: [{
          id: "42",
          name: "Zelda: Ocarina of Time",
          box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
        }] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const lookup = async (): Promise<Response> => panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/games?ids=42"),
      environment,
    );

    const failed = await lookup();
    const retried = await lookup();

    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "games_unavailable" });
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ games: [{
      id: "42",
      name: "Zelda: Ocarina of Time",
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
    }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns the current category as an empty-query game suggestion", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = urlForFetchInput(input);
      const data = url.pathname === "/helix/channels"
        ? [{ game_id: "42", game_name: "Zelda: Ocarina of Time" }]
        : [{ id: "42", name: "Zelda: Ocarina of Time", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg" }];
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/games?q="),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ games: [{
      id: "42",
      name: "Zelda: Ocarina of Time",
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
    }] });
    const channelUrl = urlForFetchInput(fetcher.mock.calls[0]?.[0]);
    expect(channelUrl.pathname).toBe("/helix/channels");
    expect(channelUrl.searchParams.get("broadcaster_id")).toBe("kanal-a");
  });

  it("keeps empty-query suggestions when Twitch cannot hydrate their artwork", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = urlForFetchInput(input);
      return Promise.resolve(url.pathname === "/helix/channels"
        ? new Response(JSON.stringify({ data: [{ game_id: "42", game_name: "Zelda: Ocarina of Time" }] }), { status: 200 })
        : new Response(JSON.stringify({ message: "rate limited" }), { status: 429 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/games?q="),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ games: [{ id: "42", name: "Zelda: Ocarina of Time" }] });
  });

  it("combines a channel's current and recent categories without leaking another channel's history", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotAndAppToken(database);
    await database.prepare(
      `INSERT INTO channel_game_history (channel_id, game_id, game_name, last_seen_at_ms)
       VALUES ('kanal-a', '77', 'Elden Ring', 1790726400000),
              ('kanal-a', '99', 'Stardew Valley', 1790640000000),
              ('kanal-b', '88', 'Another Channel Game', 1790812800000)`,
    ).run();
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = urlForFetchInput(input);
      const gameId = url.searchParams.get("id") ?? "";
      const body = url.pathname === "/helix/channels"
        ? { data: [{ game_id: "42", game_name: "Zelda: Ocarina of Time" }] }
        : {
          data: [{
            id: gameId,
            name: gameId === "42" ? "Zelda: Ocarina of Time"
              : gameId === "77" ? "Elden Ring" : "Stardew Valley",
            box_art_url: `https://static-cdn.jtvnw.net/ttv-boxart/${gameId}-{width}x{height}.jpg`,
          }],
        };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/games?q="),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ games: [
      { id: "42", name: "Zelda: Ocarina of Time", boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg" },
      { id: "77", name: "Elden Ring", boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/77-{width}x{height}.jpg" },
      { id: "99", name: "Stardew Valley", boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/99-{width}x{height}.jpg" },
    ] });
  });

  it("keeps an event-resolvable host declaration when a module shadows its name without a resolver", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/template-variables"),
      environment,
    );
    const body = await response.json<{ variables: Array<{ name: string; moduleId: string; contexts?: readonly string[] }> }>();
    const viewers = body.variables.find((variable) => variable.name === "viewers");

    expect(response.status).toBe(200);
    expect(viewers).toMatchObject({ moduleId: "host", contexts: ["chat_command", "event", "system"] });
  });

  it("binds route ballot access to the authorized channel and mounted module", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const readBallot = vi.fn().mockResolvedValue({ counts: [5, 3], revision: 8 });
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ readBallot })),
    } as unknown as Env["CHANNEL"];

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul/ballots/poll-a"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ballot: { counts: [5, 3], revision: 8 } });
    expect(readBallot).toHaveBeenCalledWith("test-modul", "poll-a");
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

  it("invalidates only overlays containing the toggled module's declared element", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-countdown', 'kanal-a', 'Countdown', ?, ?), ('overlay-other', 'kanal-a', 'Other', ?, ?)`,
    ).bind("2026-09-25T12:00:00.000Z", "2026-09-25T12:00:00.000Z", "2026-09-25T12:00:00.000Z", "2026-09-25T12:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind)
       VALUES ('element-countdown', 'kanal-a', 'overlay-countdown', 'test-modul.countdown'),
              ('element-other', 'kanal-a', 'overlay-other', 'test-modul.other')`,
    ).run();
    const publish = vi.fn((messages: readonly unknown[]) => {
      void messages;
      return Promise.resolve();
    });
    environment = {
      ...environment,
      CHANNEL: {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({ publish })),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject([{
      type: "overlay.changed",
      payload: { overlayId: "overlay-countdown", revision: 1 },
    }]);
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

  it("replans schedule inputs only when a module actually transitions into being enabled", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    const notifyScheduleInputsChanged = vi.fn(() => Promise.resolve());
    environment = {
      ...environment,
      CHANNEL: {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({ publish: () => Promise.resolve(), notifyScheduleInputsChanged })),
      },
    } as unknown as Env;

    const firstEnable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/clips", "PATCH", { enabled: true }),
      environment,
    );
    expect(firstEnable.status).toBe(200);
    expect(notifyScheduleInputsChanged).toHaveBeenCalledExactlyOnceWith("activation");

    notifyScheduleInputsChanged.mockClear();
    const reEnable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/clips", "PATCH", { enabled: true }),
      environment,
    );
    expect(reEnable.status).toBe(200);
    expect(notifyScheduleInputsChanged).not.toHaveBeenCalled();

    const disable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/clips", "PATCH", { enabled: false }),
      environment,
    );
    expect(disable.status).toBe(200);
    expect(notifyScheduleInputsChanged).not.toHaveBeenCalled();
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

  it("preserves settings and skips the initialization hook when re-enabling", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const firstEnable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    expect(firstEnable.status).toBe(200);
    expect(enableHookCallCount).toBe(1);

    const settingsPath = "/api/channels/kanal-a/modules/test-modul/settings";
    const loaded = await (await panelRouter.fetch(await requestFor("user-1", settingsPath), environment))
      .json<{ revision: number }>();
    const saved = await panelRouter.fetch(
      await requestFor("user-1", settingsPath, "PATCH", { revision: loaded.revision, settings: { betrag: 17 } }),
      environment,
    );
    expect(saved.status).toBe(200);

    const disable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false }),
      environment,
    );
    expect(disable.status).toBe(200);
    const reenable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    const body = await reenable.json<{ module: { settings: string } }>();

    expect(reenable.status).toBe(200);
    expect(body.module.settings).toBe('{"betrag":17}');
    expect(enableHookCallCount).toBe(1);
  });

  it("returns the failing settings path and reason from the module schema", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const enabled = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    expect(enabled.status).toBe(200);
    const loaded = await (await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul/settings"),
      environment,
    )).json<{ revision: number }>();

    const invalid = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul/settings", "PATCH", {
        revision: loaded.revision,
        settings: { betrag: "not a number" },
      }),
      environment,
    );
    const body = await invalid.json<{ error: string; path: string; reasonCode: string; reason: string }>();

    expect(invalid.status).toBe(400);
    expect(body).toMatchObject({ error: "module_settings_invalid", path: "settings.betrag", reasonCode: "invalid_type" });
    expect(body.reason.length).toBeGreaterThan(0);
  });

  it("rejects re-enabling when settings change after the handler reads the module", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision)
       VALUES ('kanal-a', 'test-modul', 0, '{"betrag":42}', 1)`,
    ).run();

    let interleaved = false;
    let concurrentSaveResponse: Response | undefined;
    const interleavingDatabase = {
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        if (interleaved || !sql.trimStart().startsWith("SELECT channel_id, module_id") || !sql.includes("FROM channel_modules")) {
          return statement;
        }
        const wrapped = {
          bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
            statement.bind(...values);
            return wrapped;
          },
          first: async <T>() => {
            const row = await statement.first<T>();
            if (!interleaved) {
              interleaved = true;
              concurrentSaveResponse = await panelRouter.fetch(
                await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul/settings", "PATCH", {
                  revision: 1,
                  settings: { betrag: 17 },
                }),
                environment,
              );
            }
            return row;
          },
          all: <T>(...typeHint: readonly T[]) => statement.all<T>(...typeHint),
          run: () => statement.run(),
        };
        return wrapped;
      },
      batch: database.batch.bind(database),
    } as unknown as D1Database;
    environment.DB = interleavingDatabase;

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(concurrentSaveResponse?.status).toBe(200);
    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT enabled, initialized, settings, revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ enabled: 0, initialized: 0, settings: '{"betrag":17}', revision: 2 });
  });

  it("initializes an existing never-enabled module row once and preserves its data", async () => {
    prepareEnableCommand = true;
    await insertChannel(database, "kanal-legacy");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-legacy", "user-1", "broadcaster");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-legacy', 'test-modul', 0, '{"betrag":17}')`,
    ).run();

    const enable = async (enabled: boolean): Promise<Response> => panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-legacy/modules/test-modul", "PATCH", { enabled }),
      environment,
    );

    const firstEnable = await enable(true);
    expect(firstEnable.status).toBe(200);
    expect(enableHookCallCount).toBe(1);
    await expect(database.prepare(
      "SELECT initialized FROM channel_modules WHERE channel_id = 'kanal-legacy' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ initialized: 1 });
    await expect(database.prepare(
      "SELECT command_name FROM text_commands WHERE channel_id = 'kanal-legacy' AND command_name = 'befehle'",
    ).first()).resolves.toEqual({ command_name: "befehle" });
    await expect(database.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-legacy' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ settings: '{"betrag":17}' });

    await database.prepare(
      "UPDATE text_commands SET response_text = 'Customized list response' WHERE channel_id = 'kanal-legacy' AND command_name = 'befehle'",
    ).run();
    expect((await enable(false)).status).toBe(200);
    expect((await enable(true)).status).toBe(200);

    expect(enableHookCallCount).toBe(1);
    await expect(database.prepare(
      "SELECT response_text FROM text_commands WHERE channel_id = 'kanal-legacy' AND command_name = 'befehle'",
    ).first()).resolves.toEqual({ response_text: "Customized list response" });
    await expect(database.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-legacy' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ settings: '{"betrag":17}' });
  });

  it("localizes legacy BELABOX defaults without replacing custom alert text", async () => {
    registeredModules.push(belaboxModule);
    const onEnable = vi.spyOn(belaboxModule, "onEnable");
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) })),
    } as unknown as Env["CHANNEL"];
    try {
      await insertChannel(database, "kanal-belabox-legacy");
      await insertLoginIdentityAndSession(database, "user-1");
      await insertMember(database, "kanal-belabox-legacy", "user-1", "broadcaster");
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-belabox-legacy', 'belabox', 0, ?)`,
      ).bind(JSON.stringify({
        ...belaboxDefaultAlertTexts("en"),
        lowText: "Custom low message",
      })).run();

      const enable = async (enabled: boolean): Promise<Response> => panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-belabox-legacy/modules/belabox", "PATCH", { enabled }),
        environment,
      );
      const firstEnable = await enable(true);
      expect(firstEnable.status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();

      const readSettings = async (): Promise<Record<string, unknown>> => {
        const row = await database.prepare(
          "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-belabox-legacy' AND module_id = 'belabox'",
        ).first<{ settings: string }>();
        return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>;
      };
      await expect(readSettings()).resolves.toMatchObject({
        lowText: "Custom low message",
        disconnectText: belaboxDefaultAlertTexts("de").disconnectText,
        recoveryText: belaboxDefaultAlertTexts("de").recoveryText,
      });

      expect((await enable(false)).status).toBe(200);
      expect((await enable(true)).status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();
      await expect(readSettings()).resolves.toMatchObject({ lowText: "Custom low message" });
    } finally {
      onEnable.mockRestore();
      registeredModules.pop();
    }
  });

  it("preserves BELABOX chat texts and runs its initialization hook only once", async () => {
    registeredModules.push(belaboxModule);
    const onEnable = vi.spyOn(belaboxModule, "onEnable");
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) })),
    } as unknown as Env["CHANNEL"];
    try {
      await insertChannel(database, "kanal-belabox");
      await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = 'kanal-belabox'").run();
      await insertLoginIdentityAndSession(database, "user-1");
      await insertMember(database, "kanal-belabox", "user-1", "broadcaster");

      const enable = async (enabled: boolean): Promise<Response> => panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-belabox/modules/belabox", "PATCH", { enabled }),
        environment,
      );
      expect((await enable(false)).status).toBe(200);
      await expect(database.prepare(
        "SELECT COUNT(*) AS count FROM channel_modules WHERE channel_id = 'kanal-belabox' AND module_id = 'belabox'",
      ).first()).resolves.toEqual({ count: 0 });

      const firstEnable = await enable(true);
      expect(firstEnable.status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();
      const firstSettingsRow = await database.prepare(
        "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-belabox' AND module_id = 'belabox'",
      ).first<{ settings: string }>();
      expect(JSON.parse(firstSettingsRow?.settings ?? "{}") as Record<string, unknown>)
        .toMatchObject(belaboxDefaultAlertTexts("en"));

      await database.prepare(
        `UPDATE channel_modules
            SET settings = json_set(settings, '$.lowText', ?, '$.disconnectText', ?, '$.recoveryText', ?, '$.intervalSeconds', 45)
          WHERE channel_id = 'kanal-belabox' AND module_id = 'belabox'`,
      ).bind("Custom low message", "Custom disconnect message", "Custom recovery message").run();

      expect((await enable(false)).status).toBe(200);
      const reenable = await enable(true);
      expect(reenable.status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();

      const saved = await database.prepare(
        "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-belabox' AND module_id = 'belabox'",
      ).first<{ settings: string }>();
      expect(JSON.parse(saved?.settings ?? "{}") as Record<string, unknown>).toMatchObject({
        lowText: "Custom low message",
        disconnectText: "Custom disconnect message",
        recoveryText: "Custom recovery message",
        intervalSeconds: 45,
      });
    } finally {
      onEnable.mockRestore();
      registeredModules.pop();
    }
  });

  it("keeps the customized text-command list and does not rerun its initialization hook", async () => {
    registeredModules.push(textCommandModule);
    const onEnable = vi.spyOn(textCommandModule, "onEnable");
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()) })),
    } as unknown as Env["CHANNEL"];
    try {
      await insertChannel(database, "kanal-text");
      await insertLoginIdentityAndSession(database, "user-1");
      await insertMember(database, "kanal-text", "user-1", "broadcaster");

      const enable = async (enabled: boolean): Promise<Response> => panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-text/modules/text_commands", "PATCH", { enabled }),
        environment,
      );
      expect((await enable(false)).status).toBe(200);
      await expect(database.prepare(
        "SELECT COUNT(*) AS count FROM channel_modules WHERE channel_id = 'kanal-text' AND module_id = 'text_commands'",
      ).first()).resolves.toEqual({ count: 0 });

      const firstEnable = await enable(true);
      expect(firstEnable.status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();
      await expect(database.prepare(
        "SELECT command_name, response_text, kind, enabled FROM text_commands WHERE channel_id = 'kanal-text' AND command_name = 'befehle'",
      ).first()).resolves.toEqual({ command_name: "befehle", response_text: "", kind: "list", enabled: 1 });

      await database.prepare(
        "UPDATE text_commands SET response_text = 'Customized list response' WHERE channel_id = 'kanal-text' AND command_name = 'befehle'",
      ).run();

      expect((await enable(false)).status).toBe(200);
      const reenable = await enable(true);
      expect(reenable.status).toBe(200);
      expect(onEnable).toHaveBeenCalledOnce();
      await expect(database.prepare(
        "SELECT response_text FROM text_commands WHERE channel_id = 'kanal-text' AND command_name = 'befehle'",
      ).first()).resolves.toEqual({ response_text: "Customized list response" });
    } finally {
      onEnable.mockRestore();
      registeredModules.pop();
    }
  });

  it("does not reset BELABOX texts when a concurrent first enable loses the insert", async () => {
    registeredModules.push(belaboxModule);
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) })),
    } as unknown as Env["CHANNEL"];
    try {
      await insertChannel(database, "kanal-belabox-race");
      await insertLoginIdentityAndSession(database, "user-1");
      await insertMember(database, "kanal-belabox-race", "user-1", "broadcaster");

      let moduleReadCount = 0;
      let releaseModuleReads!: () => void;
      const moduleReadsReleased = new Promise<void>((resolve) => { releaseModuleReads = resolve; });
      let batchCount = 0;
      let holdSecondBatch!: () => void;
      let secondBatchEntered!: () => void;
      const secondBatchReleased = new Promise<void>((resolve) => { holdSecondBatch = resolve; });
      const secondBatchStarted = new Promise<void>((resolve) => { secondBatchEntered = resolve; });
      const racingDatabase = {
        prepare: (sql: string) => {
          const statement = database.prepare(sql);
          if (!sql.trimStart().startsWith("SELECT channel_id, module_id") || !sql.includes("FROM channel_modules")) return statement;
          const wrapped = {
            bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
              statement.bind(...values);
              return wrapped;
            },
            first: async <T>() => {
              moduleReadCount += 1;
              if (moduleReadCount === 2) releaseModuleReads();
              await moduleReadsReleased;
              return statement.first<T>();
            },
          };
          return wrapped;
        },
        batch: async (statements: TestPreparedStatement[]) => {
          batchCount += 1;
          if (batchCount === 2) {
            secondBatchEntered();
            await secondBatchReleased;
          }
          return database.batch(statements);
        },
      } as unknown as D1Database;
      environment.DB = racingDatabase;

      const enable = async (): Promise<Response> => panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-belabox-race/modules/belabox", "PATCH", { enabled: true }),
        environment,
      );
      const first = enable();
      const second = enable();
      await secondBatchStarted;
      await database.prepare(
        `UPDATE channel_modules
            SET settings = json_set(settings, '$.lowText', 'Custom low message', '$.disconnectText', 'Custom disconnect message', '$.recoveryText', 'Custom recovery message')
          WHERE channel_id = 'kanal-belabox-race' AND module_id = 'belabox'`,
      ).run();
      holdSecondBatch();
      const responses = await Promise.all([first, second]);

      expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 409]);
      const row = await database.prepare(
        "SELECT settings FROM channel_modules WHERE channel_id = 'kanal-belabox-race' AND module_id = 'belabox'",
      ).first<{ settings: string }>();
      expect(JSON.parse(row?.settings ?? "{}") as Record<string, unknown>).toMatchObject({
        lowText: "Custom low message",
        disconnectText: "Custom disconnect message",
        recoveryText: "Custom recovery message",
      });
    } finally {
      registeredModules.pop();
    }
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
    expect(loaded).toEqual({ settings: { betrag: 42 }, revision: 1, variables: [] });

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

  it("returns the revision written by this save when a later save interleaves before the response", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'test-modul', 1, '{"betrag":42}')`,
    ).run();
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        const result = await database.batch(statements);
        await database.prepare(
          `UPDATE channel_modules SET settings = '{"betrag":99}', revision = revision + 1
            WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'`,
        ).run();
        return result;
      },
    } as unknown as TestD1Database;

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul/settings", "PATCH", {
        revision: 1, settings: { betrag: 41 },
      }),
      environmentFor(racingDatabase),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ settings: { betrag: 41 }, revision: 2, warnings: [] });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ settings: '{"betrag":99}', revision: 3 });
  });

  describe("Template preview", () => {
    it("renders the host system value for {viewers}, unshadowed by another module's own local declaration", async () => {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "user-1");
      await insertMember(database, "kanal-a", "user-1", "operator");

      // test-modul declares its own local "viewers"/"channel" (like raid's event
      // variables). The preview below has nothing to do with that module — it
      // must still resolve the host's system "viewers", not leave it literal.
      const response = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-a/template-preview", "POST", {
          text: "{viewers}",
          templateContext: "event",
          streamState: "online",
          game: null,
          chatStatus: null,
        }),
        environment,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ text: "0", diagnostics: [] });
    });
  });
});
