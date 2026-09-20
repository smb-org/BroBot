import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
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

const insertBotIdentity = async (database: TestD1Database): Promise<void> => {
  const ciphertext = await encryptJson(
    { token: "bot-access-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    "bot-user",
    "brobot",
    ciphertext,
    "refresh-ciphertext",
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertBotChannelStatus = async (
  database: TestD1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
     VALUES (?, ?, ?, ?)`,
  ).bind(channelId, isModerator ? 1 : 0, checkedAt, reason).run();
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
  method = "GET",
  withCsrf = true,
): Promise<Request> => {
  const headers = new Headers();
  if (userId !== null) {
    const sessionCookie = await insertSessionCookie(userId);
    if (method === "GET" || !withCsrf) {
      headers.set("Cookie", `__Host-brobot_session=${sessionCookie}`);
    } else {
      const csrfToken = await createCsrfToken(
        `session-${userId}`,
        environmentKeys.SESSION_COOKIE_KEYS,
        "2026-09-18T04:00:00.000Z",
      );
      headers.set("Cookie", `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`);
      headers.set("X-CSRF-Token", csrfToken);
    }
  }
  return new Request(`https://brobot.example${path}`, { method, headers });
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("liefert den gespeicherten Scope-Zustand und alle EventSub-Abos im System-Contract", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    await database.prepare(
      `UPDATE bot_identity SET missing_scopes_json = ? WHERE id = 1`,
    ).bind(JSON.stringify(["user:bot", "user:read:chat"])).run();
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "kanal-a", "channel.raid", "eingehend", "1", "raid-in", "secret", "enabled", null, null, null, "2026-09-18T04:00:00.000Z",
      "kanal-a", "channel.raid", "ausgehend", "1", "raid-out", null, "error", "missing_scope", "Scope fehlt", 403, "2026-09-18T03:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/system"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      botPermissions: { missingScopes: ["user:bot", "user:read:chat"] },
      subscriptions: [
        { subscriptionType: "channel.raid", variant: "ausgehend", status: "error", message: "Scope fehlt", statusCode: 403 },
        { subscriptionType: "channel.raid", variant: "eingehend", status: "enabled" },
      ],
    });
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

  it("prüft channel:bot bei der Broadcaster-Identität jedes Kanals", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertLoginIdentityAndSession(database, "user-1", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-b", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-b", "user-1", "verwalter");
    await insertMember(database, "kanal-b", "kanal-b", "broadcaster");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ channels: Array<{ channelId: string; channelBotConsent: string }> }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", channelBotConsent: "missing" }),
      expect.objectContaining({ channelId: "kanal-b", channelBotConsent: "granted" }),
    ]);
  });

  it("aktualisiert die Zustimmung nach einer erneuten Broadcaster-Anmeldung", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");

    const before = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    expect((await before.json<{ channelBotConsent: string }>()).channelBotConsent).toBe("missing");

    await database.prepare(
      "UPDATE twitch_login_identity SET scopes_json = ? WHERE user_id = ?",
    ).bind(JSON.stringify(["channel:bot"]), "kanal-a").run();

    const after = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    expect((await after.json<{ channelBotConsent: string }>()).channelBotConsent).toBe("granted");
  });

  it("zeigt ein fehlgeschlagenes Chat-Abo im Kanalzustand", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, 'channel.chat.message', ?, NULL, 'error', ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "subscription-1",
      "rate_limited",
      "Twitch ist überlastet.",
      429,
      "2026-09-18T04:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{
      chatSubscription: { status: string; subscriptionId: string | null; reason: string | null } | null;
      lastError: { source: string; reason: string; message: string | null; status: number | null; subscriptionType: string; subscriptionVariant: string } | null;
    }>();

    expect(response.status).toBe(200);
    expect(body.chatSubscription).toEqual({
      status: "error",
      subscriptionId: "subscription-1",
      reason: "rate_limited",
      updatedAt: "2026-09-18T04:00:00.000Z",
    });
    expect(body.lastError).toEqual({
      source: "eventsub",
      reason: "rate_limited",
      message: "Twitch ist überlastet.",
      status: 429,
      subscriptionType: "channel.chat.message",
      subscriptionVariant: "",
      at: "2026-09-18T04:00:00.000Z",
    });
  });

  it("zeigt auch die Ablehnung des Moderations-Abos als letzten Fehler", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, 'channel.moderate', '', '2', NULL, NULL, 'error', ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "missing_scope",
      "Der Bot darf dieses Abo nicht anlegen.",
      403,
      "2026-09-18T05:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{ lastError: { source: string; reason: string; message: string | null; status: number | null; subscriptionType: string; subscriptionVariant: string; at: string } | null }>();

    expect(response.status).toBe(200);
    expect(body.lastError).toEqual({
      source: "eventsub",
      reason: "missing_scope",
      message: "Der Bot darf dieses Abo nicht anlegen.",
      status: 403,
      subscriptionType: "channel.moderate",
      subscriptionVariant: "",
      at: "2026-09-18T05:00:00.000Z",
    });
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
    expect(first.entries).toEqual([{ auditId: "audit-1", actorUserId: "user-1", createdAt: "2026-09-18T03:00:00.000Z", moduleId: null, action: "neu", before: "null", after: "{}" }]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      environment,
    );
    const second = await secondResponse.json<{ entries: Array<{ auditId: string; action: string }>; nextCursor: string | null }>();

    expect(secondResponse.status).toBe(200);
    expect(second.entries).toEqual([{ auditId: "audit-2", actorUserId: "user-1", createdAt: "2026-09-18T02:00:00.000Z", moduleId: null, action: "alt", before: "{}", after: "{}" }]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("manuelle Moderatorstatus-Prüfung", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertBotIdentity(database);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T04:00:00.000Z"));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("weist einen Bediener im Worker ab", async () => {
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("weist ein gültiges Mitglied eines fremden Kanals ab", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("weist eine Mutation ohne CSRF-Token vor der Twitch-Abfrage ab", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST", false),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aktualisiert bei Erfolg nur den aufgerufenen Kanal und startet keine Wartung", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertBotChannelStatus(database, "kanal-a", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    await insertBotChannelStatus(database, "kanal-b", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "kanal-a" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ moderator: { isModerator: boolean; checkedAt: string; reason: string | null } }>();
    const kanalA = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-a").first<{ is_moderator: number; checked_at: string; reason: string | null }>();
    const kanalB = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-b").first<{ is_moderator: number; checked_at: string; reason: string | null }>();

    expect(response.status).toBe(200);
    expect(body.moderator).toEqual({ isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null });
    expect(kanalA).toEqual({ is_moderator: 1, checked_at: "2026-09-18T04:00:00.000Z", reason: null });
    expect(kanalB).toEqual({ is_moderator: 0, checked_at: "2026-09-18T03:00:00.000Z", reason: "moderator_entfernt" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.twitch.tv/helix/moderation/channels?user_id=bot-user&first=100&broadcaster_id=kanal-a",
    );
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("oauth2/token"))).toBe(false);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("channel-b"))).toBe(false);
  });

  it("weist eine Prüfung innerhalb des Cooldowns ab und nennt den frühesten Zeitpunkt", async () => {
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "kanal-a" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);

    await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ error: string; nextAllowedAt: string }>();

    expect(response.status).toBe(429);
    expect(body.error).toContain("kürzlich");
    expect(body.nextAllowedAt).toBe("2026-09-18T04:05:00.000Z");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blockiert einen parallelen Auslöser desselben Kanals atomar", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    let releaseTwitch!: (response: Response) => void;
    const twitchResponse = new Promise<Response>((resolve) => { releaseTwitch = (response) => { resolve(response); }; });
    const fetcher = vi.fn().mockReturnValue(twitchResponse);
    vi.stubGlobal("fetch", fetcher);

    const firstRequest = panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    releaseTwitch(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const firstResponse = await firstRequest;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("berücksichtigt auch eine frische Prüfung aus dem Wartungslauf", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertBotChannelStatus(database, "kanal-a", true, "2026-09-18T03:57:00.000Z", null);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ nextAllowedAt: string }>();

    expect(response.status).toBe(429);
    expect(body.nextAllowedAt).toBe("2026-09-18T04:02:00.000Z");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lässt den bisherigen Wert bei einem Twitch-Fehler unverändert und gibt die Ursache zurück", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await insertBotChannelStatus(database, "kanal-a", true, "2026-09-18T03:00:00.000Z", null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "Twitch ist vorübergehend nicht erreichbar." }),
      { status: 503 },
    )));

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ error: string }>();
    const status = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-a").first<{ is_moderator: number; checked_at: string; reason: string | null }>();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Twitch ist vorübergehend nicht erreichbar.");
    expect(status).toEqual({ is_moderator: 1, checked_at: "2026-09-18T03:00:00.000Z", reason: null });
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });

  it("beendet eine hängende Twitch-Prüfung nach dem Zeitlimit und räumt nur ihre Sperre auf", async () => {
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const fetcher = vi.fn().mockReturnValue(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);

    const responsePromise = panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(504);
    expect(body.error).toContain("Zeitlimit");
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });
});
