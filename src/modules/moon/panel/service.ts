import { PanelApiError } from "../../../contracts/panel-error";
import type { MoonSettings } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/moon`;

const readJson = async <T,>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const fetchMoonSettings = async (channelId: string, signal?: AbortSignal): Promise<MoonSettings> =>
  readJson<MoonSettings>(await fetch(`${modulePath(channelId)}/unavailable-texts`, signal ? { signal } : undefined));

export const saveMoonSettings = async (
  channelId: string,
  input: { revision: number; errorTexts: MoonSettings["errorTexts"] },
): Promise<MoonSettings> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<MoonSettings>(await fetch(`${modulePath(channelId)}/unavailable-texts`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": csrf.token, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
};
