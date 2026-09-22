import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeChannelAccess } from "../../src/worker/auth/authorization";
import type { ChannelRole } from "../../src/contracts/values";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../../src/worker/auth/guards";
import {
  actorGuard,
} from "../../src/worker/db/guards";
import {
  createChannelMemberWithAudit,
  deleteChannelMemberWithAudit,
  updateChannelMemberWithAudit,
} from "../../src/worker/db/channel-members";
import type {
  SessionRecord,
} from "../../src/worker/db/sessions";
import { createSessionCookie } from "../../src/worker/auth/session";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const testKey = (byte: number): string => btoa(
  String.fromCharCode(...new Uint8Array(32).fill(byte)),
).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const testKeyRing = (id: string, byte: number): string => JSON.stringify({
  active: { id, key: testKey(byte) },
  retired: [],
});

type AuthorizationEnvironment = Env & { DB: D1Database };
type AuthorizationContext = {
  Bindings: AuthorizationEnvironment;
  Variables: ChannelAuthorizationVariables;
};

const authorizationApp = new Hono<AuthorizationContext>();
authorizationApp.use(
  "/api/channels/:channelId/request-body-role",
  requireChannelAuthorization(),
);
authorizationApp.post(
  "/api/channels/:channelId/request-body-role",
  (context) => context.json({ role: context.get("channelRole") }),
);

const authorizationEnvironment = (database: TestD1Database): AuthorizationEnvironment => ({
  DB: database as unknown as D1Database,
  SESSION_COOKIE_KEYS: testKeyRing("cookie-v1", 1),
  SESSION_ENCRYPTION_KEYS: testKeyRing("encryption-v1", 2),
} as unknown as AuthorizationEnvironment);

const requestWithBodyRole = async (environment: AuthorizationEnvironment): Promise<Request> => {
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
  return new Request("https://brobot.example/api/channels/kanal-a/request-body-role", {
    method: "POST",
    headers: {
      Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ role: "broadcaster" }),
  });
};

const session = (userId: string): SessionRecord => ({
  sessionId: `session-${userId}`,
  userId,
  login: userId,
  expiresAt: "2099-09-19T00:00:00.000Z",
  createdAt: "2099-09-18T00:00:00.000Z",
  updatedAt: "2099-09-18T00:00:00.000Z",
  revokedAt: null,
  revocationReason: null,
});

const seedChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    channelId,
    channelId,
    channelId,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const seedMember = async (
  database: TestD1Database,
  channelId: string,
  userId: string,
  role: ChannelRole,
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

const seedSession = async (database: TestD1Database, userId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at, revoked_at, revocation_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(
    `session-${userId}`,
    userId,
    userId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?)`,
  ).bind(
    userId,
    userId,
    "[]",
    "access-ciphertext",
    "refresh-ciphertext",
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const actorContext = (userId: string) => ({ userId, sessionId: `session-${userId}` });

const readMember = async (database: TestD1Database, channelId: string, userId: string) => database.prepare(
  `SELECT channel_id, user_id, role, created_at, updated_at
     FROM channel_members
    WHERE channel_id = ? AND user_id = ?`,
).bind(channelId, userId).first<{
  channel_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}>();

const readAudit = async (database: TestD1Database) => database.prepare(
  `SELECT actor_user_id, created_at, channel_id, action, before_json, after_json
     FROM audit_log
    ORDER BY created_at, audit_id`,
).all<{
  actor_user_id: string;
  created_at: string;
  channel_id: string;
  action: string;
  before_json: string;
  after_json: string;
}>();

const databaseRacingBeforeBatch = (
  database: TestD1Database,
  race: () => void,
): D1Database => ({
  prepare: database.prepare.bind(database),
  batch: async (statements: TestPreparedStatement[]) => {
    race();
    return database.batch(statements);
  },
} as unknown as D1Database);

describe("kanalgebundene Autorisierung", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("akzeptiert ein Mitglied nur im angeforderten, vorhandenen Kanal", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "verwalter");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-a"))
      .resolves.toBe("verwalter");
  });

  it("lehnt ein Nichtmitglied ab", async () => {
    await seedChannel(database, "kanal-a");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-a"))
      .resolves.toBeNull();
  });

  it("lehnt eine Mitgliedschaft in einem anderen Kanal ab", async () => {
    await seedChannel(database, "kanal-a");
    await seedChannel(database, "kanal-b");
    await seedMember(database, "kanal-a", "user-1", "broadcaster");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-b"))
      .resolves.toBeNull();
  });

  it("lehnt einen unbekannten Kanal unabhängig von Mitgliedschaften ab", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "broadcaster");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "nicht-freigegeben"))
      .resolves.toBeNull();
  });

  it("akzeptiert einen unbekannten Rollenwert aus der Datenbank nicht", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({ first: () => Promise.resolve({ role: "administrator" }) }),
      }),
    } as unknown as D1Database;

    await expect(authorizeChannelAccess(database, session("user-1"), "kanal-a"))
      .resolves.toBeNull();
  });

  it("übernimmt die vorhandene Broadcaster-Zeile unverändert in die neue Tabelle", async () => {
    const migrationDatabase = new TestD1Database(2);
    migrationDatabase.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("kanal-a", "kanal-a", "kanal-a", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").runSync();
    migrationDatabase.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("kanal-a", "user-1", "broadcaster", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").runSync();

    migrationDatabase.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0002_autorisierung.sql"), "utf8"));

    await expect(migrationDatabase.prepare(
      `SELECT channel_id, user_id, role, created_at, updated_at
         FROM channel_members
        WHERE channel_id = ? AND user_id = ?`,
    ).bind("kanal-a", "user-1").first()).resolves.toEqual({
      channel_id: "kanal-a",
      user_id: "user-1",
      role: "broadcaster",
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    });
    migrationDatabase.close();
  });

  it("bricht die Migration bei einem ungültigen Altrollenwert ab und erhält die alte Tabelle", () => {
    const migrationDatabase = new TestD1Database(2);
    migrationDatabase.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("kanal-a", "kanal-a", "kanal-a", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").runSync();
    migrationDatabase.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("kanal-a", "user-1", "administrator", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").runSync();

    expect(() => {
      migrationDatabase.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0002_autorisierung.sql"), "utf8"));
    }).toThrow();
    expect(migrationDatabase.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_members'",
    ).get()).toEqual({ name: "channel_members" });
    expect(migrationDatabase.sqlite.prepare(
      `SELECT channel_id, user_id, role
         FROM channel_members
        WHERE channel_id = ? AND user_id = ?`,
    ).get("kanal-a", "user-1")).toEqual({
      channel_id: "kanal-a",
      user_id: "user-1",
      role: "administrator",
    });
    migrationDatabase.close();
  });

  it("stellt beide fachlichen channel_members-Indizes nach der Migration wieder her", () => {
    const migrationDatabase = new TestD1Database();
    const indexes = migrationDatabase.sqlite.prepare("PRAGMA index_list('channel_members')").all() as Array<{ name: string }>;

    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "channel_members_channel_idx",
      "channel_members_channel_role_idx",
    ]));
    migrationDatabase.close();
  });

  it("weist einen Rollenwert außerhalb des festen Satzes über SQLite ab", async () => {
    await seedChannel(database, "kanal-a");

    await expect(database.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "user-1",
      "operator",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ).run()).rejects.toThrow();
  });

  it("behält den Cascade-Fremdschlüssel zum Kanal bei", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "bediener");

    await database.prepare("DELETE FROM channels WHERE channel_id = ?")
      .bind("kanal-a")
      .run();

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
  });

  it("schließt einen Request-Body-Rollenwert aus der Autorisierungsentscheidung aus", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "user-1");

    const response = await authorizationApp.fetch(
      await requestWithBodyRole(authorizationEnvironment(database)),
      authorizationEnvironment(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ role: "bediener" });
  });
});

describe("atomare Mitgliedsänderung und Audit", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("schreibt Änderung und Audit-Eintrag gemeinsam", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedSession(database, "actor-1");

    await createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "bediener",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "mitglied.hinzugefügt",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "bediener" });
    await expect(readAudit(database)).resolves.toMatchObject({
      results: [{
        actor_user_id: "actor-1",
        created_at: "2026-09-18T00:01:00.000Z",
        channel_id: "kanal-a",
        action: "mitglied.hinzugefügt",
        before_json: "null",
        after_json: JSON.stringify({
          channelId: "kanal-a",
          userId: "user-1",
          role: "bediener",
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:00:00.000Z",
        }),
      }],
    });
  });

  it("auditiert eine Rollenänderung mit dem tatsächlichen Vorher-Zustand", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");

    await updateChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({
      role: "verwalter",
      created_at: "2026-09-18T00:00:00.000Z",
    });
    const audit = await readAudit(database);
    expect(JSON.parse(audit.results[0]?.before_json ?? "{}") as unknown).toMatchObject({ role: "bediener" });
    expect(JSON.parse(audit.results[0]?.after_json ?? "{}") as unknown).toMatchObject({
      role: "verwalter",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("schreibt bei einer konkurrierenden Änderung keinen veralteten Audit-Vorzustand", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          `UPDATE channel_members
              SET role = ?, updated_at = ?
            WHERE channel_id = ? AND user_id = ?`,
        ).bind(
          "broadcaster",
          "2026-09-18T00:02:30.000Z",
          "kanal-a",
          "user-1",
        ).run();
        return database.batch(statements);
      },
    } as unknown as D1Database;

    await updateChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("legt bei einer konkurrierenden Löschung durch PATCH kein Mitglied neu an", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
        ).bind("kanal-a", "user-1").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;

    await updateChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("verweigert INSERT, wenn der Actor zwischen Prüfung und Mutation seine Rolle verliert", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedSession(database, "actor-1");
    const racingDatabase = databaseRacingBeforeBatch(database, () => {
      database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind("kanal-a", "actor-1").runSync();
    });

    await expect(createChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "bediener",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "mitglied.hinzugefügt",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("verweigert UPDATE, wenn der Actor zwischen Prüfung und Mutation seine Rolle verliert", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");
    const racingDatabase = databaseRacingBeforeBatch(database, () => {
      database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind("kanal-a", "actor-1").runSync();
    });

    await expect(updateChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "bediener" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("verweigert DELETE, wenn der Actor zwischen Prüfung und Mutation seine Rolle verliert", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");
    const racingDatabase = databaseRacingBeforeBatch(database, () => {
      database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind("kanal-a", "actor-1").runSync();
    });

    await expect(deleteChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      "kanal-a",
      "user-1",
      "mitglied.entfernt",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "bediener" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("schützt zwei gleichzeitige Löschungen bei genau zwei Broadcastern atomar", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "broadcaster-1", "broadcaster");
    await seedMember(database, "kanal-a", "broadcaster-2", "broadcaster");
    await seedSession(database, "actor-1");
    const racingDatabase = databaseRacingBeforeBatch(database, () => {
      database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind("kanal-a", "broadcaster-2").runSync();
    });

    await expect(deleteChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      "kanal-a",
      "broadcaster-1",
      "mitglied.entfernt",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("schützt zwei gleichzeitige Herabstufungen bei genau zwei Broadcastern atomar", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "broadcaster-1", "broadcaster");
    await seedMember(database, "kanal-a", "broadcaster-2", "broadcaster");
    await seedSession(database, "actor-1");
    const racingDatabase = databaseRacingBeforeBatch(database, () => {
      database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind("kanal-a", "broadcaster-2").runSync();
    });

    await expect(updateChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "broadcaster-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("verwandelt einen zweiten Create nicht in ein UPDATE", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedSession(database, "actor-1");
    const member = {
      channelId: "kanal-a",
      userId: "user-1",
      role: "bediener" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:01:00.000Z",
    };

    await expect(createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      member,
      "mitglied.hinzugefügt",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(true);
    await expect(createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      { ...member, role: "verwalter" },
      "mitglied.hinzugefügt",
      "2026-09-18T00:02:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "bediener" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [expect.objectContaining({ action: "mitglied.hinzugefügt" })] });
  });

  it("hinterlässt bei einer fehlgeschlagenen Änderung keinen Audit-Eintrag", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedSession(database, "actor-1");

    await expect(createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "außenstehend" as ChannelRole,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "mitglied.geändert",
      "2026-09-18T00:01:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    )).rejects.toThrow();

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("rollt eine erfolgreiche Mitgliedsänderung zurück, wenn der Audit-Schritt scheitert", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedSession(database, "actor-1");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "00000000-0000-4000-8000-000000000001",
      "actor-1",
      "2026-09-18T00:00:00.000Z",
      "kanal-a",
      "bereits-vorhanden",
      "null",
      "{}",
    ).run();

    const randomUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    try {
      await expect(createChannelMemberWithAudit(
        database as unknown as D1Database,
        actorContext("actor-1"),
        {
          channelId: "kanal-a",
          userId: "user-1",
          role: "bediener",
          createdAt: "2026-09-18T00:01:00.000Z",
          updatedAt: "2026-09-18T00:01:00.000Z",
        },
        "mitglied.hinzugefügt",
        "2026-09-18T00:01:00.000Z",
        actorGuard("'broadcaster', 'verwalter'"),
      )).rejects.toThrow();
    } finally {
      randomUuid.mockRestore();
    }

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({
      results: [{ action: "bereits-vorhanden" }],
    });
  });

  it("auditiert das Entfernen mit Vorher- und Nachher-Zustand", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");

    await deleteChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      "kanal-a",
      "user-1",
      "mitglied.entfernt",
      "2026-09-18T00:02:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    const audit = await readAudit(database);
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]?.before_json ?? "{}") as unknown).toMatchObject({
      channelId: "kanal-a",
      userId: "user-1",
      role: "bediener",
    });
    expect(audit.results[0]?.after_json).toBe("null");
  });

  it("schreibt nach einer konkurrierenden Löschung keinen Audit-Eintrag", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "verwalter");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    await seedSession(database, "actor-1");
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
        ).bind("kanal-a", "user-1").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;

    await deleteChannelMemberWithAudit(
      racingDatabase,
      actorContext("actor-1"),
      "kanal-a",
      "user-1",
      "mitglied.entfernt",
      "2026-09-18T00:02:00.000Z",
      actorGuard("'broadcaster', 'verwalter'"),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });
});
