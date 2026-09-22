import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createChannelModuleWithAudit,
  getChannelModuleForChannel,
  updateChannelModuleWithAudit,
  type ChannelModuleRecord,
} from "../../src/worker/db/channel-modules";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

// Covers the guarantees from issue #63 directly at the repository level: role
// threshold, tenant separation, and audit coupling in actorGuard itself,
// independent of handler precondition checks and without needing a module in
// the registry.

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

// Common flow for the rejection cases: create a membership with a role in
// one channel, attempt activation in a (possibly different) target channel,
// verify the rejection and the unchanged final state.
const expectDeniedCreate = async (
  database: TestD1Database,
  options: {
    memberChannelId: string;
    role: "broadcaster" | "manager" | "operator";
    targetChannelId: string;
    extraChannelIds?: string[];
  },
): Promise<void> => {
  await insertChannel(database, options.memberChannelId);
  for (const extraChannelId of options.extraChannelIds ?? []) {
    await insertChannel(database, extraChannelId);
  }
  await insertLoginIdentityAndSession(database, "user-1");
  await insertMember(database, options.memberChannelId, "user-1", options.role);

  const changed = await createChannelModuleWithAudit(
    asD1(database),
    actorFor("user-1"),
    record(options.targetChannelId, "test-modul", true),
    "modul.aktiviert",
    NOW,
  );

  expect(changed).toBe(false);
  await expect(getChannelModuleForChannel(asD1(database), options.targetChannelId, "test-modul")).resolves.toBeNull();
  await expect(auditCount(database)).resolves.toBe(0);
};

describe("module activation in the repository", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("activates a module for a broadcaster with exactly one audit entry", async () => {
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

  it("denies activation by an operator and creates no row", async () => {
    await expectDeniedCreate(database, {
      memberChannelId: "kanal-a",
      role: "operator",
      targetChannelId: "kanal-a",
    });
  });

  it("denies activation in a different channel despite a valid session", async () => {
    await expectDeniedCreate(database, {
      memberChannelId: "kanal-a",
      role: "broadcaster",
      targetChannelId: "kanal-b",
      extraChannelIds: ["kanal-b"],
    });
  });

  it("deactivates an existing module for a manager with exactly one more audit entry", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
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

  it("denies a status change by an operator and leaves no further audit entry", async () => {
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
    await insertMember(database, "kanal-a", "user-2", "operator");

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

  it("denies deactivating a module in a different channel", async () => {
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
