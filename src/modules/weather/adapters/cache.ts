import type { NormalizedWeather, WeatherProviderId } from "../contracts";
import { normalizeCoordinates } from "../domain";
import { WEATHER_PROVIDER_ADAPTERS, WeatherProviderError, type WeatherCoordinates } from "./providers";

const WEATHER_CACHE_TTL_MS = 15 * 60 * 1_000;
const MET_NORWAY_MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const WEATHER_FAILURE_CACHE_TTL_MS = 60 * 1_000;
const WEATHER_FAILURE_CACHE_MAX_TTL_MS = 15 * 60 * 1_000;
const WEATHER_FAILURE_CACHE_PAYLOAD = "{\"unavailable\":true}";

interface WeatherCacheRow {
  payload_json: string;
  expires_at: string;
  etag: string | null;
  last_modified: string | null;
}

export interface CachedWeather {
  weather: NormalizedWeather;
  expiresAt: number;
  coordinates: WeatherCoordinates & { key: string };
}

const weatherRefreshes = new Map<string, Promise<CachedWeather>>();

const parseWeather = (value: string): NormalizedWeather | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    return typeof row.temperatureC === "number" && typeof row.feelsLikeC === "number" &&
      typeof row.condition === "string" && typeof row.isDay === "boolean" &&
      typeof row.windSpeedMps === "number" && typeof row.precipitationMm === "number" &&
      typeof row.humidityPercent === "number" && typeof row.observedAt === "string" &&
      typeof row.shortForecast === "string"
      ? row as unknown as NormalizedWeather
      : null;
  } catch {
    return null;
  }
};

const cacheExpiry = (
  provider: WeatherProviderId,
  providerExpiry: number | null,
  now: number,
  revalidated: boolean,
): number => {
  if (provider === "met_norway") {
    if (providerExpiry === null || revalidated && providerExpiry <= now) return now + WEATHER_CACHE_TTL_MS;
    return Math.min(now + MET_NORWAY_MAX_CACHE_TTL_MS, Math.max(now, providerExpiry));
  }
  if (providerExpiry === null) return now + WEATHER_CACHE_TTL_MS;
  return Math.min(now + WEATHER_CACHE_TTL_MS, Math.max(now, providerExpiry));
};

export const readWeatherCache = async (
  db: D1Database,
  provider: WeatherProviderId,
  latitude: number,
  longitude: number,
  now: number,
): Promise<CachedWeather | null> => {
  const coordinates = normalizeCoordinates(latitude, longitude);
  const row = await db.prepare(
    `SELECT payload_json, expires_at, etag, last_modified
       FROM weather_cache WHERE provider = ? AND location_key = ?`,
  ).bind(provider, coordinates.key).first<WeatherCacheRow>();
  if (row === null) return null;
  const weather = parseWeather(row.payload_json);
  const expiresAt = Date.parse(row.expires_at);
  return weather === null || !Number.isFinite(expiresAt) || expiresAt <= now
    ? null
    : { weather, expiresAt, coordinates };
};

export const fetchCachedWeather = async (
  db: D1Database,
  provider: WeatherProviderId,
  latitude: number,
  longitude: number,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<CachedWeather> => {
  const coordinates = normalizeCoordinates(latitude, longitude);
  const refreshKey = `${provider}:${coordinates.key}`;
  const inFlight = weatherRefreshes.get(refreshKey);
  if (inFlight !== undefined) return inFlight;

  const refresh = fetchWeatherForCoordinates(db, provider, coordinates, now, fetcher);
  weatherRefreshes.set(refreshKey, refresh);
  const cleanup = (): void => {
    if (weatherRefreshes.get(refreshKey) === refresh) weatherRefreshes.delete(refreshKey);
  };
  void refresh.then(cleanup, cleanup);
  return refresh;
};

const fetchWeatherForCoordinates = async (
  db: D1Database,
  provider: WeatherProviderId,
  coordinates: WeatherCoordinates & { key: string },
  now: number,
  fetcher: typeof fetch,
): Promise<CachedWeather> => {
  const row = await db.prepare(
    `SELECT payload_json, expires_at, etag, last_modified
       FROM weather_cache WHERE provider = ? AND location_key = ?`,
  ).bind(provider, coordinates.key).first<WeatherCacheRow>();
  const cached = row === null ? null : parseWeather(row.payload_json);
  const cacheExpiresAt = row === null ? Number.NaN : Date.parse(row.expires_at);
  if (cached !== null && Number.isFinite(cacheExpiresAt) && cacheExpiresAt > now) {
    return { weather: cached, expiresAt: cacheExpiresAt, coordinates };
  }
  if (row?.payload_json === WEATHER_FAILURE_CACHE_PAYLOAD && Number.isFinite(cacheExpiresAt) && cacheExpiresAt > now) {
    throw new Error("Weather provider is in its retry cooldown.");
  }
  let result;
  try {
    result = await WEATHER_PROVIDER_ADAPTERS[provider]({
      coordinates,
      validators: { etag: row?.etag ?? null, lastModified: row?.last_modified ?? null },
      fetcher,
      now,
    });
  } catch (error) {
    const requestedDelay = error instanceof WeatherProviderError ? error.retryAfterMs : null;
    const cooldown = Math.min(
      WEATHER_FAILURE_CACHE_MAX_TTL_MS,
      Math.max(WEATHER_FAILURE_CACHE_TTL_MS, requestedDelay ?? WEATHER_FAILURE_CACHE_TTL_MS),
    );
    const expiresAt = now + cooldown;
    await writeWeatherCache(
      db,
      provider,
      coordinates,
      WEATHER_FAILURE_CACHE_PAYLOAD,
      expiresAt,
      null,
      null,
      now,
    );
    throw error;
  }
  const expiresAt = cacheExpiry(provider, result.expiresAt, now, result.notModified);
  const weather = result.notModified ? cached : result.weather ?? null;
  if (weather === null) throw new Error("Weather provider returned no reusable observation.");
  await writeWeatherCache(
    db,
    provider,
    coordinates,
    JSON.stringify(weather),
    expiresAt,
    result.etag ?? row?.etag ?? null,
    result.lastModified ?? row?.last_modified ?? null,
    now,
  );
  return { weather, expiresAt, coordinates };
};

const writeWeatherCache = async (
  db: D1Database,
  provider: WeatherProviderId,
  coordinates: WeatherCoordinates & { key: string },
  payload: string,
  expiresAt: number,
  etag: string | null,
  lastModified: string | null,
  now: number,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO weather_cache (provider, location_key, latitude, longitude, payload_json, expires_at, etag, last_modified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, location_key) DO UPDATE SET
       latitude = excluded.latitude, longitude = excluded.longitude, payload_json = excluded.payload_json,
       expires_at = excluded.expires_at, etag = excluded.etag, last_modified = excluded.last_modified,
       updated_at = excluded.updated_at`,
  ).bind(
    provider,
    coordinates.key,
    coordinates.latitude,
    coordinates.longitude,
    payload,
    new Date(expiresAt).toISOString(),
    etag,
    lastModified,
    new Date(now).toISOString(),
  ).run();
};
