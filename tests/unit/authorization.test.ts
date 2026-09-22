import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeChannelAccess } from "../../src/worker/auth/authorization";
import { MANAGING_ROLES, type ChannelRole } from "../../src/contracts/values";
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

describe("channel-scoped authorization", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("accepts a member only in the requested, existing channel", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "manager");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-a"))
      .resolves.toBe("manager");
  });

  it("rejects a non-member", async () => {
    await seedChannel(database, "kanal-a");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-a"))
      .resolves.toBeNull();
  });

  it("rejects membership in a different channel", async () => {
    await seedChannel(database, "kanal-a");
    await seedChannel(database, "kanal-b");
    await seedMember(database, "kanal-a", "user-1", "broadcaster");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "kanal-b"))
      .resolves.toBeNull();
  });

  it("rejects an unknown channel regardless of memberships", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "broadcaster");

    await expect(authorizeChannelAccess(database as unknown as D1Database, session("user-1"), "nicht-freigegeben"))
      .resolves.toBeNull();
  });

  it("doesn't accept an unknown role value from the database", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({ first: () => Promise.resolve({ role: "administrator" }) }),
      }),
    } as unknown as D1Database;

    await expect(authorizeChannelAccess(database, session("user-1"), "kanal-a"))
      .resolves.toBeNull();
  });



  it("restores both functional channel_members indexes after the migration", () => {
    const migrationDatabase = new TestD1Database();
    const indexes = migrationDatabase.sqlite.prepare("PRAGMA index_list('channel_members')").all() as Array<{ name: string }>;

    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "channel_members_channel_idx",
      "channel_members_channel_role_idx",
    ]));
    migrationDatabase.close();
  });

  it("rejects a role value outside the fixed set via SQLite", async () => {
    await seedChannel(database, "kanal-a");

    await expect(database.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "user-1",
      "invalid",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ).run()).rejects.toThrow();
  });

  it("keeps the cascading foreign key to the channel", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "operator");

    await database.prepare("DELETE FROM channels WHERE channel_id = ?")
      .bind("kanal-a")
      .run();

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
  });

  it("excludes a request-body role value from the authorization decision", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "operator");
    await seedSession(database, "user-1");

    const response = await authorizationApp.fetch(
      await requestWithBodyRole(authorizationEnvironment(database)),
      authorizationEnvironment(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ role: "operator" });
  });
});

describe("atomic member change and audit", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("writes the change and the audit entry together", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedSession(database, "actor-1");

    await createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "operator",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "member.added",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "operator" });
    await expect(readAudit(database)).resolves.toMatchObject({
      results: [{
        actor_user_id: "actor-1",
        created_at: "2026-09-18T00:01:00.000Z",
        channel_id: "kanal-a",
        action: "member.added",
        before_json: "null",
        after_json: JSON.stringify({
          channelId: "kanal-a",
          userId: "user-1",
          role: "operator",
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:00:00.000Z",
        }),
      }],
    });
  });

  it("audits a role change with the actual before state", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
    await seedSession(database, "actor-1");

    await updateChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "manager",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "member.role_changed",
      "2026-09-18T00:03:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({
      role: "manager",
      created_at: "2026-09-18T00:00:00.000Z",
    });
    const audit = await readAudit(database);
    expect(JSON.parse(audit.results[0]?.before_json ?? "{}") as unknown).toMatchObject({ role: "operator" });
    expect(JSON.parse(audit.results[0]?.after_json ?? "{}") as unknown).toMatchObject({
      role: "manager",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("doesn't write a stale audit before-state on a concurrent change", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
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
        role: "manager",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "member.role_changed",
      "2026-09-18T00:03:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("doesn't recreate a member via PATCH on a concurrent delete", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
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
        role: "manager",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "member.role_changed",
      "2026-09-18T00:03:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("denies INSERT when the actor loses their role between check and mutation", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
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
        role: "operator",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "member.added",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("denies UPDATE when the actor loses their role between check and mutation", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
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
        role: "manager",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "member.role_changed",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "operator" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("denies DELETE when the actor loses their role between check and mutation", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
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
      "member.removed",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "operator" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("protects two simultaneous deletions atomically when there are exactly two broadcasters", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
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
      "member.removed",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("protects two simultaneous demotions atomically when there are exactly two broadcasters", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
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
        role: "manager",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:01:00.000Z",
      },
      "member.role_changed",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("doesn't turn a second create into an update", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedSession(database, "actor-1");
    const member = {
      channelId: "kanal-a",
      userId: "user-1",
      role: "operator" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:01:00.000Z",
    };

    await expect(createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      member,
      "member.added",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(true);
    await expect(createChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      { ...member, role: "manager" },
      "member.added",
      "2026-09-18T00:02:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).resolves.toBe(false);

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "operator" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [expect.objectContaining({ action: "member.added" })] });
  });

  it("leaves no audit entry on a failed change", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
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
      "member.role_changed",
      "2026-09-18T00:01:00.000Z",
      actorGuard(MANAGING_ROLES),
    )).rejects.toThrow();

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("rolls back a successful member change when the audit step fails", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
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
          role: "operator",
          createdAt: "2026-09-18T00:01:00.000Z",
          updatedAt: "2026-09-18T00:01:00.000Z",
        },
        "member.added",
        "2026-09-18T00:01:00.000Z",
        actorGuard(MANAGING_ROLES),
      )).rejects.toThrow();
    } finally {
      randomUuid.mockRestore();
    }

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({
      results: [{ action: "bereits-vorhanden" }],
    });
  });

  it("audits the removal with before and after state", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
    await seedSession(database, "actor-1");

    await deleteChannelMemberWithAudit(
      database as unknown as D1Database,
      actorContext("actor-1"),
      "kanal-a",
      "user-1",
      "member.removed",
      "2026-09-18T00:02:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    const audit = await readAudit(database);
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]?.before_json ?? "{}") as unknown).toMatchObject({
      channelId: "kanal-a",
      userId: "user-1",
      role: "operator",
    });
    expect(audit.results[0]?.after_json).toBe("null");
  });

  it("doesn't write an audit entry after a concurrent delete", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "actor-1", "manager");
    await seedMember(database, "kanal-a", "user-1", "operator");
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
      "member.removed",
      "2026-09-18T00:02:00.000Z",
      actorGuard(MANAGING_ROLES),
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });
});
