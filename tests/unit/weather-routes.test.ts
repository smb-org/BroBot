import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { weatherRoutes } from "../../src/modules/weather/routes";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { readChannelLocation } from "../../src/worker/db/channel-settings";
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

const setLocation = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
  ).bind("Berlin", 52.52, 13.405, "Europe/Berlin", CHANNEL_ID).run();
};

const appFor = (database: TestD1Database, role: "manager" | "operator" = "manager", events: string[] = []) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", role);
    context.set("actor", { userId: ACTOR_ID, sessionId: "weather-settings-session" });
    context.set("channelLocation", (channelId) => readChannelLocation(database as unknown as D1Database, channelId));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("current weather route", () => {
  it("returns the cached observation and expiry for a saved location", async () => {
    const database = await createDatabase();
    await setLocation(database);
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    const weather = {
      temperatureC: 18.4,
      feelsLikeC: 17.8,
      condition: "partly_cloudy",
      isDay: true,
      windSpeedMps: 3.3,
      precipitationMm: 0,
      humidityPercent: 64,
      observedAt: "2026-10-21T11:30:00.000Z",
      shortForecast: "rain",
    };
    await database.prepare(
      "INSERT INTO weather_cache (provider, location_key, latitude, longitude, payload_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("met_norway", "52.5200,13.4050", 52.52, 13.405, JSON.stringify(weather), "2026-10-21T12:10:00.000Z", "2026-10-21T11:00:00.000Z").run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const app = appFor(database, "operator");

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      location: { name: "Berlin", timeZone: "Europe/Berlin" },
      weather,
      expiresAt: "2026-10-21T12:10:00.000Z",
      showFahrenheit: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a missing saved location without requesting provider data", async () => {
    const database = await createDatabase();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const app = appFor(database, "operator");

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "location_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a typed provider error while keeping the current values route readable", async () => {
    const database = await createDatabase();
    await setLocation(database);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.reject(new Error("upstream detail must not leak"))));
    const app = appFor(database, "operator");

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "provider_error", reason: "upstream_unavailable" });
  });

  it("caches provider failures for the location cooldown", async () => {
    const database = await createDatabase();
    await setLocation(database);
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal("fetch", fetcher);
    const app = appFor(database, "operator");
    const request = () => app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    await request();
    await request();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After when extending a provider failure cooldown", async () => {
    const database = await createDatabase();
    await setLocation(database);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00.000Z"));
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, {
      status: 503,
      headers: { "Retry-After": "120" },
    })));
    vi.stubGlobal("fetch", fetcher);
    const app = appFor(database, "operator");
    const request = () => app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    await request();
    now.mockReturnValue(Date.parse("2026-10-21T12:01:00.000Z"));
    await request();
    expect(fetcher).toHaveBeenCalledTimes(1);

    now.mockReturnValue(Date.parse("2026-10-21T12:02:01.000Z"));
    await request();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cache misses into one provider request", async () => {
    const database = await createDatabase();
    await setLocation(database);
    let release!: (response: Response) => void;
    const waitingResponse = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(() => waitingResponse);
    vi.stubGlobal("fetch", fetcher);
    const app = appFor(database, "operator");
    const request = () => app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/current`), {
      DB: database as unknown as D1Database,
    });

    const first = request();
    const second = request();
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    release(new Response(null, { status: 503 }));
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
