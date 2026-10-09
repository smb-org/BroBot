import { PanelApiError } from "../../../contracts/panel-error";
import type { SunSettings } from "../contracts";

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

export const fetchSunSettings = async (channelId: string, signal?: AbortSignal): Promise<SunSettings> =>
  readJson<SunSettings>(await fetch(`${modulePath(channelId)}/error-texts`, signal ? { signal } : undefined));

export const saveSunSettings = async (
  channelId: string,
  input: { revision: number; errorTexts: SunSettings["errorTexts"] },
): Promise<SunSettings> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<SunSettings>(await fetch(`${modulePath(channelId)}/error-texts`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": csrf.token, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
};
