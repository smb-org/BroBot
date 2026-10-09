import { PanelApiError } from "../../../contracts/panel-error";
import type { ApiSource } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/api_source`;

const readJson = async <T,>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const loadApiSources = async (channelId: string, signal?: AbortSignal): Promise<readonly ApiSource[]> =>
  (await readJson<{ sources: ApiSource[] }>(await fetch(`${modulePath(channelId)}/sources`, signal === undefined ? undefined : { signal }))).sources;

const csrfToken = async (): Promise<string> =>
  (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

const mutate = async <T,>(channelId: string, path: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<T> => {
  const token = await csrfToken();
  return readJson<T>(await fetch(`${modulePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
};

export const createApiSource = async (
  channelId: string,
  input: Pick<ApiSource, "name" | "url" | "expression">,
): Promise<ApiSource> => (await mutate<{ source: ApiSource }>(channelId, "/sources", "POST", input)).source;

export const updateApiSource = async (
  channelId: string,
  name: string,
  input: Pick<ApiSource, "url" | "expression" | "revision">,
): Promise<ApiSource> => (await mutate<{ source: ApiSource }>(channelId, `/sources/${encodeURIComponent(name)}`, "PATCH", input)).source;

export const deleteApiSource = async (channelId: string, name: string, revision: number): Promise<void> => {
  await mutate<{ ok: true }>(channelId, `/sources/${encodeURIComponent(name)}`, "DELETE", { revision });
};
