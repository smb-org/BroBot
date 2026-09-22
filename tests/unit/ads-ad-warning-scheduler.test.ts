import { afterEach, describe, expect, it, vi } from "vitest";

import { processAdPrewarning, type AdScheduler } from "../../src/worker/ad-prewarning";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

/**
 * Läuft die Vorwarnung im Durable Object, darf sie das Kanalobjekt niemals über
 * dessen eigene Bindung ansprechen. Das wäre ein Selbstaufruf: Das Input-Gate
 * stellt die Anfrage hinter den laufenden Alarm, der auf sie wartet.
 *
 * Diese Tests halten die Regel fest, indem die Bindung beim Zugriff wirft und
 * `idFromName` mitgezählt wird — sie fallen, sobald jemand wieder einen Stub
 * baut, statt den übergebenen Planer zu benutzen.
 */
describe("Werbe-Vorwarnung im Kanalobjekt", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  const idFromName = vi.fn();

  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "secret",
    CHANNEL: {
      idFromName,
      get: () => { throw new Error("Selbstaufruf auf das eigene Kanalobjekt"); },
    } as unknown as Env["CHANNEL"],
  });

  const keinNetz: typeof fetch = () => { throw new Error("Es darf kein Twitch-Aufruf entstehen."); };

  const schedulerStub = (): AdScheduler & { readonly geplant: number[]; geloescht: () => number } => {
    const geplant: number[] = [];
    let geloescht = 0;
    return {
      geplant,
      geloescht: () => geloescht,
      schedule: (dueAtMs: number) => { geplant.push(dueAtMs); return Promise.resolve(); },
      clear: () => { geloescht += 1; return Promise.resolve(); },
    };
  };

  it("löscht den Wecker über den übergebenen Planer, nicht über die Kanalbindung", async () => {
    database = new TestD1Database();
    idFromName.mockClear();
    await insertChannel(database, "kanal-a");
    // Der Broadcaster hat channel:read:ads nicht erteilt: genau der Pfad,
    // der den Wecker löschen will.
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatic":"a","manual":"m","prewarning":true,"leadSeconds":60,"prewarningText":"gleich {seconds}"}')`,
    ).run();

    const scheduler = schedulerStub();
    await processAdPrewarning(
      environment(),
      "kanal-a",
      Date.parse("2026-09-21T12:00:00.000Z"),
      "ausloeser-1",
      "2026-09-21T11:59:00.000Z",
      keinNetz,
      scheduler,
    );

    expect(idFromName).not.toHaveBeenCalled();
    expect(scheduler.geloescht()).toBe(1);

    const zeilen = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a' ORDER BY rowid",
    ).all<{ code: string }>();
    expect(zeilen.results.map((zeile) => zeile.code)).toEqual(["ads.vorwarnung.scope_fehlt"]);
  });

  it("rührt die Kanalbindung auch dann nicht an, wenn das Modul abgeschaltet ist", async () => {
    database = new TestD1Database();
    idFromName.mockClear();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 0, '{}')",
    ).run();

    await processAdPrewarning(
      environment(),
      "kanal-a",
      Date.parse("2026-09-21T12:00:00.000Z"),
      "ausloeser-2",
      "2026-09-21T11:59:00.000Z",
      keinNetz,
      schedulerStub(),
    );

    expect(idFromName).not.toHaveBeenCalled();
  });
});
