import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTextbefehlRepository } from "../../src/modules/textbefehle/adapters/d1";
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
      channelId: "kanal-a", name: "hallo", text: "A", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toBe(true);
    await expect(repository.anlegen({
      channelId: "kanal-b", name: "hallo", text: "B", cooldownSekunden: 5, now: NOW,
    }, ACTOR)).resolves.toBe(true);

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
      channelId: "kanal-a", name: "hallo", text: "Antwort", cooldownSekunden: 5, now: NOW,
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
      channelId: "kanal-a", name: "hallo", text: "Antwort", cooldownSekunden: 5, now: NOW,
    }, ACTOR);
    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'textbefehle_%' ORDER BY name",
    ).all<{ name: string }>();

    expect(tables.results).toEqual([{ name: "textbefehle_commands" }]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });
});
