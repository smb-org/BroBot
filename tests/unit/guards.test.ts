import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import {
  requireChannelAuthorization,
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
};

type GuardEnvironment = Env & { DB: D1Database };
type GuardContext = { Bindings: GuardEnvironment; Variables: ChannelAuthorizationVariables };

const app = new Hono<GuardContext>();
app.use("/api/channels/:channelId/write", requireChannelAuthorization());
app.post("/api/channels/:channelId/write", (context) =>
  context.json({ role: context.get("channelRole") }),
);
app.all("/api/channels/:channelId/write", (context) =>
  context.json({ role: context.get("channelRole") }),
);

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
  role: "broadcaster" | "verwalter" | "bediener",
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
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: "session-user-1" },
    environment.SESSION_COOKIE_KEYS,
    environment.SESSION_ENCRYPTION_KEYS ?? "",
  );
  const csrfToken = await createCsrfToken(
    "session-user-1",
    environment.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}${withCsrf ? `; __Host-brobot_csrf=${csrfToken}` : ""}`,
    "Content-Type": "application/json",
  });
  if (withCsrf) headers.set("X-CSRF-Token", csrfToken);
  return new Request(`https://brobot.example/api/channels/${channelId}/write`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
};

describe("kanalgebundener Routen-Guard", () => {
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

  it("liefert die Datenbankrolle und ignoriert eine Rolle aus dem Request-Body", async () => {
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await app.fetch(await makeRequest(environment), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ role: "bediener" });
  });

  it("lehnt fehlenden CSRF-Schutz vor dem Handler ab", async () => {
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await app.fetch(await makeRequest(environment, undefined, false), environment);

    expect(response.status).toBe(403);
  });

  it("lehnt einen falschen CSRF-Header trotz gültiger Session ab", async () => {
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const request = await makeRequest(environment);
    const headers = new Headers(request.headers);
    headers.set("X-CSRF-Token", "manipuliert");

    const response = await app.fetch(new Request(request, { headers }), environment);

    expect(response.status).toBe(403);
  });

  it("schützt eine ungewöhnliche HTTP-Methode ebenfalls mit CSRF", async () => {
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await app.fetch(
      await makeRequest(environment, undefined, false, "kanal-a", "PURGE"),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("lehnt ein Nichtmitglied, einen fremden Kanal und einen unbekannten Kanal ab", async () => {
    await insertMember(database, "kanal-b", "user-1", "bediener");

    await expect(app.fetch(await makeRequest(environment), environment)).resolves.toHaveProperty("status", 403);

    await expect(app.fetch(await makeRequest(environment, { role: "broadcaster" }, true, "kanal-b"), environment))
      .resolves.toHaveProperty("status", 200);

    await expect(app.fetch(await makeRequest(environment, { role: "broadcaster" }, true, "nicht-freigegeben"), environment))
      .resolves.toHaveProperty("status", 403);
  });
});
