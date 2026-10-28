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
import { createReadInterleavingDatabase, TestD1Database, type TestPreparedStatement } from "./test-d1";

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
const quizOverlayTestModule: BotModule<typeof clipsTestSchema> = {
  id: "quiz",
  navigationCategory: "participation",
  settingsSchema: clipsTestSchema,
  defaultSettings: {},
  overlayElements: [{
    kind: "quiz.session",
    configVersion: 1,
    defaultSize: { width: 300, height: 180 },
    defaultConfig: {},
    parseConfig: () => ({}),
    load: () => Promise.resolve({ default: () => null }),
  }],
};

const registeredModules = [testModule, mandatoryTestModule, defaultEnabledTestModule] as BotModule[];
const dependencyTestSchema = z.object({});
const dependencyPointsModule: BotModule<typeof dependencyTestSchema> = {
  id: "points",
  navigationCategory: "participation",
  settingsSchema: dependencyTestSchema,
  defaultSettings: {},
};
const dependentGameTestModule: BotModule<typeof dependencyTestSchema> = {
  id: "test_game_requires_points",
  navigationCategory: "participation",
  settingsSchema: dependencyTestSchema,
  defaultSettings: {},
  requiresModules: ["points"],
};
const scopedTestModule: BotModule<typeof dependencyTestSchema> = {
  id: "scoped-test-module",
  navigationCategory: "participation",
  settingsSchema: dependencyTestSchema,
  defaultSettings: {},
  broadcasterScopes: ["channel:manage:polls"],
};

const addDependencyTestModules = (): void => {
  registeredModules.push(dependencyPointsModule, dependentGameTestModule);
};

const dependencyTestCard = (protects: string, failsWhen: string, noClaim: string): string =>
  `protects=${protects}; fails_when=${failsWhen}; no_claim=${noClaim}`;

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
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
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
  const refreshToken = await encryptJson({ token: "channel-refresh-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS));
  await database.prepare(
    "UPDATE twitch_login_identity SET token_scopes_json = ?, access_token_ciphertext = ?, refresh_token_ciphertext = ? WHERE user_id = 'kanal-a'",
  ).bind(JSON.stringify(scopes), accessToken, refreshToken).run();
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
    registeredModules.splice(3);
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

  it("keeps a rotated broadcast token when the first D1 persistence attempt fails", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);

    const originalBatch = database.batch.bind(database);
    let tokenWriteAttempts = 0;
    database.batch = (statements) => {
      if (statements.some((statement) => (statement as unknown as { sql: string }).sql.includes("SET access_token_ciphertext"))) {
        tokenWriteAttempts += 1;
        if (tokenWriteAttempts === 1) return Promise.reject(new Error("Transient D1 failure."));
      }
      return originalBatch(statements);
    };

    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlForFetchInput(input);
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "channel-token-refreshed",
          refresh_token: "channel-refresh-refreshed",
          expires_in: 7_200,
          scope: ["channel:manage:broadcast"],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(authorization === "Bearer channel-token"
        ? new Response(null, { status: 401 })
        : new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung", gameId: "509658" }),
      environment,
    );

    expect(response.status).toBe(204);
    expect(tokenWriteAttempts).toBe(2);
    expect(twitchFetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a concurrent broadcast save after another refresh rotates the identity", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);

    let initialHelixRequests = 0;
    let refreshRequests = 0;
    let releaseInitialHelix!: () => void;
    const initialHelixBarrier = new Promise<void>((resolve) => { releaseInitialHelix = resolve; });
    let releaseWinnerUse!: () => void;
    const winnerUse = new Promise<void>((resolve) => { releaseWinnerUse = resolve; });
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = urlForFetchInput(input);
      if (url.pathname === "/oauth2/token") {
        refreshRequests += 1;
        if (refreshRequests === 1) {
          return new Response(JSON.stringify({
            access_token: "channel-token-winner",
            refresh_token: "channel-refresh-winner",
            expires_in: 7_200,
            scope: ["channel:manage:broadcast"],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        await winnerUse;
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer channel-token") {
        initialHelixRequests += 1;
        if (initialHelixRequests === 2) releaseInitialHelix();
        await initialHelixBarrier;
        return new Response(null, { status: 401 });
      }
      if (authorization === "Bearer channel-token-winner") releaseWinnerUse();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", twitchFetch);

    const responses = await Promise.all([
      requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Titel A", gameId: "509658" })
        .then((request) => panelRouter.fetch(request, environment)),
      requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Titel B", gameId: "509658" })
        .then((request) => panelRouter.fetch(request, environment)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([204, 204]);
    expect(refreshRequests).toBe(1);
  });

  it("sends only fields changed by each manager to Twitch", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const bodies: unknown[] = [];
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const firstManagerSave = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Aktueller Titel" }),
      environment,
    );
    const secondManagerSave = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { gameId: "509658" }),
      environment,
    );

    expect(firstManagerSave.status).toBe(204);
    expect(secondManagerSave.status).toBe(204);
    expect(bodies).toEqual([{ title: "Aktueller Titel" }, { game_id: "509658" }]);
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

  it.each([
    {
      name: "created",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ data: [{ id: "marker-1", created_at: "2026-10-22T12:00:00Z", position_seconds: 323 }] }), { status: 200 }),
      expected: { result: "created", positionSeconds: 323 },
    },
    {
      name: "broadcaster cannot create a marker for another broadcaster",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ error: "Forbidden", status: 403, message: "The user does not have permission to perform this action on this broadcaster" }), { status: 403 }),
      expected: { result: "not_broadcaster" },
    },
    {
      name: "offline",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ message: "Broadcaster is not live" }), { status: 404 }),
      expected: { result: "offline" },
    },
    {
      name: "invalid Helix request",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 }),
      expected: { result: "failed" },
    },
    {
      name: "rate limited",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ error: "Too Many Requests", status: 429, message: "Too many requests" }), { status: 429, headers: { "Ratelimit-Reset": String(Math.ceil(Date.now() / 1_000) + 30) } }),
      expected: { result: "rate_limited" },
    },
    {
      name: "other Helix failures",
      scopes: ["channel:manage:broadcast"],
      response: () => new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 }),
      expected: { result: "failed" },
    },
  ])("maps stream marker result: $name", async ({ scopes, response: helixResponse, expected }) => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, scopes);
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(helixResponse()));
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    const resultBody: unknown = await response.json();
    if (expected.result === "rate_limited") {
      expect(resultBody).toMatchObject(expected);
      if (typeof resultBody !== "object" || resultBody === null || !("retryAfter" in resultBody)) {
        throw new Error("Expected Twitch's rate limit reset time.");
      }
      expect(resultBody.retryAfter).toBeGreaterThanOrEqual(30);
      expect(resultBody.retryAfter).toBeLessThanOrEqual(31);
    } else {
      expect(resultBody).toEqual(expected);
    }
    if (scopes.length === 0) {
      expect(twitchFetch).not.toHaveBeenCalled();
    } else {
      expect(twitchFetch).toHaveBeenCalledOnce();
      const [input, init] = twitchFetch.mock.calls[0] ?? [];
      const url = urlForFetchInput(input);
      expect(url.pathname).toBe("/helix/streams/markers");
      expect(url.search).toBe("");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ user_id: "kanal-a", description: "BroBot marker" }));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer channel-token");
    }
  });

  it("refreshes an expired marker token and retries once with the Twitch body contract", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlForFetchInput(input);
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "channel-token-refreshed",
          refresh_token: "channel-refresh-refreshed",
          expires_in: 7_200,
          scope: ["channel:manage:broadcast"],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(authorization === "Bearer channel-token"
        ? new Response(JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }), { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: "marker-1", created_at: "2026-10-22T12:00:00Z", position_seconds: 323 }] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "created", positionSeconds: 323 });
    const helixCalls = twitchFetch.mock.calls.filter(([input]) => urlForFetchInput(input).pathname === "/helix/streams/markers");
    expect(helixCalls).toHaveLength(2);
    expect(helixCalls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ user_id: "kanal-a", description: "BroBot marker" }),
      JSON.stringify({ user_id: "kanal-a", description: "BroBot marker" }),
    ]);
    expect(helixCalls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual([
      "Bearer channel-token",
      "Bearer channel-token-refreshed",
    ]);
  });

  it("rechecks management authorization before retrying a marker after token refresh", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = urlForFetchInput(input);
      if (url.pathname === "/oauth2/token") {
        return new Response(JSON.stringify({
          access_token: "channel-token-refreshed",
          refresh_token: "channel-refresh-refreshed",
          expires_in: 7_200,
          scope: ["channel:manage:broadcast"],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (new Headers(init?.headers).get("Authorization") === "Bearer channel-token") {
        await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
        return new Response(JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "marker-1", position_seconds: 323 }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_manage_denied" });
    expect(twitchFetch.mock.calls.filter(([input]) => urlForFetchInput(input).pathname === "/helix/streams/markers")).toHaveLength(1);
  });

  it("maps a 401 to missing scope when the refreshed identity no longer has the broadcast scope", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlForFetchInput(input);
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "channel-token-refreshed",
          refresh_token: "channel-refresh-refreshed",
          expires_in: 7_200,
          scope: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }), { status: 401 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: "scope_missing",
      error: "broadcast_scope_missing",
      grantHref: "/auth/channels/kanal-a/broadcaster-scopes/broadcast",
    });
    expect(twitchFetch).toHaveBeenCalledTimes(2);
  });

  it("reports an expired marker token when refresh fails", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    environment.CHANNEL = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ revokeUser: () => Promise.resolve() }),
    } as unknown as Env["CHANNEL"];
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlForFetchInput(input);
      return Promise.resolve(url.pathname === "/oauth2/token"
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }), { status: 401 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "token_expired" });
    expect(twitchFetch).toHaveBeenCalledTimes(2);
    await expect(database.prepare(
      "SELECT status, scopes_json, token_scopes_json, reason FROM twitch_login_identity WHERE user_id = 'kanal-a'",
    ).first()).resolves.toEqual({
      status: "revoked",
      scopes_json: "[]",
      token_scopes_json: "[]",
      reason: "authorization_revoked",
    });
  });

  it("keeps the broadcast update failure response when refresh discovers invalid_grant", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    environment.CHANNEL = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ revokeUser: () => Promise.resolve() }),
    } as unknown as Env["CHANNEL"];
    const twitchFetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlForFetchInput(input);
      return Promise.resolve(url.pathname === "/oauth2/token"
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }), { status: 401 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung" }),
      environment,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_update_failed" });
    await expect(database.prepare(
      "SELECT status, scopes_json, token_scopes_json FROM twitch_login_identity WHERE user_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "revoked", scopes_json: "[]", token_scopes_json: "[]" });
  });

  it("returns the broadcast scope grant target before calling Helix when the scope is absent", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, []);
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: "scope_missing",
      error: "broadcast_scope_missing",
      grantHref: "/auth/channels/kanal-a/broadcaster-scopes/broadcast",
    });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("keeps the existing panel responses for a broadcaster identity revoked before the request", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    await database.prepare(
      "UPDATE twitch_login_identity SET status = 'revoked', scopes_json = '[]', token_scopes_json = '[]' WHERE user_id = 'kanal-a'",
    ).run();
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const markerResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );
    const broadcastResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast", "PATCH", { title: "Neue Sendung" }),
      environment,
    );

    expect(markerResponse.status).toBe(200);
    await expect(markerResponse.json()).resolves.toEqual({ result: "failed" });
    expect(broadcastResponse.status).toBe(409);
    await expect(broadcastResponse.json()).resolves.toEqual({ error: "broadcast_identity_missing" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it.each([
    { scopes: ["channel:manage:broadcast"], available: true },
    { scopes: [], available: false },
  ])("reads stream marker scope availability from the channel broadcaster identity", async ({ scopes, available }) => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBroadcastIdentity(database, scopes);
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers/availability"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ manageScopeAvailable: available });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("denies an operator before calling Helix to create a stream marker", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_manage_denied" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("rechecks management authorization immediately before calling Helix", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);
    environment.DB = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("SELECT channel_id FROM channels WHERE channel_id = ?"),
      async () => {
        await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
      },
    );

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_manage_denied" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("denies a non-member before calling Helix to create a stream marker", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("keeps stream marker creation scoped to the route channel", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-b", "user-1", "manager");
    await insertBroadcastIdentity(database, ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/broadcast/markers", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
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

  it(`requires points before a dependent module can be enabled (${dependencyTestCard("the dependency guard rejects the mutation and audit together", "an unsupported game becomes enabled while points is disabled", "fictional module descriptors exercise the generic route guard")})`, async () => {
    addDependencyTestModules();
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "module_requires" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_modules WHERE module_id = 'test_game_requires_points'").first())
      .resolves.toEqual({ count: 0 });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it(`blocks disabling points and carries a game's last disable revision into re-enable (${dependencyTestCard("the route passes last_disabled_revision when reopening a dependent game", "re-enable opens a gate without cancelling rounds from a missed disable", "the fake ChannelObject verifies the route RPC arguments; the Durable Object refund behavior has a separate worker test")})`, async () => {
    addDependencyTestModules();
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    const setGate = vi.fn(() => Promise.resolve({ applied: true }));
    const cancelOpenRounds = vi.fn(() => Promise.resolve(2));
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ setGameModuleGate: setGate, cancelOpenGameRounds: cancelOpenRounds })),
    } as unknown as Env["CHANNEL"];

    for (const [moduleId, enabled] of [["points", true], ["test_game_requires_points", true]] as const) {
      const response = await panelRouter.fetch(
        await requestFor("user-1", `/api/channels/channel-demo/modules/${moduleId}`, "PATCH", { enabled }),
        environment,
      );
      expect(response.status).toBe(200);
    }

    const disablePoints = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/points", "PATCH", { enabled: false }),
      environment,
    );
    expect(disablePoints.status).toBe(409);
    await expect(disablePoints.json()).resolves.toEqual({ error: "module_required_by", dependentModules: ["test_game_requires_points"] });
    expect(setGate).toHaveBeenCalledTimes(2);
    expect(cancelOpenRounds).not.toHaveBeenCalled();

    const disableGame = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", { enabled: false }),
      environment,
    );
    expect(disableGame.status).toBe(200);
    expect(setGate).toHaveBeenLastCalledWith("test_game_requires_points", true, 2, 2);
    expect(cancelOpenRounds).toHaveBeenCalledTimes(1);
    expect(cancelOpenRounds).toHaveBeenLastCalledWith("test_game_requires_points", 2);

    const reenableGame = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", { enabled: true }),
      environment,
    );
    expect(reenableGame.status).toBe(200);
    expect(setGate).toHaveBeenLastCalledWith("test_game_requires_points", false, 3, 2);
    await expect(database.prepare("SELECT enabled FROM channel_modules WHERE channel_id = 'channel-demo' AND module_id = 'points'").first())
      .resolves.toEqual({ enabled: 1 });
  });

  it(`reconciles round cancellation when the durable gate already has the disable revision (${dependencyTestCard("a route retry still requests cancellation when the gate already has the matching close revision", "a duplicate gate result suppresses a needed escrow refund", "fake ChannelObject methods report an already closed gate and record cancellation without worker storage")})`, async () => {
    addDependencyTestModules();
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    const setGate = vi.fn((_moduleId: string, closed: boolean) => Promise.resolve({ applied: !closed }));
    const cancelOpenRounds = vi.fn(() => Promise.resolve(1));
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ setGameModuleGate: setGate, cancelOpenGameRounds: cancelOpenRounds })),
    } as unknown as Env["CHANNEL"];

    for (const moduleId of ["points", "test_game_requires_points"]) {
      const response = await panelRouter.fetch(
        await requestFor("user-1", `/api/channels/channel-demo/modules/${moduleId}`, "PATCH", { enabled: true }),
        environment,
      );
      expect(response.status).toBe(200);
    }
    const disable = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", { enabled: false }),
      environment,
    );

    expect(disable.status).toBe(200);
    expect(setGate).toHaveBeenLastCalledWith("test_game_requires_points", true, 2, 2);
    expect(cancelOpenRounds).toHaveBeenCalledOnce();
    expect(cancelOpenRounds).toHaveBeenLastCalledWith("test_game_requires_points", 2);
  });

  it(`keeps a committed disable successful and retries cancellation (${dependencyTestCard("a failed post-commit cancellation logs once, keeps the committed disable successful, and a retry recovers refunds with the original revision", "a failed cancellation returns an API error, goes unlogged, changes the committed state, or cannot recover refunds on retry", "fake ChannelObject methods model one failed refund call followed by success")})`, async () => {
    addDependencyTestModules();
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    let gateRevision = 0;
    const setGate = vi.fn((_moduleId: string, closed: boolean, revision: number) => {
      if (revision <= gateRevision) return Promise.resolve({ applied: false });
      gateRevision = revision;
      return Promise.resolve({ applied: closed });
    });
    const cancelOpenRounds = vi.fn()
      .mockRejectedValueOnce(new Error("simulated_refund_failure"))
      .mockResolvedValueOnce(1);
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({
        notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()),
        setGameModuleGate: setGate,
        cancelOpenGameRounds: cancelOpenRounds,
      })),
    } as unknown as Env["CHANNEL"];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      for (const moduleId of ["points", "test_game_requires_points"]) {
        const response = await panelRouter.fetch(
          await requestFor("user-1", `/api/channels/channel-demo/modules/${moduleId}`, "PATCH", { enabled: true }),
          environment,
        );
        expect(response.status).toBe(200);
      }

      const disableBody = { enabled: false, expectedRevision: 1 };
      const first = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", disableBody),
        environment,
      );
      const retry = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", disableBody),
        environment,
      );

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(setGate).toHaveBeenLastCalledWith("test_game_requires_points", true, 2, 2);
      expect(cancelOpenRounds).toHaveBeenCalledTimes(2);
      expect(cancelOpenRounds).toHaveBeenLastCalledWith("test_game_requires_points", 2);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]).toEqual(["Module activation post-commit step failed.", {
        moduleId: "test_game_requires_points",
        step: "dependent_round_cancellation",
        error: "simulated_refund_failure",
      }]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it(`leaves the game gate open and skips refunds when D1 rejects a disable (${dependencyTestCard("the game remains enabled when its D1 state update fails", "a failed database mutation still closes the gate or refunds escrow", "a SQLite trigger simulates the rejected D1 batch and the fake Durable Object records calls")})`, async () => {
    addDependencyTestModules();
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    let gateClosed = false;
    const setGate = vi.fn((_moduleId: string, closed: boolean) => {
      gateClosed = closed;
      return Promise.resolve({ applied: true });
    });
    const cancelOpenRounds = vi.fn(() => Promise.resolve(1));
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({ setGameModuleGate: setGate, cancelOpenGameRounds: cancelOpenRounds })),
    } as unknown as Env["CHANNEL"];

    for (const moduleId of ["points", "test_game_requires_points"]) {
      const response = await panelRouter.fetch(
        await requestFor("user-1", `/api/channels/channel-demo/modules/${moduleId}`, "PATCH", { enabled: true }),
        environment,
      );
      expect(response.status).toBe(200);
    }
    setGate.mockClear();
    cancelOpenRounds.mockClear();
    database.sqlite.exec(`
      CREATE TRIGGER reject_game_disable
      BEFORE UPDATE OF enabled ON channel_modules
      WHEN OLD.module_id = 'test_game_requires_points' AND NEW.enabled = 0
      BEGIN SELECT RAISE(ABORT, 'simulated_d1_failure'); END;
    `);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-demo/modules/test_game_requires_points", "PATCH", { enabled: false }),
      environment,
    );

    expect(response.status).toBe(500);
    expect(gateClosed).toBe(false);
    expect(setGate).not.toHaveBeenCalled();
    expect(cancelOpenRounds).not.toHaveBeenCalled();
    await expect(database.prepare("SELECT enabled FROM channel_modules WHERE channel_id = 'channel-demo' AND module_id = 'test_game_requires_points'").first())
      .resolves.toEqual({ enabled: 1 });
  });

  it(`keeps concurrent dependency changes consistent and preserves modules without requirements (${dependencyTestCard("conditional D1 mutations leave game-on implies points-on", "both requests commit an invalid dependency state", "the SQLite test adapter serializes batches and a fake ChannelObject stands in for gate persistence")})`, async () => {
    addDependencyTestModules();
    await insertLoginIdentityAndSession(database, "user-1");
    environment.CHANNEL = {
      idFromName: vi.fn((channelId: string) => channelId),
      get: vi.fn(() => ({
        setGameModuleGate: vi.fn(() => Promise.resolve({ applied: true })),
        cancelOpenGameRounds: vi.fn(() => Promise.resolve(0)),
        notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()),
      })),
    } as unknown as Env["CHANNEL"];

    for (const firstCommit of ["points-disable", "game-enable"] as const) {
      const channelId = firstCommit === "points-disable" ? "channel-points-first" : "channel-game-first";
      await insertChannel(database, channelId);
      await insertMember(database, channelId, "user-1", "broadcaster");
      const pointsEnable = await panelRouter.fetch(
        await requestFor("user-1", `/api/channels/${channelId}/modules/points`, "PATCH", { enabled: true }),
        environment,
      );
      expect(pointsEnable.status).toBe(200);

      const originalBatch = database.batch.bind(database);
      let arrivals = 0;
      let releaseArrivals!: () => void;
      const bothArrived = new Promise<void>((resolve) => { releaseArrivals = resolve; });
      let releaseFirstCommit!: () => void;
      const firstCommitted = new Promise<void>((resolve) => { releaseFirstCommit = resolve; });
      database.batch = async (statements) => {
        const sql = (statements[0] as unknown as { sql: string } | undefined)?.sql ?? "";
        const action = /^\s*INSERT INTO channel_modules/iu.test(sql) ? "game-enable"
          : /^\s*UPDATE channel_modules/iu.test(sql) ? "points-disable" : null;
        if (action === null) return originalBatch(statements);
        arrivals += 1;
        if (arrivals === 2) releaseArrivals();
        await bothArrived;
        if (action === firstCommit) {
          const result = await originalBatch(statements);
          releaseFirstCommit();
          return result;
        }
        await firstCommitted;
        return originalBatch(statements);
      };

      const gameEnableRequest = await requestFor(
        "user-1", `/api/channels/${channelId}/modules/test_game_requires_points`, "PATCH", { enabled: true },
      );
      const pointsDisableRequest = await requestFor(
        "user-1", `/api/channels/${channelId}/modules/points`, "PATCH", { enabled: false, expectedRevision: 1 },
      );
      const [gameEnable, pointsDisable] = await Promise.all([
        panelRouter.fetch(gameEnableRequest, environment),
        panelRouter.fetch(pointsDisableRequest, environment),
      ]);
      database.batch = originalBatch;

      const states = await database.prepare(
        `SELECT module_id, enabled FROM channel_modules
          WHERE channel_id = ? AND module_id IN ('points', 'test_game_requires_points') ORDER BY module_id`,
      ).bind(channelId).all<{ module_id: string; enabled: number }>();
      const rows = Object.fromEntries(states.results.map(({ module_id, enabled: isEnabled }) => [module_id, isEnabled === 1]));
      const enabled = {
        points: rows.points ?? false,
        test_game_requires_points: rows.test_game_requires_points ?? false,
      };

      expect([gameEnable.status, pointsDisable.status].sort((left, right) => left - right)).toEqual([200, 409]);
      if (firstCommit === "points-disable") {
        expect(gameEnable.status).toBe(409);
        expect(pointsDisable.status).toBe(200);
        expect(enabled).toEqual({ points: false, test_game_requires_points: false });
      } else {
        expect(gameEnable.status).toBe(200);
        expect(pointsDisable.status).toBe(409);
        expect(enabled).toEqual({ points: true, test_game_requires_points: true });
      }
    }

    const unrequired = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/channel-points-first/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    expect(unrequired.status).toBe(200);
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
        get: vi.fn(() => ({ publish, notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()) })),
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

  it("publishes a quiz cancellation when disabling quiz", async () => {
    registeredModules.push(quizOverlayTestModule);
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'quiz', 1, '{}')",
    ).run();
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-quiz', 'kanal-a', 'Quiz', '2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind)
       VALUES ('element-quiz', 'kanal-a', 'overlay-quiz', 'quiz.session')`,
    ).run();
    const publish = vi.fn((messages: readonly unknown[]) => {
      void messages;
      return Promise.resolve();
    });
    const activeGameRound = vi.fn(() => Promise.resolve({
      roundId: "quiz-round",
      state: "announcing" as const,
      data: { phaseSequence: 5, sessionStartedAt: "2026-09-25T12:01:00.000Z" },
      deadlineAt: null,
      createdAt: "2026-09-25T12:01:00.000Z",
    }));
    environment = {
      ...environment,
      CHANNEL: {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({
          activeGameRound,
          publish,
          notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()),
        })),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/quiz", "PATCH", { enabled: false }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(activeGameRound).toHaveBeenCalledWith("quiz");
    expect(publish.mock.calls[0]?.[0]).toContainEqual(expect.objectContaining({
      type: "modul.quiz.cancel",
      payload: {
        sessionId: "quiz-round",
        phase: "idle",
        phaseSequence: 6,
        sessionStartedAt: "2026-09-25T12:01:00.000Z",
      },
      overlayIds: ["overlay-quiz"],
    }));
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

  it("replans schedule inputs when a module transitions between enabled and disabled", async () => {
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
    expect(notifyScheduleInputsChanged).toHaveBeenCalledExactlyOnceWith("activation");
  });

  it(`keeps a committed module activation successful when schedule notification fails (${dependencyTestCard("the committed module response survives a post-commit schedule notification failure and logs its module and step", "a schedule RPC rejection changes a completed module mutation into an API error or disappears without an error log", "a route-level schedule RPC rejection is injected after the real SQLite mutation")})`, async () => {
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    const notifyScheduleInputsChanged = vi.fn(() => Promise.reject(new Error("schedule_replan_failure")));
    environment = {
      ...environment,
      CHANNEL: {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({ publish: vi.fn(() => Promise.resolve()), notifyScheduleInputsChanged })),
      },
    } as unknown as Env;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/channel-demo/modules/test-modul", "PATCH", { enabled: true }),
        environment,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ module: { id: "test-modul", enabled: true }, revision: 1 });
      await expect(database.prepare(
        "SELECT enabled FROM channel_modules WHERE channel_id = 'channel-demo' AND module_id = 'test-modul'",
      ).first()).resolves.toEqual({ enabled: 1 });
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]).toEqual(["Module activation post-commit step failed.", {
        moduleId: "test-modul",
        step: "schedule_notification",
        error: "schedule_replan_failure",
      }]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it(`logs a terminal overlay publish failure once and keeps activation successful (${dependencyTestCard("the committed activation returns 200 and logs module test-modul with overlay_publish after both publish attempts fail", "the activation omits its error log, logs the wrong step, retries an unexpected number of times, or returns an API error", "the real module route and SQLite mutation use a fake Durable Object publish method that rejects twice")})`, async () => {
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-module', 'channel-demo', 'Module overlay', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind)
       VALUES ('element-module', 'channel-demo', 'overlay-module', 'test-modul.countdown')`,
    ).run();
    const publish = vi.fn(() => Promise.reject(new Error("overlay_publish_failure")));
    environment = {
      ...environment,
      CHANNEL: {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({ publish, notifyScheduleInputsChanged: vi.fn(() => Promise.resolve()) })),
      },
    } as unknown as Env;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/channel-demo/modules/test-modul", "PATCH", { enabled: true }),
        environment,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ module: { id: "test-modul", enabled: true }, revision: 1 });
      await expect(database.prepare(
        "SELECT enabled FROM channel_modules WHERE channel_id = 'channel-demo' AND module_id = 'test-modul'",
      ).first()).resolves.toEqual({ enabled: 1 });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledExactlyOnceWith("Module activation post-commit step failed.", {
        moduleId: "test-modul",
        step: "overlay_publish",
        error: "overlay_publish_failure",
      });
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it(`marks failed post-commit scope metadata as unknown (${dependencyTestCard("the route returns the committed module state with unknown scope metadata and logs the response_state failure", "the request fails after commit, returns empty scope fields without an unknown marker, or skips or mislabels the log", "the real route and SQLite mutation run while the post-commit broadcaster identity lookup throws")})`, async () => {
    registeredModules.push(scopedTestModule);
    await insertChannel(database, "channel-demo");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-demo", "user-1", "broadcaster");
    const failingDatabase = {
      prepare: (sql: string) => {
        if (sql.includes("SELECT scopes_json, status") && sql.includes("twitch_login_identity")) {
          throw new Error("scope_lookup_failure");
        }
        return database.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => database.batch(statements as unknown as TestPreparedStatement[]),
    } as unknown as D1Database;
    environment = { ...environment, DB: failingDatabase };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/channel-demo/modules/scoped-test-module", "PATCH", { enabled: true }),
        environment,
      );
      const body = await response.json<{
        module: {
          id: string;
          enabled: boolean;
          broadcasterScopeMetadataUnknown?: boolean;
          requiredBroadcasterScopes?: string[];
          missingBroadcasterScopes?: string[];
        };
        revision: number;
      }>();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        module: { id: "scoped-test-module", enabled: true, broadcasterScopeMetadataUnknown: true },
        revision: 1,
      });
      expect(body.module).not.toHaveProperty("requiredBroadcasterScopes");
      expect(body.module).not.toHaveProperty("missingBroadcasterScopes");
      await expect(database.prepare(
        "SELECT enabled FROM channel_modules WHERE channel_id = 'channel-demo' AND module_id = 'scoped-test-module'",
      ).first()).resolves.toEqual({ enabled: 1 });
      expect(consoleError).toHaveBeenCalledExactlyOnceWith("Module activation post-commit step failed.", {
        moduleId: "scoped-test-module",
        step: "response_state",
        error: "scope_lookup_failure",
      });
    } finally {
      registeredModules.pop();
      consoleError.mockRestore();
    }
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

  it("returns the module row revision and rejects an undo after a later toggle", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const firstToggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    expect(firstToggle.status).toBe(200);
    await expect(firstToggle.json()).resolves.toMatchObject({ module: { enabled: true }, revision: 1 });

    const laterToggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false, expectedRevision: 1 }),
      environment,
    );
    expect(laterToggle.status).toBe(200);
    await expect(laterToggle.json()).resolves.toMatchObject({ module: { enabled: false }, revision: 2 });

    const staleUndo = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true, expectedRevision: 1 }),
      environment,
    );
    expect(staleUndo.status).toBe(409);
    await expect(staleUndo.json()).resolves.toEqual({ error: "module_changed_concurrently" });
    await expect(database.prepare(
      "SELECT enabled, revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ enabled: 0, revision: 2 });
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
      expect((await enable(false)).status).toBe(409);
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
      expect((await enable(false)).status).toBe(409);
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
      await requestFor("user-1", path, "PATCH", {
        revision: loaded.revision,
        settings: { betrag: 40 },
      }),
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

  it("saves a settings draft after a module toggle advances only the row revision", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'test-modul', 1, '{"betrag":42}')`,
    ).run();
    const settingsPath = "/api/channels/kanal-a/modules/test-modul/settings";
    const loadedResponse = await panelRouter.fetch(await requestFor("user-1", settingsPath), environment);
    const loaded = await loadedResponse.json<{ settings: { betrag: number }; revision: number }>();

    const toggled = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false }),
      environment,
    );
    expect(toggled.status).toBe(200);

    const saved = await panelRouter.fetch(
      await requestFor("user-1", settingsPath, "PATCH", {
        revision: loaded.revision,
        settings: { betrag: 41 },
      }),
      environment,
    );

    expect(saved.status).toBe(200);
    await expect(database.prepare(
      "SELECT revision, settings_revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ revision: 3, settings_revision: 2 });
    await expect(saved.json()).resolves.toMatchObject({ settings: { betrag: 41 }, revision: 2 });
    await expect(database.prepare(
      "SELECT enabled, settings, revision, settings_revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ enabled: 0, settings: '{"betrag":41}', revision: 3, settings_revision: 2 });
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
          `UPDATE channel_modules SET settings = '{"betrag":99}', revision = revision + 1,
                  settings_revision = settings_revision + 1
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
      "SELECT settings, revision, settings_revision FROM channel_modules WHERE channel_id = 'kanal-a' AND module_id = 'test-modul'",
    ).first()).resolves.toEqual({ settings: '{"betrag":99}', revision: 3, settings_revision: 3 });
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
