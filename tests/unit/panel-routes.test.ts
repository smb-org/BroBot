import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
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

const insertChannel = async (
  database: TestD1Database,
  channelId: string,
  displayName = channelId,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    channelId,
    channelId,
    displayName,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertLoginIdentityAndSession = async (
  database: TestD1Database,
  userId: string,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, '[]', 'access', 'refresh', ?, 'connected', NULL, ?, ?)`,
  ).bind(
    userId,
    userId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
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
  ).bind(
    channelId,
    userId,
    role,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertBroadcasterConnection = async (
  database: TestD1Database,
  channelId: string,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_connections
      (connection_id, channel_id, purpose, scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (?, ?, 'broadcaster', '[]', 'access', 'refresh', ?, ?, ?)`,
  ).bind(
    `connection-${channelId}`,
    channelId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertSessionCookie = async (userId: string): Promise<string> => createSessionCookie(
  { sessionId: `session-${userId}` },
  environmentKeys.SESSION_COOKIE_KEYS,
  environmentKeys.SESSION_ENCRYPTION_KEYS,
);

const makeEnvironment = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  ...environmentKeys,
} as Env);

const makeRequest = async (
  userId: string | null,
  path: string,
): Promise<Request> => {
  const headers = new Headers();
  if (userId !== null) headers.set("Cookie", `__Host-brobot_session=${await insertSessionCookie(userId)}`);
  return new Request(`https://brobot.example${path}`, { headers });
};

describe("Panel-Leseendpunkte", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
  });

  afterEach(() => {
    database.close();
  });

  it("weist eine kanalgebundene Les Anfrage ohne Session ab", async () => {
    await insertChannel(database, "kanal-a");

    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("weist die nicht kanalgebundene Kanalliste ohne Session ab", async () => {
    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("weist eine vorhandene, aber nicht zugehörige Kanalroute ab", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await insertBroadcasterConnection(database, "kanal-b");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-a-1", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "neu", "null", "{}",
      "audit-a-2", "user-1", "2026-09-18T01:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();

    const sourceResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?limit=1"),
      environment,
    );
    const source = await sourceResponse.json<{ nextCursor: string | null }>();
    expect(sourceResponse.status).toBe(200);
    expect(source.nextCursor).toEqual(expect.any(String));

    const foreignResponses = await Promise.all([
      panelRouter.fetch(
        await makeRequest("user-1", "/api/channels/kanal-b/overview"),
        environment,
      ),
      panelRouter.fetch(
        await makeRequest("user-1", "/api/channels/kanal-b/system"),
        environment,
      ),
      panelRouter.fetch(
        await makeRequest(
          "user-1",
          `/api/channels/kanal-b/audit-log?limit=1&cursor=${encodeURIComponent(source.nextCursor ?? "")}`,
        ),
        environment,
      ),
    ]);

    expect(foreignResponses.map((response) => response.status)).toEqual([403, 403, 403]);
  });

  it("liefert einen berechtigten Kanal ohne Broadcaster-Verbindung in Liste, Übersicht und System", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");

    const channelsResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const channels = await channelsResponse.json<{ channels: Array<{ channelId: string }> }>();
    const overviewResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const systemResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/system"),
      environment,
    );

    expect(channelsResponse.status).toBe(200);
    expect(channels.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", broadcasterConnection: "not_connected" }),
    ]);
    expect(overviewResponse.status).toBe(200);
    expect(systemResponse.status).toBe(200);
    const overview = await overviewResponse.json<{ broadcasterConnection: string }>();
    const system = await systemResponse.json<{ broadcasterConnection: string }>();
    expect(overview.broadcasterConnection).toBe("not_connected");
    expect(system.broadcasterConnection).toBe("not_connected");
  });

  it("liefert ausschließlich die Kanäle mit einer Mitgliedszeile des Benutzers", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertChannel(database, "kanal-c", "Gamma");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertMember(database, "kanal-b", "user-2", "broadcaster");
    await insertMember(database, "kanal-c", "user-1", "bediener");
    await insertBroadcasterConnection(database, "kanal-a");
    await insertBroadcasterConnection(database, "kanal-b");
    await insertBroadcasterConnection(database, "kanal-c");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ channels: Array<{ channelId: string; role: string }> }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", role: "verwalter" }),
      expect.objectContaining({ channelId: "kanal-c", role: "bediener" }),
    ]);
  });

  it("liefert den tatsächlichen Kanalzustand, aktive Module und gespeicherte Ursachen", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBroadcasterConnection(database, "kanal-a");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-1', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind(
      "2026-09-19T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity_status (id, status, reason, updated_at)
       VALUES (1, 'connected', NULL, ?)`,
    ).bind("2026-09-18T01:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
       VALUES (?, 0, ?, ?)`,
    ).bind("kanal-a", "2026-09-18T02:00:00.000Z", "moderator_entfernt").run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES (?, ?, 1, ?), (?, ?, 0, ?)`,
    ).bind("kanal-a", "polls", '{"frage":"heute"}', "kanal-a", "clips", "{}" ).run();
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "mitglied.geändert", "{}", "{}",
      "audit-2", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "mitglied.hinzugefügt", "null", "{}",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{
      moderator: { isModerator: boolean; reason: string | null } | null;
      activeModules: Array<{ moduleId: string; settings: string }>;
      tokens: { botExpiresAt: string | null; loginStatus: string | null };
      lastError: { reason: string } | null;
    }>();

    expect(response.status).toBe(200);
    expect(body.moderator).toEqual({
      isModerator: false,
      checkedAt: "2026-09-18T02:00:00.000Z",
      reason: "moderator_entfernt",
    });
    expect(body.activeModules).toEqual([{ moduleId: "polls", settings: '{"frage":"heute"}' }]);
    expect(body.tokens).toEqual({
      botExpiresAt: "2026-09-19T00:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-09-19T00:00:00.000Z",
    });
    expect(body.lastError).toEqual({
      source: "moderator",
      reason: "moderator_entfernt",
      at: "2026-09-18T02:00:00.000Z",
    });
  });

  it("begrenzt das Audit-Log und blättert mit dem gelieferten Cursor", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "neu", "null", "{}",
      "audit-2", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();

    const firstResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?limit=1"),
      environment,
    );
    const first = await firstResponse.json<{
      entries: Array<{ auditId: string; action: string }>;
      nextCursor: string | null;
    }>();

    expect(firstResponse.status).toBe(200);
    expect(first.entries).toEqual([{ auditId: "audit-1", actorUserId: "user-1", createdAt: "2026-09-18T03:00:00.000Z", action: "neu", before: "null", after: "{}" }]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      environment,
    );
    const second = await secondResponse.json<{ entries: Array<{ auditId: string; action: string }>; nextCursor: string | null }>();

    expect(secondResponse.status).toBe(200);
    expect(second.entries).toEqual([{ auditId: "audit-2", actorUserId: "user-1", createdAt: "2026-09-18T02:00:00.000Z", action: "alt", before: "{}", after: "{}" }]);
    expect(second.nextCursor).toBeNull();
  });
});
