import type { NormalizedWeather, WeatherProviderId } from "../contracts";
import { feelsLikeTemperatureC, weatherConditionFromMetSymbol, weatherConditionFromWmoCode } from "../domain";

export interface WeatherCoordinates {
  latitude: number;
  longitude: number;
}

export interface WeatherValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface WeatherProviderResponse {
  notModified: boolean;
  weather?: NormalizedWeather;
  expiresAt: number | null;
  etag: string | null;
  lastModified: string | null;
}

export type WeatherProviderAdapter = (input: {
  coordinates: WeatherCoordinates;
  validators: WeatherValidators;
  fetcher?: typeof fetch;
  now: number;
}) => Promise<WeatherProviderResponse>;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const finiteNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const expiryFromHeaders = (headers: Headers, now: number): number | null => {
  const expires = headers.get("Expires");
  const expiresAt = expires === null ? Number.NaN : Date.parse(expires);
  if (Number.isFinite(expiresAt)) return expiresAt;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/iu.exec(headers.get("Cache-Control") ?? "")?.[1];
  return maxAge === undefined ? null : now + Number(maxAge) * 1_000;
};

const request = async (
  provider: WeatherProviderId,
  url: URL,
  validators: WeatherValidators,
  fetcher: typeof fetch,
): Promise<Response> => {
  const headers = new Headers({ Accept: "application/json" });
  if (validators.etag !== null) headers.set("If-None-Match", validators.etag);
  if (validators.lastModified !== null) headers.set("If-Modified-Since", validators.lastModified);
  if (provider === "met_norway") headers.set("User-Agent", "BroBot/0.1.0 (+https://github.com/smb-org/BroBot)");
  return fetcher(url, { headers, signal: AbortSignal.timeout(6_000) });
};

const responseMetadata = (response: Response, now: number) => ({
  expiresAt: expiryFromHeaders(response.headers, now),
  etag: response.headers.get("ETag"),
  lastModified: response.headers.get("Last-Modified"),
});

export const metNorwayWeather: WeatherProviderAdapter = async ({ coordinates, validators, fetcher = fetch, now }) => {
  const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  url.searchParams.set("lat", coordinates.latitude.toFixed(4));
  url.searchParams.set("lon", coordinates.longitude.toFixed(4));
  const response = await request("met_norway", url, validators, fetcher);
  const metadata = responseMetadata(response, now);
  if (response.status === 304) return { notModified: true, ...metadata };
  if (!response.ok) throw new Error(`MET Norway returned HTTP ${String(response.status)}.`);
  const payload: unknown = await response.json().catch(() => null);
  const properties = record(record(payload)?.properties);
  const timeseries = properties?.timeseries;
  const first = Array.isArray(timeseries) ? record(timeseries[0]) : null;
  const data = record(first?.data);
  const instant = record(data?.instant);
  const details = record(instant?.details);
  const nextHour = record(data?.next_1_hours);
  const summary = record(nextHour?.summary);
  const nextDetails = record(nextHour?.details);
  const temperatureC = finiteNumber(details?.air_temperature);
  const windSpeedMps = finiteNumber(details?.wind_speed);
  const humidityPercent = finiteNumber(details?.relative_humidity);
  const observedAt = stringValue(first?.time);
  const symbolCode = stringValue(summary?.symbol_code) ?? "";
  if (temperatureC === null || windSpeedMps === null || humidityPercent === null || observedAt === null || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error("MET Norway response did not include a current observation.");
  }
  const condition = weatherConditionFromMetSymbol(symbolCode);
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "UTC", hour: "2-digit", hourCycle: "h23" }).format(Date.parse(observedAt)));
  const isDay = !symbolCode.endsWith("_night");
  const precipitationMm = Math.max(0, finiteNumber(nextDetails?.precipitation_amount) ?? 0);
  return {
    notModified: false,
    weather: {
      temperatureC,
      feelsLikeC: feelsLikeTemperatureC(temperatureC, windSpeedMps, humidityPercent),
      condition,
      isDay: symbolCode.length === 0 ? hour >= 6 && hour < 19 : isDay,
      windSpeedMps,
      precipitationMm,
      humidityPercent,
      observedAt,
      shortForecast: condition,
    },
    ...metadata,
  };
};

export const openMeteoWeather: WeatherProviderAdapter = async ({ coordinates, validators, fetcher = fetch, now }) => {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", coordinates.latitude.toFixed(4));
  url.searchParams.set("longitude", coordinates.longitude.toFixed(4));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day");
  url.searchParams.set("hourly", "precipitation,weather_code");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timezone", "UTC");
  const response = await request("open_meteo", url, validators, fetcher);
  const metadata = responseMetadata(response, now);
  if (response.status === 304) return { notModified: true, ...metadata };
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${String(response.status)}.`);
  const payload: unknown = await response.json().catch(() => null);
  const current = record(record(payload)?.current);
  const hourly = record(record(payload)?.hourly);
  const temperatureC = finiteNumber(current?.temperature_2m);
  const feelsLikeC = finiteNumber(current?.apparent_temperature);
  const humidityPercent = finiteNumber(current?.relative_humidity_2m);
  const windSpeedMps = finiteNumber(current?.wind_speed_10m);
  const observedAt = stringValue(current?.time);
  const code = finiteNumber(current?.weather_code);
  if (temperatureC === null || humidityPercent === null || windSpeedMps === null || observedAt === null ||
      code === null || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error("Open-Meteo response did not include a current observation.");
  }
  const condition = weatherConditionFromWmoCode(code);
  const hourlyTimes = hourly?.time;
  const nextHourIndex = Array.isArray(hourlyTimes)
    ? hourlyTimes.findIndex((time) => typeof time === "string" && Date.parse(time) > Date.parse(observedAt))
    : -1;
  const hourlyCodes = hourly?.weather_code;
  const hourlyPrecipitation = hourly?.precipitation;
  const nextCode = nextHourIndex < 0 || !Array.isArray(hourlyCodes) ? undefined : finiteNumber(hourlyCodes[nextHourIndex]);
  const nextPrecipitation = nextHourIndex < 0 || !Array.isArray(hourlyPrecipitation) ? null : finiteNumber(hourlyPrecipitation[nextHourIndex]);
  return {
    notModified: false,
    weather: {
      temperatureC,
      feelsLikeC: feelsLikeC ?? feelsLikeTemperatureC(temperatureC, windSpeedMps, humidityPercent),
      condition,
      isDay: current?.is_day === 1,
      windSpeedMps,
      precipitationMm: Math.max(0, nextPrecipitation ?? finiteNumber(current?.precipitation) ?? 0),
      humidityPercent,
      observedAt,
      shortForecast: nextCode === undefined || nextCode === null ? condition : weatherConditionFromWmoCode(nextCode),
    },
    ...metadata,
  };
};

export const WEATHER_PROVIDER_ADAPTERS: Readonly<Record<WeatherProviderId, WeatherProviderAdapter>> = {
  met_norway: metNorwayWeather,
  open_meteo: openMeteoWeather,
};
