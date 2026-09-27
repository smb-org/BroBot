import { PanelApiError } from "../../../contracts/panel-error";
import type { SunLocation, SunSettings } from "../contracts";

export interface SunGeocodingResult extends SunLocation {
  country: string;
  admin1: string | null;
}

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/sun`;

const readJson = async <T,>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const fetchSunSettings = async (channelId: string): Promise<SunSettings> =>
  readJson<SunSettings>(await fetch(`${modulePath(channelId)}/location`));

export const searchSunLocations = async (
  channelId: string,
  query: string,
  language: "de" | "en",
): Promise<readonly SunGeocodingResult[]> => {
  const search = new URLSearchParams({ q: query, language });
  return (await readJson<{ results: SunGeocodingResult[] }>(await fetch(`${modulePath(channelId)}/geocode?${search}`))).results;
};

export const saveSunSettings = async (
  channelId: string,
  input: { revision: number; location: SunLocation | null; errorTexts: SunSettings["errorTexts"] },
): Promise<SunSettings> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<SunSettings>(await fetch(`${modulePath(channelId)}/location`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": csrf.token, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
};

