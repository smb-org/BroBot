import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTextbefehlRepository } from "../../src/modules/textbefehle/adapters/d1";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const ACTOR = { userId: "user-1", sessionId: "session-user-1" };
const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });

describe("Textbefehle-D1-Adapter", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("trennt gleichnamige Befehle nach Kanal", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertMember(database, "kanal-b", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);

    await expect(repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "A", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(repository.anlegen({
      channelId: "kanal-b", name: "hallo", text: "B", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(repository.auflisten("kanal-a")).resolves.toEqual([expect.objectContaining({
      channelId: "kanal-a", name: "hallo", text: "A",
    })]);
    await expect(repository.auflisten("kanal-b")).resolves.toEqual([expect.objectContaining({
      channelId: "kanal-b", name: "hallo", text: "B",
    })]);
  });

  it("beansprucht einen Befehl nur einmal innerhalb seiner Abkühlzeit", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);
    await repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR);

    await expect(repository.beanspruchen("kanal-a", "hallo", NOW)).resolves.toMatchObject({ beansprucht: true });
    await expect(repository.beanspruchen("kanal-a", "hallo", "2026-09-19T12:00:01.000Z"))
      .resolves.toMatchObject({ beansprucht: false, befehl: { zuletztVerwendetAt: NOW } });
    await expect(repository.beanspruchen("kanal-a", "hallo", "2026-09-19T12:00:05.000Z"))
      .resolves.toMatchObject({ beansprucht: true });
  });

  it("schreibt nur in die eigene Tabelle", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);
    await repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR);
    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'text_%' ORDER BY name",
    ).all<{ name: string }>();

    expect(tables.results).toEqual([{ name: "text_commands" }]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("unterscheidet eine abgelehnte Löschung von einer fehlenden Zeile", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const erlaubt = createTextbefehlRepository(database as unknown as D1Database, authorize);
    await erlaubt.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR);

    const verweigert = createTextbefehlRepository(database as unknown as D1Database, authorizeModuleMutation);
    const fremderAkteur = { userId: "user-2", sessionId: "session-user-2" };

    await expect(verweigert.anlegen({
      channelId: "kanal-a", name: "neu", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, fremderAkteur)).resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });
    await expect(verweigert.aendern({
      channelId: "kanal-a", name: "hallo", neuerName: "hallo", text: "Neu", art: "text", enabled: true, cooldownSekunden: 10, now: NOW,
    }, fremderAkteur)).resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });

    await expect(verweigert.loeschen("kanal-a", "hallo", fremderAkteur, NOW))
      .resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });
    await expect(verweigert.loeschen("kanal-a", "fehlt", ACTOR, NOW))
      .resolves.toEqual({ ok: false, grund: "nicht_gefunden" });
  });

  it("sichert Inhaltsmutationen mit der verwaltenden SQL-Schwelle ab", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorizeModuleManagementMutation);

    await expect(repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });

    await database.prepare("UPDATE channel_members SET role = 'manager' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    await expect(repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    await expect(repository.aendern({
      channelId: "kanal-a", name: "hallo", neuerName: "hallo", text: "Neu", art: "text", enabled: true, cooldownSekunden: 10, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });
    await expect(repository.loeschen("kanal-a", "hallo", ACTOR, NOW))
      .resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });
  });

  it("schaltet nur enabled und schreibt keine veralteten Inhaltswerte zurück", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorizeModuleMutation);

    await expect(repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(repository.aendern({
      channelId: "kanal-a",
      name: "hallo",
      neuerName: "hallo",
      text: "Veraltete Antwort",
      art: "text",
      enabled: false,
      cooldownSekunden: 999,
      now: "2026-09-19T12:01:00.000Z",
      nurSchalter: true,
    }, ACTOR)).resolves.toEqual({ ok: true });

    await expect(database.prepare(
      "SELECT response_text, kind, enabled, cooldown_seconds FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ response_text: "Antwort", kind: "text", enabled: 0, cooldown_seconds: 5 });
  });

  it("verwirft veraltete Update- und Lösch-Vorzustände, aber nicht Chatnutzung", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const baseRepository = createTextbefehlRepository(database as unknown as D1Database, authorizeModuleMutation);
    await expect(baseRepository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });

    const updateDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "UPDATE text_commands SET response_text = 'Neu', minimum_level = 'moderator', updated_at = ? WHERE command_name = 'hallo'",
        ).bind("2026-09-19T12:00:30.000Z").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const updateRepository = createTextbefehlRepository(
      updateDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(updateDb, ACTOR.userId, changedAt, entry),
    );
    await expect(updateRepository.aendern({
      channelId: "kanal-a", name: "hallo", neuerName: "hallo", text: "Antwort", art: "text",
      enabled: false, cooldownSekunden: 5, now: "2026-09-19T12:01:00.000Z", nurSchalter: true,
    }, ACTOR)).resolves.toEqual({ ok: false, grund: "konflikt" });
    await expect(database.prepare("SELECT response_text, minimum_level, enabled FROM text_commands WHERE command_name = 'hallo'").first())
      .resolves.toEqual({ response_text: "Neu", minimum_level: "moderator", enabled: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 0 });

    await expect(baseRepository.anlegen({
      channelId: "kanal-a", name: "loeschen", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    const deleteDb = {
      prepare: database.prepare.bind(database),
      batch: async (statements: TestPreparedStatement[]) => {
        await database.prepare(
          "UPDATE text_commands SET response_text = 'Neu', minimum_level = 'vip', updated_at = ? WHERE command_name = 'loeschen'",
        ).bind("2026-09-19T12:00:30.000Z").run();
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const deleteRepository = createTextbefehlRepository(
      deleteDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(deleteDb, ACTOR.userId, changedAt, entry),
    );
    await expect(deleteRepository.loeschen("kanal-a", "loeschen", ACTOR, "2026-09-19T12:01:00.000Z"))
      .resolves.toEqual({ ok: false, grund: "konflikt" });
    await expect(database.prepare("SELECT response_text, minimum_level FROM text_commands WHERE command_name = 'loeschen'").first())
      .resolves.toEqual({ response_text: "Neu", minimum_level: "vip" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 0 });

    await expect(baseRepository.anlegen({
      channelId: "kanal-a", name: "chat", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
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
    const chatRepository = createTextbefehlRepository(
      chatDb,
      authorizeModuleMutation,
      (entry, changedAt) => prepareModuleAudit(chatDb, ACTOR.userId, changedAt, entry),
    );
    await expect(chatRepository.aendern({
      channelId: "kanal-a", name: "chat", neuerName: "chat", text: "Antwort", art: "text",
      enabled: false, cooldownSekunden: 5, now: "2026-09-19T12:01:00.000Z", nurSchalter: true,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual({ count: 1 });
    const audit = await database.prepare("SELECT before_json, after_json FROM audit_log").first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(audit?.before_json ?? "null") as unknown).toEqual({
      name: "chat", art: "text", enabled: true, mindeststufe: "everyone", text: "Antwort", cooldownSekunden: 5,
    });
    expect(JSON.parse(audit?.after_json ?? "null") as unknown).toEqual({
      name: "chat", art: "text", enabled: false, mindeststufe: "everyone", text: "Antwort", cooldownSekunden: 5,
    });
  });

  it("erlaubt Listen ohne Antworttext, verlangt ihn aber für Textzeilen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);

    await expect(repository.anlegen({
      channelId: "kanal-a", name: "liste", text: "", art: "list", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(repository.auflisten("kanal-a")).resolves.toEqual([expect.objectContaining({
      name: "liste", art: "list", text: "", enabled: true,
    })]);
    expect(() => database.sqlite.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
       VALUES ('kanal-a', 'leer', '', 5, '{NOW}', '${NOW}')`,
    ).run()).toThrow();
  });

});
