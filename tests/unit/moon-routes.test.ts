import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { moonRoutes } from "../../src/modules/moon/routes";
import { readMoonSettings } from "../../src/modules/moon/adapters/d1";
import { calculateMoonState } from "../../src/modules/moon/domain";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { readChannelLocation } from "../../src/worker/db/channel-settings";
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
    context.set("channelLocation", (channelId) => readChannelLocation(database as unknown as D1Database, channelId));
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
  vi.useRealTimers();
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

describe("moon today route", () => {
  it("returns the current phase and next location-local moon events as ISO instants", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Berlin", 52.52, 13.405, "Europe/Berlin", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    const app = appFor(database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });
    const body = await response.json<{ status: string; phase?: string; illumination?: number; riseAt?: string | null; setAt?: string | null; nextRiseAt?: string | null }>();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.phase).toBe(calculateMoonState(Date.now()).phase);
    expect(body.illumination).toBeGreaterThanOrEqual(0);
    expect(body.illumination).toBeLessThanOrEqual(100);
    expect(body.riseAt === null || Number.isFinite(Date.parse(body.riseAt ?? ""))).toBe(true);
    expect(body.setAt === null || Number.isFinite(Date.parse(body.setAt ?? ""))).toBe(true);
    expect(body.nextRiseAt === null || Date.parse(body.nextRiseAt ?? "") > Date.now()).toBe(true);
  });

  it("returns a missing-location state for channel members without a saved place", async () => {
    const database = await createDatabase();
    const app = appFor(database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "location_missing" });
  });
});
