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
import { createReadInterleavingDatabase, createWriteInterleavingDatabase, TestD1Database } from "./test-d1";

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
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, '{}'), (?, 'votekick', 1, '{}')",
  ).bind("channel-a", "channel-b").run();
  return database;
};

const environmentFor = (
  database: TestD1Database | D1Database,
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

const seedLiftModerationAccess = async (database: TestD1Database, createdAt: string): Promise<void> => {
  const ciphertext = await encryptJson({ token: "fictional-bot-token" }, parseKeyRing(tokenKeys));
  const broadcasterCiphertext = await encryptJson({ token: "fictional-broadcaster-token" }, parseKeyRing(tokenKeys));
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
    createdAt,
    updatedAt: createdAt,
  });
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: botUserId,
    login: "fictional-bot",
    scopesJson: '["moderator:manage:banned_users"]',
    accessTokenCiphertext: ciphertext,
    refreshTokenCiphertext: ciphertext,
    expiresAt: "2099-10-09T00:00:00.000Z",
    createdAt,
    updatedAt: createdAt,
  });
  await database.prepare(
    "INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason) VALUES ('channel-a', 1, ?, NULL)",
  ).bind(createdAt).run();
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

  it("rejects timeout lifts from a user without an operator role before calling Twitch", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "viewer-a");
    await insertPassed(database, "ballot-unauthorized-lift");
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("viewer-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-unauthorized-lift/lift", "POST"),
      environmentFor(database),
    );

    expect(response.status).toBe(403);
    expect(twitchFetch).not.toHaveBeenCalled();
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = 'channel-a' AND action = 'votekick.timeout_lift_attempted'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("requires the Votekick module to remain enabled when cancelling", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-a");
    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'channel-a' AND module_id = 'votekick'").run();

    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-a/cancel", "POST"),
      environmentFor(database),
    );

    expect(response.status).toBe(409);
    await expect(database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = 'ballot-a'")
      .first()).resolves.toEqual({ status: "running" });
  });

  it("reports a replacement votekick when cancellation loses its guarded update race", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-a");
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("FROM votekicks") && sql.includes("status = 'running'"),
      async () => {
        await database.prepare("UPDATE votekicks SET status = 'cancelled', ended_at = ? WHERE channel_id = ? AND votekick_id = ?")
          .bind(new Date().toISOString(), "channel-a", "ballot-a").run();
        await insertRunning(database, "channel-a", "ballot-b");
      },
    );

    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-a/cancel", "POST"),
      environmentFor(interleavedDatabase),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "votekick_changed" });
    await expect(database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = 'ballot-b'")
      .first<{ status: string }>()).resolves.toEqual({ status: "running" });
  });

  it("only lifts a timeout once when concurrent cockpit requests race", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    const id = "ballot-lift";
    const { endedAt, expiresAt } = await insertPassed(database, id);
    const operatorAt = new Date().toISOString();
    await seedLiftModerationAccess(database, operatorAt);
    const publish = vi.fn<(messages: readonly RealtimeMessage[]) => Promise<void>>(() => Promise.resolve());
    let deleteCount = 0;
    const twitchFetch = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/bans") && init?.method === "DELETE") {
        deleteCount += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{
        user_id: targetUserId,
        moderator_id: botUserId,
        reason: votekickTimeoutReason(3, 0, id),
        created_at: endedAt,
        expires_at: expiresAt,
      }] }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const responses = await Promise.all([1, 2].map(async () => panelRouter.fetch(
      await requestFor("operator-a", `/api/channels/channel-a/modules/votekick/votekicks/${id}/lift`, "POST"),
      environmentFor(database, undefined, publish),
    )));

    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 409]);
    expect(twitchFetch).toHaveBeenCalledTimes(2);
    expect(deleteCount).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    const lifted = await database.prepare(
      "SELECT lifted_at FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = ?",
    ).bind(id).first<{ lifted_at: string | null }>();
    expect(lifted?.lifted_at).not.toBeNull();
    const revision = await database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'channel-a' AND resource = 'module:votekick:panel'",
    ).first<{ revision: number }>();
    expect(revision?.revision).toBeGreaterThan(0);
    const liftAudit = await database.prepare(
      "SELECT action, module_id, before_json, after_json FROM audit_log WHERE channel_id = 'channel-a' AND action = 'votekick.timeout_lift_attempted'",
    ).all<{ action: string; module_id: string; before_json: string; after_json: string }>();
    expect(liftAudit.results).toHaveLength(1);
    expect(liftAudit.results[0]).toMatchObject({ action: "votekick.timeout_lift_attempted", module_id: "votekick" });
    expect(JSON.parse(liftAudit.results[0]?.after_json ?? "{}")).toMatchObject({ outcome: "applied", reason: null });
  });

  it("reconciles an ambiguous timeout lift after the timeout expires", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    const id = "ballot-lift-retry";
    const { endedAt, expiresAt } = await insertPassed(database, id);
    await seedLiftModerationAccess(database, new Date().toISOString());
    let reads = 0;
    const twitchFetch = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/bans") && init?.method === "DELETE") {
        return Promise.reject(new TypeError("network failure"));
      }
      reads += 1;
      return Promise.resolve(new Response(JSON.stringify({ data: reads === 1 ? [{
        user_id: targetUserId,
        moderator_id: botUserId,
        reason: votekickTimeoutReason(3, 0, id),
        created_at: endedAt,
        expires_at: expiresAt,
      }] : [] }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", twitchFetch);
    const path = `/api/channels/channel-a/modules/votekick/votekicks/${id}/lift`;

    const ambiguous = await panelRouter.fetch(await requestFor("operator-a", path, "POST"), environmentFor(database));
    expect(ambiguous.status).toBe(502);
    const pending = await database.prepare(
      "SELECT lift_claim_id, lifted_at FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = ?",
    ).bind(id).first<{ lift_claim_id: string | null; lifted_at: string | null }>();
    expect(pending?.lift_claim_id).not.toBeNull();
    expect(pending?.lifted_at).toBeNull();

    const expiredEndedAt = new Date(Date.now() - 120_000).toISOString();
    await database.prepare(
      `UPDATE votekicks SET ended_at = ?, lift_claimed_at = '2000-01-01T00:00:00.000Z'
        WHERE channel_id = 'channel-a' AND votekick_id = ?`,
    ).bind(expiredEndedAt, id).run();
    const retry = await panelRouter.fetch(await requestFor("operator-a", path, "POST"), environmentFor(database));
    const recovered = await database.prepare(
      "SELECT lift_claim_id, lift_claimed_at, lifted_at FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = ?",
    ).bind(id).first<{ lift_claim_id: string | null; lift_claimed_at: string | null; lifted_at: string | null }>();

    expect(retry.status).toBe(200);
    expect(twitchFetch).toHaveBeenCalledTimes(3);
    expect(recovered).toMatchObject({ lift_claim_id: null, lift_claimed_at: null });
    expect(recovered?.lifted_at).not.toBeNull();
  });

  it("rechecks module activation in the atomic timeout claim before calling Twitch", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertPassed(database, "ballot-lift-disabled");
    await seedLiftModerationAccess(database, new Date().toISOString());
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);
    const interleavedDatabase = createWriteInterleavingDatabase(
      database,
      (sql) => sql.includes("UPDATE votekicks SET lift_claim_id"),
      async () => {
        await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'channel-a' AND module_id = 'votekick'").run();
      },
    );

    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-lift-disabled/lift", "POST"),
      environmentFor(interleavedDatabase),
    );

    expect(response.status).toBe(403);
    expect(twitchFetch).not.toHaveBeenCalled();
    await expect(database.prepare("SELECT lifted_at, lift_claim_id FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = 'ballot-lift-disabled'")
      .first()).resolves.toEqual({ lifted_at: null, lift_claim_id: null });
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
