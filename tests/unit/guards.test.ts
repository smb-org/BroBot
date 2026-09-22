import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import {
  requirePlatform,
  requireChannelAuthorization,
  type PlatformAuthorizationVariables,
  type ChannelAuthorizationVariables,
} from "../../src/worker/auth/guards";
import { createSessionCookie } from "../../src/worker/auth/session";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
  BETREIBER_USER_IDS: "[]",
};

type GuardEnvironment = Env & { DB: D1Database };
interface GuardVariables extends ChannelAuthorizationVariables, PlatformAuthorizationVariables {}
type GuardContext = { Bindings: GuardEnvironment; Variables: GuardVariables };

const app = new Hono<GuardContext>();
app.use("/api/channels/:channelId/write", requireChannelAuthorization());
app.post("/api/channels/:channelId/write", (context) =>
  context.json({ role: context.get("channelRole") }),
);
app.all("/api/channels/:channelId/write", (context) =>
  context.json({ role: context.get("channelRole") }),
);
app.use("/api/platform/*", requirePlatform());
app.get("/api/platform/probe", (context) => {
  const variables = context.var as unknown as Partial<GuardVariables>;
  return context.json({
    userId: variables.actor?.userId,
    channelRole: variables.channelRole ?? null,
    authorizeMutation: variables.authorizeMutation ?? null,
    prepareModuleAudit: variables.prepareModuleAudit ?? null,
  });
});

const insertChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, channelId, channelId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertSession = async (database: TestD1Database, userId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, '[]', 'access', 'refresh', ?, 'connected', NULL, ?, ?)`,
  ).bind(userId, userId, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO auth_sessions
      (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    `session-${userId}`,
    userId,
    userId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertMember = async (
  database: TestD1Database,
  channelId: string,
  userId: string,
  role: "broadcaster" | "manager" | "operator",
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, userId, role, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const makeRequest = async (
  environment: GuardEnvironment,
  body: Record<string, unknown> = { role: "broadcaster" },
  withCsrf = true,
  channelId = "kanal-a",
  method = "POST",
  userId = "user-1",
  path = `/api/channels/${channelId}/write`,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environment.SESSION_COOKIE_KEYS,
    environment.SESSION_ENCRYPTION_KEYS ?? "",
  );
  const csrfToken = await createCsrfToken(
    `session-${userId}`,
    environment.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}${withCsrf ? `; __Host-brobot_csrf=${csrfToken}` : ""}`,
    "Content-Type": "application/json",
  });
  if (withCsrf) headers.set("X-CSRF-Token", csrfToken);
  const init: RequestInit = {
    method,
    headers,
  };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

describe("channel-scoped route guard", () => {
  let database: TestD1Database;
  let environment: GuardEnvironment;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = {
      DB: database as unknown as D1Database,
      ...environmentKeys,
    } as GuardEnvironment;
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertSession(database, "user-1");
  });

  afterEach(() => {
    database.close();
  });

  it("returns the database role and ignores a role from the request body", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await app.fetch(await makeRequest(environment), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ role: "operator" });
  });

  it("rejects missing CSRF protection before the handler", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await app.fetch(await makeRequest(environment, undefined, false), environment);

    expect(response.status).toBe(403);
  });

  it("rejects an incorrect CSRF header despite a valid session", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");
    const request = await makeRequest(environment);
    const headers = new Headers(request.headers);
    headers.set("X-CSRF-Token", "manipuliert");

    const response = await app.fetch(new Request(request, { headers }), environment);

    expect(response.status).toBe(403);
  });

  it("lets an operator with a session through and sets only session and actor", async () => {
    await insertSession(database, "26876135");
    environment.BETREIBER_USER_IDS = '["26876135"]';

    const response = await app.fetch(
      await makeRequest(environment, {}, true, "kanal-a", "GET", "26876135", "/api/platform/probe"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "26876135",
      channelRole: null,
      authorizeMutation: null,
      prepareModuleAudit: null,
    });
  });

  it("rejects a non-operator with 403 and a clear message", async () => {
    environment.BETREIBER_USER_IDS = '["26876135"]';

    const response = await app.fetch(
      await makeRequest(environment, {}, true, "kanal-a", "GET", "user-1", "/api/platform/probe"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Kein Betreiberzugang.");
  });

  it("doesn't let an operator without a member row through on the channel route", async () => {
    await insertSession(database, "26876135");
    environment.BETREIBER_USER_IDS = '["26876135"]';

    const response = await app.fetch(
      await makeRequest(environment, {}, true, "kanal-a", "GET", "26876135"),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("also protects an unusual HTTP method with CSRF", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await app.fetch(
      await makeRequest(environment, undefined, false, "kanal-a", "PURGE"),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("rejects a non-member, a different channel, and an unknown channel", async () => {
    await insertMember(database, "kanal-b", "user-1", "operator");

    await expect(app.fetch(await makeRequest(environment), environment)).resolves.toHaveProperty("status", 403);

    await expect(app.fetch(await makeRequest(environment, { role: "broadcaster" }, true, "kanal-b"), environment))
      .resolves.toHaveProperty("status", 200);

    await expect(app.fetch(await makeRequest(environment, { role: "broadcaster" }, true, "nicht-freigegeben"), environment))
      .resolves.toHaveProperty("status", 403);
  });
});
