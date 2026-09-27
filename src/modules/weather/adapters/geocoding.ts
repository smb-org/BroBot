import { readBoundedJsonResponse, type ModuleLanguage } from "../../contract";
import type { ModuleChannelLocation } from "../../contract";

const PLACE_NAME_MAX_LENGTH = 100;
const PLACE_NAME_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()-]{0,98}[\p{L}\p{M}\p{N})]$/u;

export const validWeatherPlaceName = (value: string): boolean => {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length >= 2 && normalized.length <= PLACE_NAME_MAX_LENGTH && PLACE_NAME_PATTERN.test(normalized);
};

export type WeatherPlaceLookup =
  | { kind: "found"; location: ModuleChannelLocation }
  | { kind: "not_found" };

export const geocodeWeatherPlace = async (
  name: string,
  language: ModuleLanguage,
  fetcher: typeof fetch = fetch,
): Promise<WeatherPlaceLookup> => {
  const normalized = name.trim().replace(/\s+/gu, " ");
  if (!validWeatherPlaceName(normalized)) return { kind: "not_found" };
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", normalized);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", language);
  url.searchParams.set("format", "json");
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Weather geocoding returned HTTP ${String(response.status)}.`);
  const payload: unknown = await readBoundedJsonResponse(response);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Weather geocoding response was invalid.");
  const results: unknown = Reflect.get(payload, "results");
  const first: unknown = Array.isArray(results) ? results[0] : undefined;
  if (typeof first !== "object" || first === null || Array.isArray(first)) return { kind: "not_found" };
  const latitude: unknown = Reflect.get(first, "latitude");
  const longitude: unknown = Reflect.get(first, "longitude");
  const timeZone: unknown = Reflect.get(first, "timezone");
  const resultName: unknown = Reflect.get(first, "name");
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90 || typeof longitude !== "number" || longitude < -180 || longitude > 180 ||
      typeof timeZone !== "string" || typeof resultName !== "string" || resultName.length === 0) {
    throw new Error("Weather geocoding response did not include a valid place.");
  }
  const country: unknown = Reflect.get(first, "country");
  return {
    kind: "found",
    location: {
      name: typeof country === "string" && country.length > 0 ? `${resultName}, ${country}` : resultName,
      latitude,
      longitude,
      timeZone,
    },
  };
};
