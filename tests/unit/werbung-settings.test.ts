import { afterEach, describe, expect, it } from "vitest";

import type { BotModule, ModuleEvent } from "../../src/modules/contract";
import { werbungModul } from "../../src/modules/werbung";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("Werbung-Einstellungsdefaults", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("nimmt altes gespeichertes JSON ohne Vorwarnungsfelder mit Defaults an", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatisch":"auto","manuell":"manuell"}')`,
    ).run();

    let geleseneEinstellungen: unknown;
    const probe: BotModule = {
      ...werbungModul,
      handleEvent: (event: ModuleEvent) => {
        geleseneEinstellungen = event.settings;
        return { actions: [], diagnostics: [] };
      },
    };

    await dispatchEventSubNotification(
      {
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
      },
      {
        channelId: "kanal-a",
        subscriptionType: "stream.online",
        triggerId: "stream-1",
        payload: {},
        receivedAt: "2026-09-21T11:00:00.000Z",
      },
      fetch,
      [probe],
    );

    expect(geleseneEinstellungen).toEqual({
      automatisch: "auto",
      manuell: "manuell",
      vorwarnung: true,
      vorlaufSekunden: 60,
      vorwarnungText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
    });
  });
});
