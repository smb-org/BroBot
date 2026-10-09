import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareModuleAudit } from "../../src/worker/module-audit";
import { createModuleSecretAccess, createModuleSecretReadAccess } from "../../src/worker/module-secrets";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const CHANNEL_ID = "module-secret-channel";
const MODULE_ID = "sample_module";
const SECRET_NAME = "endpoint";
const SECRET_VALUE = "module-secret-sentinel-8d7f3";
const NOW = "2026-10-05T12:00:00.000Z";
const OLD_KEY = { id: "old", key: testKey(41) };
const NEW_KEY = { id: "new", key: testKey(42) };

const keyRing = (active: typeof OLD_KEY | typeof NEW_KEY, retired: readonly (typeof OLD_KEY | typeof NEW_KEY)[] = []): string =>
  JSON.stringify({ active, retired });

const databaseInstances: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databaseInstances.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const accessFor = (database: TestD1Database, tokenEncryptionKeys: string) => createModuleSecretAccess(
  { DB: database as unknown as D1Database, TOKEN_ENCRYPTION_KEYS: tokenEncryptionKeys },
  CHANNEL_ID,
  MODULE_ID,
);

const addAudit = (
  database: TestD1Database,
  userId: string,
  action: "module.secret.replaced" | "module.secret.removed",
  state: "replaced" | "removed",
): TestPreparedStatement => prepareModuleAudit(
  database as unknown as D1Database,
  userId,
  NOW,
  {
    channelId: CHANNEL_ID,
    moduleId: MODULE_ID,
    action,
    before: null,
    after: { name: SECRET_NAME, state },
  },
) as unknown as TestPreparedStatement;

afterEach(() => {
  for (const database of databaseInstances.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("host module secrets", () => {
  it("round-trips a secret and batches only redacted audit state with its write and delete", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));

    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    const writeResults = await database.batch([
      write as unknown as TestPreparedStatement,
      addAudit(database, "manager", "module.secret.replaced", "replaced"),
    ]);

    expect(writeResults[0]?.meta.changes).toBe(1);
    expect(await access.read(SECRET_NAME)).toBe(SECRET_VALUE);
    expect(await access.status(SECRET_NAME)).toEqual({ configured: true, updatedAt: NOW });
    const stored = await database.prepare(
      "SELECT key_id, revision, updated_by FROM module_secrets WHERE channel_id = ? AND module_id = ? AND name = ?",
    ).bind(CHANNEL_ID, MODULE_ID, SECRET_NAME).first<{ key_id: string; revision: number; updated_by: string }>();
    expect(stored).toEqual({ key_id: NEW_KEY.id, revision: 1, updated_by: "manager" });

    const remove = access.prepareDelete(SECRET_NAME, { userId: "manager" }, NOW);
    const deleteResults = await database.batch([
      remove as unknown as TestPreparedStatement,
      addAudit(database, "manager", "module.secret.removed", "removed"),
    ]);
    expect(deleteResults[0]?.meta.changes).toBe(1);
    expect(await access.read(SECRET_NAME)).toBeNull();
    expect(await access.status(SECRET_NAME)).toEqual({ configured: false, updatedAt: null });

    const auditRows = await database.prepare("SELECT after_json FROM audit_log ORDER BY created_at, action")
      .all<{ after_json: string }>();
    expect(auditRows.results).toEqual([
      { after_json: JSON.stringify({ name: SECRET_NAME, state: "removed" }) },
      { after_json: JSON.stringify({ name: SECRET_NAME, state: "replaced" }) },
    ]);
    expect(JSON.stringify(auditRows.results)).not.toContain(SECRET_VALUE);
  });

  it("gives a recreated secret a different version", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const actor = { userId: "manager" };
    await (await access.prepareWrite(SECRET_NAME, SECRET_VALUE, actor, NOW)).run();
    const first = await access.readWithVersion(SECRET_NAME);
    await access.prepareDelete(SECRET_NAME, actor, NOW).run();
    await (await access.prepareWrite(SECRET_NAME, SECRET_VALUE, actor, NOW)).run();
    const second = await access.readWithVersion(SECRET_NAME);
    expect(first?.value).toBe(second?.value);
    expect(first?.version).not.toBe(second?.version);
    expect(first?.version).not.toContain(SECRET_VALUE);
  });

  it("returns null when a ciphertext is copied to another secret name", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);
    await database.prepare(
      `INSERT INTO module_secrets (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       SELECT channel_id, module_id, ?, ciphertext, key_id, revision, updated_at, updated_by
         FROM module_secrets WHERE channel_id = ? AND module_id = ? AND name = ?`,
    ).bind("copied", CHANNEL_ID, MODULE_ID, SECRET_NAME).run();

    expect(await access.read("copied")).toBeNull();
  });

  it("returns null when a ciphertext is copied to another channel", async () => {
    const database = await createDatabase();
    await insertChannel(database, "other-channel");
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);
    await database.prepare(
      `INSERT INTO module_secrets (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       SELECT ?, module_id, name, ciphertext, key_id, revision, updated_at, updated_by
         FROM module_secrets WHERE channel_id = ? AND module_id = ? AND name = ?`,
    ).bind("other-channel", CHANNEL_ID, MODULE_ID, SECRET_NAME).run();

    const otherAccess = createModuleSecretAccess(
      { DB: database as unknown as D1Database, TOKEN_ENCRYPTION_KEYS: keyRing(NEW_KEY) },
      "other-channel",
      MODULE_ID,
    );
    expect(await otherAccess.read(SECRET_NAME)).toBeNull();
    expect(await access.read(SECRET_NAME)).toBe(SECRET_VALUE);
  });

  it("returns null when a ciphertext is copied to another module", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);
    await database.prepare(
      `INSERT INTO module_secrets (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       SELECT channel_id, ?, name, ciphertext, key_id, revision, updated_at, updated_by
         FROM module_secrets WHERE channel_id = ? AND module_id = ? AND name = ?`,
    ).bind("other_module", CHANNEL_ID, MODULE_ID, SECRET_NAME).run();

    const otherAccess = createModuleSecretAccess(
      { DB: database as unknown as D1Database, TOKEN_ENCRYPTION_KEYS: keyRing(NEW_KEY) },
      CHANNEL_ID,
      "other_module",
    );
    expect(await otherAccess.read(SECRET_NAME)).toBeNull();
    expect(await access.read(SECRET_NAME)).toBe(SECRET_VALUE);
  });

  it.each([
    ["membership removed", "DELETE FROM channel_members WHERE user_id = 'manager'"],
    ["session revoked", "DELETE FROM auth_sessions WHERE user_id = 'manager'"],
  ])("fails replace and delete when authorization is revoked before the batch (%s)", async (_label, revoke) => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    await insertLoginIdentityAndSession(database, "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const actor = { userId: "manager", sessionId: "session-manager" };
    const seed = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, actor, NOW);
    await database.batch([seed as unknown as TestPreparedStatement]);
    const replace = await access.prepareWrite(SECRET_NAME, "replacement-value", actor, NOW);
    const remove = access.prepareDelete(SECRET_NAME, actor, NOW);

    await database.prepare(revoke).run();
    const results = await database.batch([
      replace as unknown as TestPreparedStatement,
      remove as unknown as TestPreparedStatement,
      addAudit(database, "manager", "module.secret.replaced", "replaced"),
    ]);

    expect(results.map((result) => result.meta.changes)).toEqual([0, 0, 0]);
    expect(await access.read(SECRET_NAME)).toBe(SECRET_VALUE);
    expect(await database.prepare("SELECT revision FROM module_secrets").first<{ revision: number }>()).toEqual({ revision: 1 });
  });

  it("decrypts a value encrypted with a retired key", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const oldAccess = accessFor(database, keyRing(OLD_KEY));
    const write = await oldAccess.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);

    const rotatedAccess = accessFor(database, keyRing(NEW_KEY, [OLD_KEY]));
    expect(await rotatedAccess.read(SECRET_NAME)).toBe(SECRET_VALUE);

    const replace = await rotatedAccess.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([replace as unknown as TestPreparedStatement]);
    const rotatedRow = await database.prepare(
      "SELECT key_id, revision FROM module_secrets WHERE channel_id = ? AND module_id = ? AND name = ?",
    ).bind(CHANNEL_ID, MODULE_ID, SECRET_NAME).first<{ key_id: string; revision: number }>();
    expect(rotatedRow).toEqual({ key_id: NEW_KEY.id, revision: 2 });
  });

  it("cascades secret rows when their channel is deleted", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);

    await database.prepare("DELETE FROM channels WHERE channel_id = ?").bind(CHANNEL_ID).run();

    expect(await database.prepare("SELECT COUNT(*) AS count FROM module_secrets").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("gives template providers read-only access scoped to their module", async () => {
    const database = await createDatabase();
    const readOnly = createModuleSecretReadAccess(
      { DB: database as unknown as D1Database, TOKEN_ENCRYPTION_KEYS: keyRing(NEW_KEY) },
      CHANNEL_ID,
      MODULE_ID,
    );

    expect(Object.keys(readOnly).sort((a, b) => a.localeCompare(b))).toEqual(["read", "readWithVersion", "status"]);
    expect(await readOnly.status(SECRET_NAME)).toEqual({ configured: false, updatedAt: null });
    await expect(readOnly.readWithVersion(SECRET_NAME)).resolves.toBeNull();
  });

  it("rejects a write without the management role inside the D1 batch", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "operator", "operator");
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "operator" }, NOW);
    const results = await database.batch([
      write as unknown as TestPreparedStatement,
      addAudit(database, "operator", "module.secret.replaced", "replaced"),
    ]);

    expect(results[0]?.meta.changes).toBe(0);
    expect(results[1]?.meta.changes).toBe(0);
    expect(await access.status(SECRET_NAME)).toEqual({ configured: false, updatedAt: null });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("keeps secret values out of console calls and thrown errors", async () => {
    const database = await createDatabase();
    await insertMember(database, CHANNEL_ID, "manager", "manager");
    const methods = ["debug", "info", "log", "warn", "error"] as const;
    const consoleSpies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const access = accessFor(database, keyRing(NEW_KEY));
    const write = await access.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    await database.batch([write as unknown as TestPreparedStatement]);

    const invalidAccess = accessFor(database, "invalid");
    let thrown: unknown;
    try {
      await invalidAccess.prepareWrite(SECRET_NAME, SECRET_VALUE, { userId: "manager" }, NOW);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(SECRET_VALUE);
    const consoleOutput = consoleSpies.map((spy) => JSON.stringify(spy.mock.calls)).join(" ");
    expect(consoleOutput).not.toContain(SECRET_VALUE);
  });
});
