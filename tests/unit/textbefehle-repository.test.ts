import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTextbefehlRepository } from "../../src/modules/textbefehle/adapters/d1";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

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
    await insertMember(database, "kanal-a", "user-1", "bediener");
    await insertMember(database, "kanal-b", "user-1", "bediener");
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
    await insertMember(database, "kanal-a", "user-1", "bediener");
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
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);
    await repository.anlegen({
      channelId: "kanal-a", name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5, now: NOW,
    }, ACTOR);
    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'textbefehle_%' ORDER BY name",
    ).all<{ name: string }>();

    expect(tables.results).toEqual([{ name: "textbefehle_commands" }]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("unterscheidet eine abgelehnte Löschung von einer fehlenden Zeile", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
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
      channelId: "kanal-a", name: "hallo", neuerName: "hallo", text: "Neu", enabled: true, cooldownSekunden: 10, now: NOW,
    }, fremderAkteur)).resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });

    await expect(verweigert.loeschen("kanal-a", "hallo", fremderAkteur, NOW))
      .resolves.toEqual({ ok: false, grund: "nicht_berechtigt" });
    await expect(verweigert.loeschen("kanal-a", "fehlt", ACTOR, NOW))
      .resolves.toEqual({ ok: false, grund: "nicht_gefunden" });
  });

  it("erlaubt Listen ohne Antworttext, verlangt ihn aber für Textzeilen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const repository = createTextbefehlRepository(database as unknown as D1Database, authorize);

    await expect(repository.anlegen({
      channelId: "kanal-a", name: "liste", text: "", art: "liste", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toEqual({ ok: true });
    await expect(repository.auflisten("kanal-a")).resolves.toEqual([expect.objectContaining({
      name: "liste", art: "liste", text: "", enabled: true,
    })]);
    expect(() => database.sqlite.prepare(
      `INSERT INTO textbefehle_commands
        (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
       VALUES ('kanal-a', 'leer', '', 5, '${NOW}', '${NOW}')`,
    ).run()).toThrow();
  });

  it("übernimmt für bestehende Zeilen Art text und enabled 1", () => {
    const legacy = new TestD1Database(20);
    try {
      legacy.sqlite.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('kanal-a', 'kanal-a', 'Kanal A', '${NOW}', '${NOW}')`,
      ).run();
      legacy.sqlite.prepare(
        `INSERT INTO textbefehle_commands
          (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
         VALUES ('kanal-a', 'alt', 'Antwort', 5, '${NOW}', '${NOW}')`,
      ).run();
      legacy.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0020_textbefehle_art_enabled.sql"), "utf8"));

      expect(legacy.sqlite.prepare(
        "SELECT art, enabled FROM textbefehle_commands WHERE command_name = 'alt'",
      ).get()).toEqual({ art: "text", enabled: 1 });
    } finally {
      legacy.close();
    }
  });
});
