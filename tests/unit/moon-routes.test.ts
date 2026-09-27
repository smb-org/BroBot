import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { moonRoutes } from "../../src/modules/moon/routes";
import { readMoonSettings } from "../../src/modules/moon/adapters/d1";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "moon-settings-channel";
const ACTOR_ID = "moon-settings-actor";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const appFor = (database: TestD1Database, hostEvents: string[] = []): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "moon-settings-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(database as unknown as D1Database, ACTOR_ID, changedAt, entry));
    context.set("publishOverlayHostEvent", (channelId, event) => {
      hostEvents.push(`${channelId}:${event}`);
      return Promise.resolve();
    });
    await next();
  });
  app.route("/channels/:channelId", moonRoutes);
  return app;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("moon unavailable text settings", () => {
  it("uses bilingual defaults and saves the module-owned text through its reserved-safe route", async () => {
    const database = await createDatabase();
    const hostEvents: string[] = [];
    const app = appFor(database, hostEvents);
    const environment = { DB: database as unknown as D1Database };
    const getResponse = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/unavailable-texts`), environment);
    expect(await getResponse.json()).toEqual({
      revision: 1,
      errorTexts: {
        de: "Monddaten sind derzeit nicht verfügbar.",
        en: "Moon data is currently unavailable.",
      },
    });

    const errorTexts = { de: "Monddaten fehlen.", en: "Moon data is missing." };
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/unavailable-texts`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, errorTexts }),
    }), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ errorTexts, revision: 2 });
    expect(await readMoonSettings(database as unknown as D1Database, CHANNEL_ID)).toEqual({ errorTexts, revision: 2 });
    expect(hostEvents).toEqual([`${CHANNEL_ID}:template.data.changed`]);
  });
});
