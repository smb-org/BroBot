import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleTemplateValueContext } from "../../src/modules/contract";
import { PROVIDER_JSON_MAX_BYTES, readBoundedJsonResponse } from "../../src/modules/contract";
import { currencyModule, parseCurrencyAmount } from "../../src/modules/currency";
import { exchangeRate } from "../../src/modules/currency/adapters/rates";
import { weatherModule } from "../../src/modules/weather";
import { fetchCachedWeather, readWeatherCache } from "../../src/modules/weather/adapters/cache";
import { metNorwayWeather, openMeteoWeather } from "../../src/modules/weather/adapters/providers";
import { geocodeWeatherPlace, validWeatherPlaceName } from "../../src/modules/weather/adapters/geocoding";
import { readWeatherSettings } from "../../src/modules/weather/adapters/d1";
import { weatherConditionFromMetSymbol, weatherConditionFromWmoCode } from "../../src/modules/weather/domain";
import { invalidTemplateParameters } from "../../src/template";
import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";
import type { ModuleEvent } from "../../src/modules/contract";
import { TestD1Database } from "./test-d1";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const event: ModuleEvent = {
  channelId: "weather-test-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "weather-test-trigger",
  payload: {},
  settings: {},
  receivedAt: new Date(NOW).toISOString(),
  actor: { userId: "viewer-1", login: "viewer", role: null },
  chatStatus: ["viewer"],
};

const metFixture = {
  properties: {
    timeseries: [{
      time: "2026-09-27T12:00:00Z",
      data: {
        instant: { details: { air_temperature: 12.3, wind_speed: 2.4, relative_humidity: 75 } },
        next_1_hours: { summary: { symbol_code: "lightrain" }, details: { precipitation_amount: 0.4 } },
      },
    }],
  },
};

const openMeteoFixture = {
  current: {
    time: "2026-09-27T12:00",
    temperature_2m: 12.3,
    apparent_temperature: 11.5,
    relative_humidity_2m: 75,
    precipitation: 0.2,
    weather_code: 61,
    wind_speed_10m: 2.4,
    is_day: 1,
  },
  hourly: {
    time: ["2026-09-27T12:00", "2026-09-27T13:00"],
    precipitation: [0.2, 0.6],
    weather_code: [61, 63],
  },
};

const response = (payload: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "Content-Type": "application/json", ...headers },
});

const requestUrl = (input: RequestInfo | URL | undefined): string => {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const contextFor = (DB: D1Database, overrides: Partial<ModuleTemplateValueContext> = {}): ModuleTemplateValueContext => ({
  DB,
  channelId: event.channelId,
  templateContext: "chat_command",
  knownTemplateVariableNames: new Set(),
  chatStatus: event.chatStatus,
  mode: "chat",
  channelLanguage: () => Promise.resolve("de"),
  streamState: () => Promise.resolve("offline"),
  channelInfo: () => Promise.resolve(null),
  channelTimeZone: () => Promise.resolve("Europe/Berlin"),
  channelLocation: () => Promise.resolve({ name: "Berlin", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }),
  renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
  addDiagnostic: () => undefined,
  now: NOW,
  resolveTemplateConditions: () => Promise.resolve({}),
  ...overrides,
});

const resolverSources = (
  DB: D1Database,
  providers: NonNullable<TemplateResolverSources["templateValueProviders"]>,
): TemplateResolverSources => ({
  DB,
  channelInfo: () => Promise.resolve(null),
  channelGameId: () => Promise.resolve(null),
  channelTimeZone: () => Promise.resolve("Europe/Berlin"),
  channelLocation: () => Promise.resolve({ name: "Berlin", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }),
  templateValueProviders: providers,
  streamState: () => Promise.resolve("offline"),
  channelDetails: () => Promise.resolve(null),
  streamDetails: () => Promise.resolve(null),
  followedAt: () => Promise.resolve(null),
  followerTotal: () => Promise.resolve(null),
  chattersTotal: () => Promise.resolve(null),
  userCreatedAt: () => Promise.resolve(null),
  channelLanguage: () => Promise.resolve("de"),
  readChannelVariables: () => Promise.resolve({}),
  now: () => NOW,
});

afterEach(() => vi.unstubAllGlobals());

describe("weather data providers", () => {
  it("normalizes equivalent MET Norway and Open-Meteo fixtures to the shared condition set", async () => {
    const metFetcher = vi.fn<typeof fetch>().mockResolvedValue(response(metFixture, { Expires: new Date(NOW + 60_000).toUTCString() }));
    const openFetcher = vi.fn<typeof fetch>().mockResolvedValue(response(openMeteoFixture, { "Cache-Control": "max-age=1200" }));
    const input = { coordinates: { latitude: 52.52004, longitude: 13.40504 }, validators: { etag: null, lastModified: null }, now: NOW };

    const met = await metNorwayWeather({ ...input, fetcher: metFetcher });
    const open = await openMeteoWeather({ ...input, fetcher: openFetcher });

    expect(met.weather).toMatchObject({ condition: "rain", temperatureC: 12.3, windSpeedMps: 2.4, humidityPercent: 75 });
    expect(open.weather).toMatchObject({ condition: "rain", temperatureC: 12.3, feelsLikeC: 11.5, precipitationMm: 0.6 });
    expect(weatherConditionFromMetSymbol("clearsky_night")).toBe("clear");
    expect([95, 96, 97, 99].map(weatherConditionFromWmoCode)).toEqual([
      "thunderstorm", "thunderstorm", "thunderstorm", "thunderstorm",
    ]);
    const [, init] = metFetcher.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("User-Agent")).toBe("BroBot/0.1.0 (+https://github.com/smb-org/BroBot)");
    expect(requestUrl(metFetcher.mock.calls[0]?.[0])).toContain("lat=52.5200");
  });

  it("caches by provider and rounded coordinates and honors provider expiry", async () => {
    const database = new TestD1Database();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(metFixture, { Expires: new Date(NOW + 45_000).toUTCString() }));
      const first = await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52004, 13.40504, NOW, fetcher);
      const second = await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52003, 13.40503, NOW + 10_000, fetcher);
      const cached = await readWeatherCache(database as unknown as D1Database, "met_norway", 52.52, 13.405, NOW + 10_000);

      expect(fetcher).toHaveBeenCalledOnce();
      expect(second.weather).toEqual(first.weather);
      expect(first.expiresAt).toBeLessThanOrEqual(NOW + 15 * 60_000);
      expect(cached?.coordinates.key).toBe("52.5200,13.4050");
    } finally {
      database.close();
    }
  });

  it("keeps MET Norway data through Expires and extends it after conditional revalidation", async () => {
    const database = new TestD1Database();
    const expiresAt = NOW + 60 * 60_000;
    const revalidatedExpiresAt = NOW + 90 * 60_000;
    const lastModified = new Date(NOW - 60 * 60_000).toUTCString();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(metFixture, {
        Expires: new Date(expiresAt).toUTCString(),
        "Last-Modified": lastModified,
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { Expires: new Date(revalidatedExpiresAt).toUTCString() },
      }));
    try {
      const first = await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52, 13.405, NOW, fetcher);
      const stillFresh = await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52, 13.405, NOW + 30 * 60_000, fetcher);

      expect(first.expiresAt).toBe(expiresAt);
      expect(stillFresh.expiresAt).toBe(expiresAt);
      expect(fetcher).toHaveBeenCalledOnce();

      const revalidated = await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52, 13.405, expiresAt + 1_000, fetcher);
      const [, requestInit] = fetcher.mock.calls[1] ?? [];
      expect(new Headers(requestInit?.headers).get("If-Modified-Since")).toBe(lastModified);
      expect(revalidated.weather).toEqual(first.weather);
      expect(revalidated.expiresAt).toBe(revalidatedExpiresAt);

      await fetchCachedWeather(database as unknown as D1Database, "met_norway", 52.52, 13.405, revalidatedExpiresAt - 1_000, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("rejects provider JSON that exceeds the declared or streamed byte cap", async () => {
    expect(PROVIDER_JSON_MAX_BYTES).toBe(256 * 1024);
    await expect(readBoundedJsonResponse(new Response("{}", {
      headers: { "Content-Length": "9" },
    }), 8)).rejects.toThrow("size limit");
    await expect(readBoundedJsonResponse(new Response("123456789"), 8)).rejects.toThrow("size limit");
  });

  it("geocodes multi-word places and rejects invalid or unbounded names", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ results: [{ name: "New York", country: "United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" }] }));

    await expect(geocodeWeatherPlace("New York", "en", fetcher)).resolves.toEqual({
      kind: "found",
      location: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timeZone: "America/New_York" },
    });
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toContain("name=New+York");
    expect(validWeatherPlaceName("San Francisco")).toBe(true);
    expect(validWeatherPlaceName("https://example.com")).toBe(false);
    expect(validWeatherPlaceName("x".repeat(101))).toBe(false);
  });

  it("uses the channel location by default, geocodes command overrides, and records provider attribution", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return Promise.resolve(response({ results: [{ name: "Tokyo", country: "Japan", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" }] }));
      }
      return Promise.resolve(response(metFixture, { Expires: new Date(NOW + 60_000).toUTCString() }));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const attributions: string[] = [];
      const context = contextFor(database as unknown as D1Database, {
        commandInput: { commandName: "weather", arguments: "Tokyo" },
        addTemplateValueAttribution: (value) => attributions.push(value),
      });
      const values = await weatherModule.resolveTemplateValues?.(["weather.place", "weather.condition", "weather.temp"], context);

      expect(values).toMatchObject({ "weather.place": "Tokyo, Japan", "weather.temp": "12,3 °C" });
      expect(values?.["weather.condition"]).toContain("Regen");
      expect(attributions).toEqual(["MET Norway"]);
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("name=Tokyo"))).toBe(true);
    } finally {
      database.close();
    }
  });

  it("returns a distinct unknown-place message without adding source attribution", async () => {
    const database = new TestD1Database();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response({ results: [] })));
    try {
      const attributions: string[] = [];
      const values = await weatherModule.resolveTemplateValues?.(["weather.temp", "weather.place"], contextFor(database as unknown as D1Database, {
        commandInput: { commandName: "weather", arguments: "Atlantis" },
        addTemplateValueAttribution: (value) => attributions.push(value),
      }));

      expect(values).toEqual({ "weather.temp": "Ort nicht gefunden.", "weather.place": "Ort nicht gefunden." });
      expect(attributions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("attributes condition-only text-block selections", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(metFixture));
    vi.stubGlobal("fetch", fetcher);
    try {
      const attributions: string[] = [];
      const conditions = await weatherModule.resolveTemplateConditions?.(["weather.condition"], {
        DB: database as unknown as D1Database,
        channelId: event.channelId,
        channelLocation: () => Promise.resolve({ name: "Berlin", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }),
        channelTimeZone: () => Promise.resolve("Europe/Berlin"),
        now: NOW,
        addTemplateValueAttribution: (value) => attributions.push(value),
      });

      expect(conditions).toEqual({ "weather.condition": "rain" });
      expect(attributions).toEqual(["MET Norway"]);
    } finally {
      database.close();
    }
  });
});

describe("currency conversion", () => {
  it("flags a conversion token without a required pair as an invalid template parameter", () => {
    const declaration = currencyModule.templateVariableCatalog?.[0];
    if (declaration === undefined) throw new Error("Currency variable catalog is missing.");

    expect(invalidTemplateParameters("{currency.convert}", [declaration])).toEqual(["{currency.convert}"]);
  });

  it("parses bounded dot and comma decimal amounts", () => {
    expect(parseCurrencyAmount("12,50 remaining words")).toBe(12.5);
    expect(parseCurrencyAmount("12.50")).toBe(12.5);
    expect(parseCurrencyAmount("1e9")).toBeNull();
    expect(parseCurrencyAmount("1".repeat(21))).toBeNull();
    expect(parseCurrencyAmount("-4")).toBeNull();
  });

  it("formats the converted amount in the channel language and caches the currency pair", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ base: "USD", rates: { EUR: 0.8 } }, { "Cache-Control": "max-age=900", ETag: '"fixture-rate"' }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const context = contextFor(database as unknown as D1Database, {
        commandInput: { commandName: "usd", arguments: "12,50" },
      });
      const result = await currencyModule.resolveTemplateParameter?.("currency.convert", "USD EUR", context);
      const cachedRate = await exchangeRate(database as unknown as D1Database, "USD", "EUR", NOW + 1_000, fetcher);

      expect(result).toContain("10,00");
      expect(result).toContain("€");
      expect(cachedRate).toBe(0.8);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("returns overridable bilingual usage when the command has no numeric argument", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      const defaultContext = contextFor(database as unknown as D1Database, { commandInput: { commandName: "usd", arguments: "" } });
      const customContext = contextFor(database as unknown as D1Database, {
        commandInput: { commandName: "usd", arguments: "words", usageText: "Try !usd 10" },
      });

      await expect(currencyModule.resolveTemplateParameter?.("currency.convert", "USD EUR", defaultContext))
        .resolves.toBe("Nutzung: !usd 12,50");
      await expect(currencyModule.resolveTemplateParameter?.("currency.convert", "USD EUR", customContext))
        .resolves.toBe("Try !usd 10");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("resolves a parameterized currency token through the generic template renderer", async () => {
    const database = new TestD1Database();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response({ rates: { EUR: 0.8 } })));
    try {
      const declaration = currencyModule.templateVariableCatalog?.[0];
      if (declaration === undefined) throw new Error("Currency variable catalog is missing.");
      const variable = { ...declaration, contexts: ["chat_command" as const] };
      const provider = {
        moduleId: "currency",
        variables: [variable],
        ...(currencyModule.templateUnavailableText === undefined ? {} : { templateUnavailableText: currencyModule.templateUnavailableText }),
        resolveTemplateParameter: currencyModule.resolveTemplateParameter,
      };
      const result = await createTemplateRenderer(event, "chat_command", [], resolverSources(database as unknown as D1Database, [provider]))(
        "{currency.convert USD EUR}",
        { command: "usd", args: "12,50" },
      );

      expect(result.text).toContain("10,00");
      expect(result.text).toContain("€");
    } finally {
      database.close();
    }
  });

  it("renders a missing currency pair as provider output instead of a literal token", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      const declaration = currencyModule.templateVariableCatalog?.[0];
      if (declaration === undefined) throw new Error("Currency variable catalog is missing.");
      const provider = {
        moduleId: "currency",
        variables: [{ ...declaration, contexts: ["chat_command" as const] }],
        ...(currencyModule.templateUnavailableText === undefined ? {} : { templateUnavailableText: currencyModule.templateUnavailableText }),
        resolveTemplateParameter: currencyModule.resolveTemplateParameter,
      };
      const result = await createTemplateRenderer(event, "chat_command", [], resolverSources(database as unknown as D1Database, [provider]))(
        "{currency.convert}",
        { command: "usd", args: "12,50" },
      );

      expect(result.text).toBe("Wechselkursdaten sind derzeit nicht verfügbar.");
      expect(result.text).not.toContain("{currency.convert}");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("does not resolve chat-command values in other template contexts", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ rates: { EUR: 0.8 } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const declaration = currencyModule.templateVariableCatalog?.[0];
      if (declaration === undefined) throw new Error("Currency variable catalog is missing.");
      const result = await createTemplateRenderer(event, "event", [], resolverSources(database as unknown as D1Database, [{
        moduleId: "currency",
        variables: [{ ...declaration, contexts: ["chat_command"] }],
        resolveTemplateParameter: currencyModule.resolveTemplateParameter,
      }]))("{currency.convert USD EUR}", {});

      expect(result.text).toBe("{currency.convert USD EUR}");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});

describe("weather picker and settings contracts", () => {
  it("has bilingual weather variable picker copy and defaults to MET Norway per channel", async () => {
    const database = new TestD1Database();
    try {
      const settings = await readWeatherSettings(database as unknown as D1Database, event.channelId);
      const catalog = weatherModule.templateVariableCatalog ?? [];

      expect(settings).toMatchObject({ provider: "met_norway", showFahrenheit: false });
      expect(catalog).toHaveLength(9);
      expect(catalog.every((variable) => variable.picker !== undefined && variable.picker.de.description.length > 0 && variable.picker.en.description.length > 0)).toBe(true);
      expect(weatherModule.templateVariableGroup?.label).toEqual({ de: "Wetter", en: "Weather" });
    } finally {
      database.close();
    }
  });
});
