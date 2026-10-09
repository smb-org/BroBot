import { PanelApiError } from "../../../contracts/panel-error";
import type { WeatherSettings } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/weather`;

const readJson = async <T,>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const fetchWeatherSettings = async (channelId: string, signal?: AbortSignal): Promise<WeatherSettings> =>
  readJson<WeatherSettings>(await fetch(`${modulePath(channelId)}/provider-settings`, signal ? { signal } : undefined));

export const saveWeatherSettings = async (
  channelId: string,
  input: Omit<WeatherSettings, "revision"> & { revision: number },
): Promise<WeatherSettings> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<WeatherSettings>(await fetch(`${modulePath(channelId)}/provider-settings`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": csrf.token, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
};
