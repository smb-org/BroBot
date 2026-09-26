import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTextCommandRepository, initializeListCommand } from "../../src/modules/text_commands/adapters/d1";
import { prepareChannelVariableChange } from "../../src/worker/db/channel-variables";
import { purgeOldTextCommandUserCooldowns } from "../../src/worker/db/text-command-user-cooldowns";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const ACTOR = { userId: "user-1", sessionId: "session-user-1" };
const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });

describe("Text commands D1 adapter", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("separates same-named commands by channel", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertMember(database, "kanal-b", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);

    await expect(repository.create({
      channelId: "kanal-a", name: "hallo", text: "A", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(repository.create({
      channelId: "kanal-b", name: "hallo", text: "B", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(repository.list("kanal-a")).resolves.toEqual([expect.objectContaining({
      channelId: "kanal-a", name: "hallo", text: "A",
    })]);
    await expect(repository.list("kanal-b")).resolves.toEqual([expect.objectContaining({
      channelId: "kanal-b", name: "hallo", text: "B",
    })]);
  });

  it("rejects an old revision after deleting and recreating the same command name", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Original", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR);
    const loaded = await repository.find("kanal-a", "hallo");
    if (loaded === null) throw new Error("Created command was not found.");

    await expect(repository.delete("kanal-a", "hallo", loaded.revision, ACTOR, NOW)).resolves.toEqual({ ok: true });
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Replacement", kind: "text", cooldownSeconds: 5,
      now: "2026-09-19T12:00:01.000Z",
    }, ACTOR);
    const replacement = await repository.find("kanal-a", "hallo");
    if (replacement === null) throw new Error("Recreated command was not found.");
    expect(replacement.revision).toBeGreaterThan(loaded.revision);

    await expect(repository.change({
      channelId: "kanal-a", name: "hallo", newName: "hallo", text: "Stale save", kind: "text",
      enabled: true, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      expectedRevision: loaded.revision, now: "2026-09-19T12:00:02.000Z",
    }, ACTOR)).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
      current: { text: "Replacement", revision: replacement.revision },
    });
  });

  it("rejects a stale save after the built-in list command is deleted and the module is re-enabled", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await initializeListCommand(database as unknown as D1Database, "kanal-a", ACTOR, NOW, authorize);
    const loaded = await repository.find("kanal-a", "befehle");
    if (loaded === null) throw new Error("Built-in command was not found.");
    expect(loaded.revision).toBe(Date.parse(NOW));

    await expect(repository.delete("kanal-a", "befehle", loaded.revision, ACTOR, NOW)).resolves.toEqual({ ok: true });
    const reenabledAt = "2026-09-19T12:00:01.000Z";
    await initializeListCommand(database as unknown as D1Database, "kanal-a", ACTOR, reenabledAt, authorize);
    const recreated = await repository.find("kanal-a", "befehle");
    if (recreated === null) throw new Error("Recreated built-in command was not found.");
    expect(recreated.revision).toBeGreaterThan(loaded.revision);

    await expect(repository.change({
      channelId: "kanal-a", name: "befehle", newName: "befehle", text: "", kind: "list",
      enabled: true, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      expectedRevision: loaded.revision, now: "2026-09-19T12:00:02.000Z",
    }, ACTOR)).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
      current: { revision: recreated.revision },
    });
  });

  it("claims a command only once within its cooldown period", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR);
    const loaded = await repository.find("kanal-a", "hallo");
    const initialRevision = Date.parse(NOW);
    expect(loaded?.revision).toBe(initialRevision);

    await expect(repository.claim("kanal-a", "hallo", NOW)).resolves.toMatchObject({ claimed: true });
    await expect(repository.find("kanal-a", "hallo")).resolves.toMatchObject({ revision: initialRevision, lastUsedAt: NOW });
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:01.000Z"))
      .resolves.toMatchObject({ claimed: false, command: { lastUsedAt: NOW } });
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:05.000Z"))
      .resolves.toMatchObject({ claimed: true });
  });

  it("claims per-user cooldowns atomically without consuming the global cooldown", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);

    await expect(repository.claim("kanal-a", "hallo", NOW, "user-a", 60)).resolves.toMatchObject({ claimed: true });
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:30.000Z", "user-a", 60))
      .resolves.toMatchObject({ claimed: false, reason: "user_cooldown", remainingSeconds: 30 });
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:30.000Z", "user-b", 60))
      .resolves.toMatchObject({ claimed: true });
    await expect(database.prepare(
      "SELECT last_used_at FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ last_used_at: "2026-09-19T12:00:30.000Z" });
    await expect(database.prepare(
      "SELECT user_id, last_used_at FROM text_command_user_cooldowns ORDER BY user_id",
    ).all()).resolves.toMatchObject({ results: [
      { user_id: "user-a", last_used_at: NOW },
      { user_id: "user-b", last_used_at: "2026-09-19T12:00:30.000Z" },
    ] });
  });

  it("does not write a per-user row while the global cooldown is active", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 60,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);

    await repository.claim("kanal-a", "hallo", NOW, "user-a", 60);
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:30.000Z", "user-b", 60))
      .resolves.toMatchObject({ claimed: false, reason: "cooldown", remainingSeconds: 30 });
    await expect(database.prepare(
      "SELECT user_id FROM text_command_user_cooldowns ORDER BY user_id",
    ).all()).resolves.toMatchObject({ results: [{ user_id: "user-a" }] });
  });

  it("gives both users a per-user cooldown when a variable command is claimed by each at the same read timestamp", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'score', 0, ?, ?)`,
    ).bind(NOW, NOW).run();
    await repository.create({
      channelId: "kanal-a", name: "increment", text: "Score {var.score}", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, variableAction: { name: "score", operation: "add", amount: 1 }, now: NOW,
    }, ACTOR);
    const knownCommand = await repository.find("kanal-a", "increment");
    if (knownCommand === null) throw new Error("Command missing before the concurrent claims.");
    const prepareChange = (channelId: string, change: Parameters<typeof prepareChannelVariableChange>[2], at: string, guard: Parameters<typeof prepareChannelVariableChange>[4]) =>
      prepareChannelVariableChange(database as unknown as D1Database, channelId, change, at, guard);

    // Both users read use_count = 0 before either claim's batch runs (#185).
    const claims = await Promise.all([
      repository.claim("kanal-a", "increment", NOW, "user-a", 60, prepareChange, null, knownCommand),
      repository.claim("kanal-a", "increment", NOW, "user-b", 60, prepareChange, null, knownCommand),
    ]);

    expect(claims.map((claim) => claim?.claimed)).toEqual([true, true]);
    await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
      .resolves.toEqual({ value: 2 });
    await expect(database.prepare(
      "SELECT user_id, last_used_at FROM text_command_user_cooldowns ORDER BY user_id",
    ).all()).resolves.toMatchObject({ results: [
      { user_id: "user-a", last_used_at: NOW },
      { user_id: "user-b", last_used_at: NOW },
    ] });
  });

  it("denies the second user's variable claim under a global cooldown without granting it a per-user cooldown", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'score', 0, ?, ?)`,
    ).bind(NOW, NOW).run();
    await repository.create({
      channelId: "kanal-a", name: "increment", text: "Score {var.score}", kind: "text", cooldownSeconds: 60,
      userCooldownSeconds: 60, variableAction: { name: "score", operation: "add", amount: 1 }, now: NOW,
    }, ACTOR);
    const knownCommand = await repository.find("kanal-a", "increment");
    if (knownCommand === null) throw new Error("Command missing before the concurrent claims.");
    const prepareChange = (channelId: string, change: Parameters<typeof prepareChannelVariableChange>[2], at: string, guard: Parameters<typeof prepareChannelVariableChange>[4]) =>
      prepareChannelVariableChange(database as unknown as D1Database, channelId, change, at, guard);

    const claims = await Promise.all([
      repository.claim("kanal-a", "increment", NOW, "user-a", 60, prepareChange, null, knownCommand),
      repository.claim("kanal-a", "increment", NOW, "user-b", 60, prepareChange, null, knownCommand),
    ]);

    expect(claims.map((claim) => claim?.claimed)).toEqual([true, false]);
    expect(claims[1]).toMatchObject({ claimed: false, reason: "cooldown" });
    await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
      .resolves.toEqual({ value: 1 });
    await expect(database.prepare(
      "SELECT user_id FROM text_command_user_cooldowns ORDER BY user_id",
    ).all()).resolves.toMatchObject({ results: [{ user_id: "user-a" }] });
  });

  it("keeps the global claim unchanged when the same user is blocked", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);
    await repository.claim("kanal-a", "hallo", NOW, "user-a", 60);

    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:30.000Z", "user-a", 60))
      .resolves.toMatchObject({ claimed: false, reason: "user_cooldown" });
    await expect(database.prepare(
      "SELECT last_used_at FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ last_used_at: NOW });
  });

  it("uses one claim statement without a per-user cooldown and skips it for a missing actor", async () => {
    await insertChannel(database, "kanal-a");
    const statements: string[] = [];
    const batchSizes: number[] = [];
    const countedDb = {
      prepare(sql: string) {
        statements.push(sql);
        return database.prepare(sql);
      },
      batch(values: TestPreparedStatement[]) {
        batchSizes.push(values.length);
        return database.batch(values);
      },
    } as unknown as D1Database;
    const repository = createTextCommandRepository(countedDb, authorize);
    await repository.create({
      channelId: "kanal-a", name: "plain", text: "Antwort", kind: "text", cooldownSeconds: 0, now: NOW,
    }, ACTOR);
    statements.length = 0;
    await expect(repository.claim("kanal-a", "plain", NOW, "user-a", 0)).resolves.toMatchObject({ claimed: true });
    expect(statements.filter((sql) => sql.startsWith("UPDATE text_commands"))).toHaveLength(1);
    expect(batchSizes).toEqual([]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns").first())
      .resolves.toEqual({ count: 0 });

    await repository.create({
      channelId: "kanal-a", name: "optional", text: "Antwort", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);
    statements.length = 0;
    await expect(repository.claim("kanal-a", "optional", NOW, null, 60)).resolves.toMatchObject({ claimed: true });
    expect(statements.filter((sql) => sql.startsWith("UPDATE text_commands"))).toHaveLength(1);
    expect(batchSizes).toEqual([]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns").first())
      .resolves.toEqual({ count: 0 });

    await repository.create({
      channelId: "kanal-a", name: "limited", text: "Antwort", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);
    statements.length = 0;
    await expect(repository.claim("kanal-a", "limited", NOW, "user-a", 60)).resolves.toMatchObject({ claimed: true });
    expect(statements.filter((sql) => sql.startsWith("UPDATE text_commands"))).toHaveLength(1);
    expect(batchSizes).toEqual([2]);
    await expect(database.prepare(
      "SELECT user_id, last_used_at FROM text_command_user_cooldowns WHERE command_name = 'limited'",
    ).all()).resolves.toMatchObject({ results: [{ user_id: "user-a", last_used_at: NOW }] });
  });

  it("uses the current per-user cooldown value and prunes only rows older than 24 hours", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 0,
      userCooldownSeconds: 60, now: NOW,
    }, ACTOR);
    await repository.claim("kanal-a", "hallo", NOW, "user-a", 60);
    await database.prepare("UPDATE text_commands SET user_cooldown_seconds = 20 WHERE command_name = 'hallo'").run();
    await expect(repository.claim("kanal-a", "hallo", "2026-09-19T12:00:30.000Z", "user-a", 20))
      .resolves.toMatchObject({ claimed: true });

    await database.prepare(
      `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
       VALUES ('kanal-a', 'hallo', 'old', '2026-09-18T11:59:59.000Z'),
              ('kanal-a', 'hallo', 'recent', '2026-09-18T12:00:01.000Z')`,
    ).run();
    await purgeOldTextCommandUserCooldowns(database as unknown as D1Database, "2026-09-18T12:00:00.000Z");
    await expect(database.prepare(
      "SELECT user_id FROM text_command_user_cooldowns ORDER BY user_id",
    ).all()).resolves.toMatchObject({ results: [
      { user_id: "recent" }, { user_id: "user-a" },
    ] });
  });

  it("writes only to its own table", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR);
    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'text_%' ORDER BY name",
    ).all<{ name: string }>();

    expect(tables.results).toEqual([
      { name: "text_block_variants" },
      { name: "text_blocks" },
      { name: "text_command_aliases" },
      { name: "text_command_user_cooldowns" },
      { name: "text_commands" },
      { name: "text_library_categories" },
      { name: "text_library_settings" },
    ]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("distinguishes a denied delete from a missing row", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const allowed = createTextCommandRepository(database as unknown as D1Database, authorize);
    await allowed.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR);

    const verweigert = createTextCommandRepository(database as unknown as D1Database, authorizeModuleMutation);
    const foreignActor = { userId: "user-2", sessionId: "session-user-2" };
    const current = await allowed.find("kanal-a", "hallo");
    if (current === null) throw new Error("Created command was not found.");

    await expect(verweigert.create({
      channelId: "kanal-a", name: "neu", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, foreignActor)).resolves.toEqual({ ok: false, reason: "not_authorized" });
    await expect(verweigert.change({
      channelId: "kanal-a", name: "hallo", newName: "hallo", text: "Neu", kind: "text", enabled: true, cooldownSeconds: 10,
      aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", now: NOW,
    }, foreignActor)).resolves.toEqual({ ok: false, reason: "not_authorized" });

    await expect(verweigert.delete("kanal-a", "hallo", current.revision, foreignActor, NOW))
      .resolves.toEqual({ ok: false, reason: "not_authorized" });
    await expect(verweigert.delete("kanal-a", "fehlt", 1, ACTOR, NOW))
      .resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("guards content mutations with the managing SQL gate", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorizeModuleManagementMutation);

    await expect(repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: false, reason: "not_authorized" });

    await database.prepare("UPDATE channel_members SET role = 'manager' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    await expect(repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    await expect(repository.change({
      channelId: "kanal-a", name: "hallo", newName: "hallo", text: "Neu", kind: "text", enabled: true, cooldownSeconds: 10,
      aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: false, reason: "not_authorized" });
    await expect(repository.delete("kanal-a", "hallo", Date.parse(NOW), ACTOR, NOW))
      .resolves.toEqual({ ok: false, reason: "not_authorized" });
  });

  it("toggles only enabled and doesn't write back stale content values", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorizeModuleMutation);

    await expect(repository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(repository.change({
      channelId: "kanal-a",
      name: "hallo",
      newName: "hallo",
      text: "Veraltete Antwort",
      kind: "text",
      enabled: false,
      cooldownSeconds: 999,
      aliases: [],
      userCooldownSeconds: 0,
      streamCondition: "any",
      responseType: "say",
      now: "2026-09-19T12:01:00.000Z",
      onlyToggle: true,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(database.prepare(
      "SELECT response_text, kind, enabled, cooldown_seconds FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ response_text: "Antwort", kind: "text", enabled: 0, cooldown_seconds: 5 });
  });

  it("rejects stale update and delete preconditions, but not chat usage", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const baseRepository = createTextCommandRepository(database as unknown as D1Database, authorizeModuleMutation);
    await expect(baseRepository.create({
      channelId: "kanal-a", name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    const initialRevision = Date.parse(NOW);

    const updateDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "UPDATE text_commands SET response_text = 'Neu', minimum_level = 'moderator', updated_at = ?, revision = revision + 1 WHERE command_name = 'hallo'",
        ).bind("2026-09-19T12:00:30.000Z").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const updateRepository = createTextCommandRepository(
      updateDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(updateDb, ACTOR.userId, changedAt, entry),
    );
    await expect(updateRepository.change({
      channelId: "kanal-a", name: "hallo", newName: "hallo", text: "Antwort", kind: "text",
      enabled: false, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      now: "2026-09-19T12:01:00.000Z", onlyToggle: true,
    }, ACTOR)).resolves.toMatchObject({ ok: false, reason: "conflict", current: { revision: initialRevision + 1 } });
    await expect(database.prepare("SELECT response_text, minimum_level, enabled FROM text_commands WHERE command_name = 'hallo'").first())
      .resolves.toEqual({ response_text: "Neu", minimum_level: "moderator", enabled: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 0 });

    await expect(baseRepository.create({
      channelId: "kanal-a", name: "loeschen", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    const deleteDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "UPDATE text_commands SET response_text = 'Neu', minimum_level = 'vip', updated_at = ?, revision = revision + 1 WHERE command_name = 'loeschen'",
        ).bind("2026-09-19T12:00:30.000Z").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const deleteRepository = createTextCommandRepository(
      deleteDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(deleteDb, ACTOR.userId, changedAt, entry),
    );
    await expect(deleteRepository.delete("kanal-a", "loeschen", initialRevision, ACTOR, "2026-09-19T12:01:00.000Z"))
      .resolves.toMatchObject({ ok: false, reason: "conflict", current: { revision: initialRevision + 1, text: "Neu" } });
    await expect(database.prepare("SELECT response_text, minimum_level FROM text_commands WHERE command_name = 'loeschen'").first())
      .resolves.toEqual({ response_text: "Neu", minimum_level: "vip" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 0 });

    await expect(baseRepository.create({
      channelId: "kanal-a", name: "chat", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    const chatDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "UPDATE text_commands SET last_used_at = ?, updated_at = ? WHERE command_name = 'chat'",
        ).bind("2026-09-19T12:00:30.000Z", "2026-09-19T12:00:30.000Z").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const chatRepository = createTextCommandRepository(
      chatDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(chatDb, ACTOR.userId, changedAt, entry),
    );
    await expect(chatRepository.change({
      channelId: "kanal-a", name: "chat", newName: "chat", text: "Antwort", kind: "text",
      enabled: false, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      now: "2026-09-19T12:01:00.000Z", onlyToggle: true,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 1 });
    const audit = await database.prepare("SELECT before_json, after_json FROM audit_log").first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(audit?.before_json ?? "null") as unknown).toEqual({
      name: "chat", kind: "text", enabled: true, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5,
      aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say",
    });
    expect(JSON.parse(audit?.after_json ?? "null") as unknown).toEqual({
      name: "chat", kind: "text", enabled: false, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5,
      aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say",
    });
  });

  it("clears per-user cooldown rows on command delete and rename", async () => {
    await insertChannel(database, "kanal-a");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await repository.create({
      channelId: "kanal-a", name: "hello", text: "Hello", kind: "text", cooldownSeconds: 0,
      aliases: ["greeting"], userCooldownSeconds: 60, now: NOW,
    }, ACTOR);
    await database.prepare(
      `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
       VALUES ('kanal-a', 'hello', 'viewer-a', ?)`,
    ).bind(NOW).run();
    const loaded = await repository.find("kanal-a", "hello");
    if (loaded === null) throw new Error("Created command was not found.");

    await expect(repository.change({
      channelId: loaded.channelId,
      name: loaded.name,
      newName: "renamed",
      text: loaded.text,
      kind: loaded.kind,
      enabled: loaded.enabled,
      minimumTier: loaded.minimumTier,
      cooldownSeconds: loaded.cooldownSeconds,
      aliases: loaded.aliases,
      userCooldownSeconds: loaded.userCooldownSeconds,
      streamCondition: loaded.streamCondition,
      responseType: loaded.responseType,
      expectedRevision: loaded.revision,
      now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM text_command_user_cooldowns WHERE command_name = 'hello'",
    ).first()).resolves.toEqual({ count: 0 });
    await expect(repository.findByAlias("kanal-a", "greeting")).resolves.toMatchObject({ name: "renamed" });

    await database.prepare(
      `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
       VALUES ('kanal-a', 'renamed', 'viewer-a', ?)`,
    ).bind(NOW).run();
    const renamed = await repository.find("kanal-a", "renamed");
    if (renamed === null) throw new Error("Renamed command was not found.");
    await expect(repository.delete("kanal-a", "renamed", renamed.revision, ACTOR, NOW)).resolves.toEqual({ ok: true });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns").first())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_aliases").first())
      .resolves.toEqual({ count: 0 });
  });

  it("checks alias uniqueness and stream state inside their CAS updates", async () => {
    await insertChannel(database, "kanal-a");
    const baseRepository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await baseRepository.create({
      channelId: "kanal-a", name: "first", text: "Antwort", kind: "text", cooldownSeconds: 0,
      aliases: ["friendly"], now: NOW,
    }, ACTOR);
    const initialRevision = Date.parse(NOW);
    const competingDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          `INSERT INTO text_commands
            (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
             aliases_json, user_cooldown_seconds, stream_condition, response_type, created_at, updated_at)
           VALUES ('kanal-a', 'competitor', 'Other', 'text', 1, 'everyone', 0,
                   '["raced"]', 0, 'any', 'say', ?, ?)`,
        ).bind(NOW, NOW).run();
        await database.prepare(
          `INSERT INTO text_command_aliases (channel_id, alias, command_name)
           VALUES ('kanal-a', 'raced', 'competitor')`,
        ).run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const repository = createTextCommandRepository(
      competingDb,
      authorize,
      (entry, changedAt) => prepareModuleAudit(competingDb, ACTOR.userId, changedAt, entry),
    );

    await expect(repository.change({
      channelId: "kanal-a", name: "first", newName: "first", text: "Antwort", kind: "text", enabled: true,
      cooldownSeconds: 0, aliases: ["raced"], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", now: NOW,
    }, ACTOR)).resolves.toEqual({
      ok: false, reason: "alias_conflict", conflict: { field: "aliases", trigger: "raced", command: "competitor" },
    });
    await expect(database.prepare("SELECT aliases_json FROM text_commands WHERE command_name = 'first'").first())
      .resolves.toEqual({ aliases_json: '["friendly"]' });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first())
      .resolves.toEqual({ count: 0 });

    const streamDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare("UPDATE text_commands SET stream_condition = 'offline', revision = revision + 1 WHERE command_name = 'first'").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const streamRepository = createTextCommandRepository(
      streamDb,
      authorize,
      (entry, changedAt) => prepareModuleAudit(streamDb, ACTOR.userId, changedAt, entry),
    );
    await expect(streamRepository.change({
      channelId: "kanal-a", name: "first", newName: "first", text: "Andere Antwort", kind: "text", enabled: true,
      cooldownSeconds: 0, aliases: ["friendly"], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", now: NOW,
    }, ACTOR)).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
      current: { name: "first", streamCondition: "offline", revision: initialRevision + 1 },
    });
    await expect(database.prepare("SELECT stream_condition FROM text_commands WHERE command_name = 'first'").first())
      .resolves.toEqual({ stream_condition: "offline" });
  });

  it("keeps the winning save's aliases when a competing CAS loses", async () => {
    await insertChannel(database, "kanal-a");
    const baseRepository = createTextCommandRepository(database as unknown as D1Database, authorize);
    await baseRepository.create({
      channelId: "kanal-a", name: "first", text: "Original", kind: "text", cooldownSeconds: 0,
      aliases: ["original"], now: NOW,
    }, ACTOR);

    const competingDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.batch([
          database.prepare(
            `UPDATE text_commands SET aliases_json = '["winner"]', revision = revision + 1
              WHERE channel_id = 'kanal-a' AND command_name = 'first' AND revision = ?`,
            ).bind(Date.parse(NOW)),
          database.prepare(
            "DELETE FROM text_command_aliases WHERE channel_id = 'kanal-a' AND command_name = 'first'",
          ),
          database.prepare(
            `INSERT INTO text_command_aliases (channel_id, alias, command_name)
             VALUES ('kanal-a', 'winner', 'first')`,
          ),
        ]);
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const repository = createTextCommandRepository(
      competingDb,
      authorize,
      (entry, changedAt) => prepareModuleAudit(competingDb, ACTOR.userId, changedAt, entry),
    );

    await expect(repository.change({
      channelId: "kanal-a", name: "first", newName: "first", text: "Losing save", kind: "text", enabled: true,
      cooldownSeconds: 0, aliases: ["loser"], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      expectedRevision: Date.parse(NOW), now: NOW,
    }, ACTOR)).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
      current: { name: "first", aliases: ["winner"], revision: Date.parse(NOW) + 1 },
    });
    await expect(database.prepare(
      "SELECT aliases_json FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'first'",
    ).first()).resolves.toEqual({ aliases_json: '["winner"]' });
    await expect(database.prepare(
      "SELECT alias, command_name FROM text_command_aliases WHERE channel_id = 'kanal-a' ORDER BY alias",
    ).all()).resolves.toMatchObject({ results: [{ alias: "winner", command_name: "first" }] });
    await expect(baseRepository.findByAlias("kanal-a", "loser")).resolves.toBeNull();
  });

  it("allows lists without response text but requires it for text lines", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextCommandRepository(database as unknown as D1Database, authorize);

    await expect(repository.create({
      channelId: "kanal-a", name: "liste", text: "", kind: "list", cooldownSeconds: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(repository.list("kanal-a")).resolves.toEqual([expect.objectContaining({
      name: "liste", kind: "list", text: "", enabled: true,
    })]);
    expect(() => database.sqlite.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
       VALUES ('kanal-a', 'leer', '', 5, '{NOW}', '${NOW}')`,
    ).run()).toThrow();
  });

});
