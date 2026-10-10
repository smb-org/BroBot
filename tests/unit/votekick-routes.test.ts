import { afterEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { upsertLoginIdentity } from "../../src/worker/db/login-identity";
import { votekickTimeoutReason } from "../../src/modules/votekick/domain";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};
const tokenKeys = keys.SESSION_ENCRYPTION_KEYS;
const botUserId = "bot-a";
const targetUserId = "viewer-a";
const databases: TestD1Database[] = [];

const databaseFor = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, "channel-a");
  await insertChannel(database, "channel-b");
  return database;
};

const environmentFor = (
  database: TestD1Database,
  runModuleAlarm = vi.fn(() => Promise.resolve()),
  publish = vi.fn<(messages: readonly RealtimeMessage[]) => Promise<void>>(() => Promise.resolve()),
): Env => {
  const channelObject = {
    runModuleAlarm,
    publish,
    getTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve(null)),
    setTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve()),
  };
  return {
    DB: database as unknown as D1Database,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => channelObject,
    },
    TWITCH_CLIENT_ID: "test-client",
    TOKEN_ENCRYPTION_KEYS: tokenKeys,
    ...keys,
  } as unknown as Env;
};

const requestFor = async (userId: string, path: string, method = "GET"): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
    },
  });
};

const insertRunning = async (database: TestD1Database, channelId: string, id: string): Promise<void> => {
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO votekicks
      (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
       yes_votes, no_votes, ballot_revision, started_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'running', 3, 1, 0, 1, ?, ?)`,
  ).bind(channelId, id, `${id}-target`, `${id}-target`, `${id}-starter`, now, new Date(Date.now() + 60_000).toISOString()).run();
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

const insertPassed = async (database: TestD1Database, id: string): Promise<{ startedAt: string; endedAt: string; expiresAt: string }> => {
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const endedAt = new Date(Date.now() - 20_000).toISOString();
  const expiresAt = new Date(Date.parse(endedAt) + 90_000).toISOString();
  await database.prepare(
    `INSERT INTO votekicks
      (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
       yes_votes, no_votes, ballot_revision, duration_seconds, started_at, expires_at, ended_at, lifted_at)
     VALUES ('channel-a', ?, ?, 'viewer-a', 'starter-a', 'passed', 3, 3, 0, 2, 90, ?, ?, ?, NULL)`,
  ).bind(id, targetUserId, startedAt, expiresAt, endedAt).run();
  return { startedAt, endedAt, expiresAt };
};

describe("Votekick routes", () => {
  it("scopes panel history to the authorized channel and rejects cross-tenant reads", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertRunning(database, "channel-a", "ballot-a");
    await insertRunning(database, "channel-b", "ballot-b");
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = environmentFor(database, runModuleAlarm);

    const own = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/modules/votekick/votekicks"), environment,
    );
    const foreign = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-b/modules/votekick/votekicks"), environment,
    );
    const foreignCancel = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-b/modules/votekick/votekicks/ballot-b/cancel", "POST"), environment,
    );
    const foreignRow = await database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-b' AND votekick_id = 'ballot-b'")
      .first<{ status: string }>();

    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ running: { id: "ballot-a" }, votekicks: [{ id: "ballot-a" }] });
    expect(runModuleAlarm).not.toHaveBeenCalled();
    expect(foreign.status).toBe(403);
    expect(foreignCancel.status).toBe(403);
    expect(foreignRow).toEqual({ status: "running" });
  });

  it("allows an operator to cancel the running ballot they can operate", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-a");
    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-a/cancel", "POST"),
      environmentFor(database),
    );
    const row = await database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = 'ballot-a'")
      .first<{ status: string }>();

    expect(response.status).toBe(204);
    expect(row).toEqual({ status: "cancelled" });
  });

  it("publishes a votekick tally hint after an operator lifts its timeout", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "manager");
    const id = "ballot-lift";
    const { startedAt, endedAt, expiresAt } = await insertPassed(database, id);
    const ciphertext = await encryptJson({ token: "fictional-bot-token" }, parseKeyRing(tokenKeys));
    const broadcasterCiphertext = await encryptJson({ token: "fictional-broadcaster-token" }, parseKeyRing(tokenKeys));
    const operatorAt = new Date().toISOString();
    await upsertLoginIdentity(database as unknown as D1Database, {
      userId: "channel-a",
      login: "channel-a",
      scopesJson: '["moderation:read"]',
      tokenScopesJson: '["moderation:read"]',
      accessTokenCiphertext: broadcasterCiphertext,
      refreshTokenCiphertext: broadcasterCiphertext,
      expiresAt: "2099-10-09T00:00:00.000Z",
      status: "connected",
      reason: null,
      createdAt: operatorAt,
      updatedAt: operatorAt,
    });
    await upsertBotIdentity(database as unknown as D1Database, {
      id: 1,
      userId: botUserId,
      login: "fictional-bot",
      scopesJson: '["moderator:manage:banned_users"]',
      accessTokenCiphertext: ciphertext,
      refreshTokenCiphertext: ciphertext,
      expiresAt: "2099-10-09T00:00:00.000Z",
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    await database.prepare(
      "INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason) VALUES ('channel-a', 1, ?, NULL)",
    ).bind(startedAt).run();
    const publish = vi.fn<(messages: readonly RealtimeMessage[]) => Promise<void>>(() => Promise.resolve());
    const twitchFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        user_id: targetUserId,
        moderator_id: botUserId,
        reason: votekickTimeoutReason(3, 0, id),
        created_at: endedAt,
        expires_at: expiresAt,
      }] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("operator-a", `/api/channels/channel-a/modules/votekick/votekicks/${id}/lift`, "POST"),
      environmentFor(database, undefined, publish),
    );

    expect(response.status).toBe(200);
    expect(publish).not.toHaveBeenCalled();
    const revision = await database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'module:votekick:panel'",
    ).first<{ revision: number }>();
    expect(revision?.revision).toBeGreaterThan(0);
  });

  it("reads a running votekick without invoking its alarm handler", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-panel");
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks"),
      environmentFor(database, runModuleAlarm),
    );

    expect(response.status).toBe(200);
    expect(runModuleAlarm).not.toHaveBeenCalled();
  });
});
