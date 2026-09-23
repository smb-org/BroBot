import { afterEach, describe, expect, it } from "vitest";

import type { BotModule, ModuleEvent } from "../../src/modules/contract";
import { adsModule } from "../../src/modules/ads";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("ad setting defaults", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("accepts stored JSON without prewarning fields, filling in defaults", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatic":"auto","manual":"manuell"}')`,
    ).run();

    let geleseneEinstellungen: unknown;
    const probe: BotModule<typeof adsModule.settingsSchema> = {
      ...adsModule,
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
      automatic: "auto",
      manual: "manuell",
      prewarning: true,
      leadSeconds: 60,
      prewarningText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
    });
  });
});
