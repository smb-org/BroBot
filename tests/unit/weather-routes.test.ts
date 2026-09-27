import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { weatherRoutes } from "../../src/modules/weather/routes";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "weather-settings-channel";
const ACTOR_ID = "weather-settings-actor";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const appFor = (database: TestD1Database, role: "manager" | "operator" = "manager", events: string[] = []) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", role);
    context.set("actor", { userId: ACTOR_ID, sessionId: "weather-settings-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(database as unknown as D1Database, ACTOR_ID, changedAt, entry));
    context.set("publishOverlayHostEvent", (channelId, event) => {
      events.push(`${channelId}:${event}`);
      return Promise.resolve();
    });
    await next();
  });
  app.route("/channels/:channelId", weatherRoutes);
  return app;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("weather settings", () => {
  it("defaults to MET Norway and saves the provider choice and unit preference per channel", async () => {
    const database = await createDatabase();
    const events: string[] = [];
    const app = appFor(database, "manager", events);
    const environment = { DB: database as unknown as D1Database };
    const initial = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/provider-settings`), environment);

    expect(await initial.json()).toEqual({
      provider: "met_norway",
      showFahrenheit: false,
      errorTexts: {
        de: "Wetterdaten sind derzeit nicht verfügbar.",
        en: "Weather data is currently unavailable.",
      },
      revision: 1,
    });

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/provider-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        provider: "open_meteo",
        showFahrenheit: true,
        errorTexts: { de: "Wetterdienst fehlt.", en: "Weather service is unavailable." },
      }),
    }), environment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "open_meteo",
      showFahrenheit: true,
      errorTexts: { de: "Wetterdienst fehlt.", en: "Weather service is unavailable." },
      revision: 2,
    });
    expect(events).toEqual([`${CHANNEL_ID}:template.data.changed`]);
  });

  it("rejects stale revisions and operator writes", async () => {
    const database = await createDatabase();
    const environment = { DB: database as unknown as D1Database };
    const app = appFor(database);
    const stale = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/provider-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 0, provider: "met_norway", showFahrenheit: false, errorTexts: { de: "", en: "" } }),
    }), environment);
    expect(stale.status).toBe(400);

    const operatorApp = appFor(database, "operator");
    const denied = await operatorApp.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/provider-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, provider: "met_norway", showFahrenheit: false, errorTexts: { de: "", en: "" } }),
    }), environment);
    expect(denied.status).toBe(403);
  });
});
