import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { listAllBroadcasterScopes } from "../../src/worker/module-scopes";
import { panelRouter } from "../../src/worker/panel/routes";
import * as eventsubMaintenance from "../../src/worker/eventsub-subscriptions";
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
  TWITCH_BOT_LOGIN: "brobot",
  PLATFORM_USER_IDS: JSON.stringify(["4711"]),
} as unknown as Env);

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

describe("Panel read endpoints", () => {
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

  it("rejects a channel-bound read request without a session", async () => {
    await insertChannel(database, "kanal-a");

    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("rejects the non-channel-bound channel list without a session", async () => {
    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("rejects an existing but unrelated channel route", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
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

  it("returns an authorized channel without a broadcaster connection in the list, overview, and system", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");

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

  it("exposes the stored stream state additively in channel overview", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
       VALUES ('kanal-a', 'offline', '2026-09-23T08:00:00.000Z', 'eventsub')`,
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channelId: "kanal-a",
      streamState: "offline",
      activeModules: [],
    });
  });

  it("returns the stored scope state and all EventSub subscriptions in the system contract", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
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
      "kanal-a", "channel.raid", "incoming", "1", "raid-in", "secret", "enabled", null, null, null, "2026-09-18T04:00:00.000Z",
      "kanal-a", "channel.raid", "outgoing", "1", "raid-out", null, "error", "missing_scope", "Scope fehlt", 403, "2026-09-18T03:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/system"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      botPermissions: { missingScopes: ["user:bot", "user:read:chat"] },
      subscriptions: [
        { subscriptionType: "channel.raid", variant: "incoming", status: "enabled" },
        { subscriptionType: "channel.raid", variant: "outgoing", status: "error", message: "Scope fehlt", statusCode: 403 },
      ],
    });
  });

  it("returns missing broadcaster scopes from the worker only for flagged channels", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await database.prepare("UPDATE channels SET full_consent = 1 WHERE channel_id = ?").bind("kanal-a").run();
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await insertMember(database, "kanal-a", "user-1", "manager");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ broadcasterPermissions: { missingScopes: string[] } }>();
    expect(body.broadcasterPermissions.missingScopes).toEqual(
      expect.arrayContaining(listAllBroadcasterScopes().filter((scope) => scope !== "channel:read:ads")),
    );
  });

  it("returns only the channels with a membership row for the user", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertChannel(database, "kanal-c", "Gamma");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertMember(database, "kanal-b", "user-2", "broadcaster");
    await insertMember(database, "kanal-c", "user-1", "operator");
    await insertBroadcasterConnection(database, "kanal-a");
    await insertBroadcasterConnection(database, "kanal-b");
    await insertBroadcasterConnection(database, "kanal-c");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{
      channels: Array<{ channelId: string; role: string }>;
      viewerIsBot: boolean;
      botLogin?: string;
    }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", role: "manager" }),
      expect.objectContaining({ channelId: "kanal-c", role: "operator" }),
    ]);
    expect(body.viewerIsBot).toBe(false);
    expect(body).not.toHaveProperty("botLogin");
  });

  it("returns the bot login to platform admins and identifies bot-account viewers", async () => {
    await insertLoginIdentityAndSession(database, "4711");
    const adminResponse = await panelRouter.fetch(await makeRequest("4711", "/api/channels"), environment);
    const adminBody = await adminResponse.json<{ platformAdmin: boolean; viewerIsBot: boolean; botLogin?: string }>();

    expect(adminBody.platformAdmin).toBe(true);
    expect(adminBody.viewerIsBot).toBe(false);
    expect(adminBody.botLogin).toBe("brobot");

    await insertLoginIdentityAndSession(database, "bot-user");
    await database.prepare("UPDATE auth_sessions SET login = ? WHERE user_id = ?").bind("BROBOT", "bot-user").run();
    await insertBotIdentity(database);
    const botResponse = await panelRouter.fetch(await makeRequest("bot-user", "/api/channels"), environment);
    const botBody = await botResponse.json<{ platformAdmin: boolean; viewerIsBot: boolean; botLogin?: string }>();

    expect(botBody.platformAdmin).toBe(false);
    expect(botBody.viewerIsBot).toBe(true);
    expect(botBody.botLogin).toBe("brobot");
  });

  it("reports the installation's bot status even with zero released channels (#159)", async () => {
    await insertLoginIdentityAndSession(database, "user-1");
    await database.prepare(
      `INSERT INTO bot_identity_status (id, status, reason, updated_at)
       VALUES (1, 'revoked', 'authorization_revoked', ?)`,
    ).bind("2026-09-18T01:00:00.000Z").run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ channels: unknown[]; bot: { status: string; reason: string | null } | null }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([]);
    expect(body.bot).toEqual({ status: "revoked", reason: "authorization_revoked", updatedAt: "2026-09-18T01:00:00.000Z" });
  });

  it("reports a null bot status before the bot has ever signed in", async () => {
    await insertLoginIdentityAndSession(database, "user-1");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ bot: unknown }>();

    expect(response.status).toBe(200);
    expect(body.bot).toBeNull();
  });

  it("checks channel:bot on the broadcaster identity of each channel", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertLoginIdentityAndSession(database, "user-1", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-b", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-b", "user-1", "manager");
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

  it("updates the consent after a renewed broadcaster login", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "user-1", "manager");
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

  it("shows a failed chat subscription in the channel state", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
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

  it("also shows the moderation subscription's rejection as the last error", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
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

  it("returns the actual channel state, active modules, and stored reasons", async () => {
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
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "member.updated", "{}", "{}",
      "audit-2", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "member.added", "null", "{}",
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

  it("limits the audit log and paginates with the supplied cursor", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
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
    expect(first.entries).toEqual([{ auditId: "audit-1", actorUserId: "user-1", actorLogin: null, actorDisplayName: null, actorKind: "member", createdAt: "2026-09-18T03:00:00.000Z", moduleId: null, action: "neu", before: "null", after: "{}" }]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      environment,
    );
    const second = await secondResponse.json<{ entries: Array<{ auditId: string; action: string }>; nextCursor: string | null }>();

    expect(secondResponse.status).toBe(200);
    expect(second.entries).toEqual([{ auditId: "audit-2", actorUserId: "user-1", actorLogin: null, actorDisplayName: null, actorKind: "member", createdAt: "2026-09-18T02:00:00.000Z", moduleId: null, action: "alt", before: "{}", after: "{}" }]);
    expect(second.nextCursor).toBeNull();
  });

  it("resolves audit actors page by page in a single Twitch call and keeps unresolved ids", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotIdentity(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-actor", "auflösbar", "2026-09-18T04:00:00.000Z", "kanal-a", "neu", "{}", "{}",
      "audit-unknown", "gelöscht", "2026-09-18T03:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["auflösbar", "gelöscht"]);
      return Promise.resolve(Response.json({ data: [{ id: "auflösbar", login: "alice", display_name: "Alice" }] }));
    });
    vi.stubGlobal("fetch", twitch);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log"),
      environment,
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(twitch).toHaveBeenCalledTimes(1);
    expect(body.entries).toEqual([
      expect.objectContaining({ actorUserId: "auflösbar", actorLogin: "alice", actorDisplayName: "Alice" }),
      expect.objectContaining({ actorUserId: "gelöscht", actorLogin: null, actorDisplayName: null }),
    ]);
  });
});

describe("manual moderator status check", () => {
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

  it("rejects an operator in the worker", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a valid member of a foreign channel", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a mutation without a CSRF token before the Twitch call", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST", false),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("updates only the requested channel and triggers maintenance after moderator status is confirmed", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBotChannelStatus(database, "kanal-a", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    await insertBotChannelStatus(database, "kanal-b", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "kanal-a" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);
    const maintenance = vi.spyOn(eventsubMaintenance, "maintainEventSubSubscriptions");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ moderator: { isModerator: boolean; checkedAt: string; reason: string | null } }>();
    const channelA = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-a").first<{ is_moderator: number; checked_at: string; reason: string | null }>();
    const channelB = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-b").first<{ is_moderator: number; checked_at: string; reason: string | null }>();

    expect(response.status).toBe(200);
    expect(body.moderator).toEqual({ isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null });
    expect(channelA).toEqual({ is_moderator: 1, checked_at: "2026-09-18T04:00:00.000Z", reason: null });
    expect(channelB).toEqual({ is_moderator: 0, checked_at: "2026-09-18T03:00:00.000Z", reason: "moderator_entfernt" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.twitch.tv/helix/moderation/channels?user_id=bot-user&first=100&broadcaster_id=kanal-a",
    );
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("oauth2/token"))).toBe(true);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("channel-b"))).toBe(false);
    expect(maintenance).toHaveBeenCalledWith(environment, "2026-09-18T04:00:00.000Z", fetch, "kanal-a");
    maintenance.mockRestore();
  });

  it("rejects a check within the cooldown and states the earliest allowed time", async () => {
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
    expect(body.error).toBe("moderator_status_check_rate_limited");
    expect(body.nextAllowedAt).toBe("2026-09-18T04:05:00.000Z");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("atomically blocks a concurrent trigger for the same channel", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
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
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("also honors a fresh check from the maintenance run", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
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

  it("leaves the previous value unchanged on a Twitch error and returns the reason", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
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
    expect(body.error).toBe("moderator_status_check_failed");
    expect(status).toEqual({ is_moderator: 1, checked_at: "2026-09-18T03:00:00.000Z", reason: null });
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });

  it("ends a hanging Twitch check after the timeout and cleans up only its own lock", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
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
    expect(body.error).toBe("moderator_status_check_failed");
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });
});
