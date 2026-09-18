import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authorizeChannelAccess,
  type ChannelMemberRole,
} from "../../src/worker/auth/authorization";
import {
  deleteChannelMemberWithAudit,
  upsertChannelMemberWithAudit,
} from "../../src/worker/auth/repository";
import type { SessionRecord } from "../../src/worker/auth/repository";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

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
  role: ChannelMemberRole,
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

    const requestBodyRole = "broadcaster";
    await expect(authorizeChannelAccess(
      database as unknown as D1Database,
      session("user-1"),
      "kanal-a",
    )).resolves.toBe("bediener");
    expect(requestBodyRole).not.toBe("bediener");
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

    await upsertChannelMemberWithAudit(
      database as unknown as D1Database,
      "actor-1",
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "bediener",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "mitglied.hinzugefügt",
      "2026-09-18T00:01:00.000Z",
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
    await seedMember(database, "kanal-a", "user-1", "bediener");

    await upsertChannelMemberWithAudit(
      database as unknown as D1Database,
      "actor-1",
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
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
    await seedMember(database, "kanal-a", "user-1", "bediener");
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

    await upsertChannelMemberWithAudit(
      racingDatabase,
      "actor-1",
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toMatchObject({ role: "broadcaster" });
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("schreibt nach einer konkurrierenden Löschung beim Upsert keinen veralteten Audit-Eintrag", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "bediener");
    const racingDatabase = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
        ).bind("kanal-a", "user-1").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;

    await upsertChannelMemberWithAudit(
      racingDatabase,
      "actor-1",
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "verwalter",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:03:00.000Z",
      },
      "mitglied.rolle_geändert",
      "2026-09-18T00:03:00.000Z",
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("hinterlässt bei einer fehlgeschlagenen Änderung keinen Audit-Eintrag", async () => {
    await seedChannel(database, "kanal-a");

    await expect(upsertChannelMemberWithAudit(
      database as unknown as D1Database,
      "actor-1",
      {
        channelId: "kanal-a",
        userId: "user-1",
        role: "außenstehend" as ChannelMemberRole,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "mitglied.geändert",
      "2026-09-18T00:01:00.000Z",
    )).rejects.toThrow();

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("rollt eine erfolgreiche Mitgliedsänderung zurück, wenn der Audit-Schritt scheitert", async () => {
    await seedChannel(database, "kanal-a");
    const mutation = database.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "user-1",
      "bediener",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const failingAudit = database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1",
      "actor-1",
      "2026-09-18T00:01:00.000Z",
      "nicht-vorhandener-kanal",
      "mitglied.hinzugefügt",
      "null",
      "{}",
    );

    await expect(database.batch([mutation, failingAudit])).rejects.toThrow();
    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });

  it("auditiert das Entfernen mit Vorher- und Nachher-Zustand", async () => {
    await seedChannel(database, "kanal-a");
    await seedMember(database, "kanal-a", "user-1", "bediener");

    await deleteChannelMemberWithAudit(
      database as unknown as D1Database,
      "actor-1",
      "kanal-a",
      "user-1",
      "mitglied.entfernt",
      "2026-09-18T00:02:00.000Z",
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
    await seedMember(database, "kanal-a", "user-1", "bediener");
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
      "actor-1",
      "kanal-a",
      "user-1",
      "mitglied.entfernt",
      "2026-09-18T00:02:00.000Z",
    );

    await expect(readMember(database, "kanal-a", "user-1")).resolves.toBeNull();
    await expect(readAudit(database)).resolves.toMatchObject({ results: [] });
  });
});
