import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createChannelModuleWithAudit,
  getChannelModuleForChannel,
  updateChannelModuleWithAudit,
  type ChannelModuleRecord,
} from "../../src/worker/auth/repository";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

// Deckt die Zusicherungen aus Issue #63 direkt am Repository ab: Rollenschwelle,
// Mandantentrennung und Audit-Kopplung im actorGuard selbst, unabhaengig von
// Handler-Vorabpruefungen und ohne ein Modul in der Registry zu brauchen.

const NOW = "2026-09-19T00:00:00.000Z";
const SETTINGS = '{"betrag":42}';

const actorFor = (userId: string) => ({ userId, sessionId: `session-${userId}` });

const asD1 = (database: TestD1Database): D1Database => database as unknown as D1Database;

const record = (channelId: string, moduleId: string, enabled: boolean): ChannelModuleRecord => ({
  channelId,
  moduleId,
  enabled,
  settings: SETTINGS,
});

const auditCount = async (database: TestD1Database): Promise<number> => {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
  return row?.count ?? 0;
};

describe("Modulaktivierung im Repository", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("aktiviert ein Modul für einen Broadcaster mit genau einem Audit-Eintrag", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const changed = await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      record("kanal-a", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );

    expect(changed).toBe(true);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-a", "test-modul"))
      .resolves.toEqual(record("kanal-a", "test-modul", true));
    await expect(auditCount(database)).resolves.toBe(1);
  });

  it("verweigert die Aktivierung durch einen Bediener und legt keine Zeile an", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const changed = await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      record("kanal-a", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );

    expect(changed).toBe(false);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-a", "test-modul")).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("verweigert die Aktivierung in einem fremden Kanal trotz gültiger Session", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const changed = await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      record("kanal-b", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );

    expect(changed).toBe(false);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-b", "test-modul")).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("deaktiviert ein bestehendes Modul für einen Verwalter mit genau einem weiteren Audit-Eintrag", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      record("kanal-a", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );

    const changed = await updateChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      "kanal-a",
      "test-modul",
      false,
      SETTINGS,
      "modul.deaktiviert",
      NOW,
    );

    expect(changed).toBe(true);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-a", "test-modul"))
      .resolves.toEqual(record("kanal-a", "test-modul", false));
    await expect(auditCount(database)).resolves.toBe(2);
  });

  it("verweigert eine Statusänderung durch einen Bediener und hinterlässt keinen weiteren Audit-Eintrag", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      record("kanal-a", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );
    await insertLoginIdentityAndSession(database, "user-2");
    await insertMember(database, "kanal-a", "user-2", "bediener");

    const changed = await updateChannelModuleWithAudit(
      asD1(database),
      actorFor("user-2"),
      "kanal-a",
      "test-modul",
      false,
      SETTINGS,
      "modul.deaktiviert",
      NOW,
    );

    expect(changed).toBe(false);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-a", "test-modul"))
      .resolves.toEqual(record("kanal-a", "test-modul", true));
    await expect(auditCount(database)).resolves.toBe(1);
  });

  it("verweigert die Deaktivierung eines Moduls in einem fremden Kanal", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertLoginIdentityAndSession(database, "user-2");
    await insertMember(database, "kanal-b", "user-2", "broadcaster");
    await createChannelModuleWithAudit(
      asD1(database),
      actorFor("user-2"),
      record("kanal-b", "test-modul", true),
      "modul.aktiviert",
      NOW,
    );

    const changed = await updateChannelModuleWithAudit(
      asD1(database),
      actorFor("user-1"),
      "kanal-b",
      "test-modul",
      false,
      SETTINGS,
      "modul.deaktiviert",
      NOW,
    );

    expect(changed).toBe(false);
    await expect(getChannelModuleForChannel(asD1(database), "kanal-b", "test-modul"))
      .resolves.toEqual(record("kanal-b", "test-modul", true));
    await expect(auditCount(database)).resolves.toBe(1);
  });
});
