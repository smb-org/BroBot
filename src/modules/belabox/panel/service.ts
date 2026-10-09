import { PanelApiError } from "../../../contracts/panel-error";
import type {
  BelaboxHistoryPoint,
  BelaboxStatusResponse,
  BelaboxStreamSummary,
  BelaboxTestResult,
} from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/belabox`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

const csrfToken = async (): Promise<string> =>
  (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

const mutate = async <Value,>(channelId: string, path: string, method: "PUT" | "DELETE" | "POST", body?: unknown): Promise<Value> => {
  const token = await csrfToken();
  return readJson<Value>(await fetch(`${modulePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
};

export const loadBelaboxStatus = async (channelId: string, signal?: AbortSignal): Promise<BelaboxStatusResponse> =>
  readJson<BelaboxStatusResponse>(await fetch(`${modulePath(channelId)}/status`, signal === undefined ? {} : { signal }));

export const loadBelaboxHistory = async (
  channelId: string,
  range: "live" | "stream",
  streamId?: string,
  signal?: AbortSignal,
): Promise<BelaboxHistoryPoint[]> => {
  const query = new URLSearchParams({ range });
  if (streamId !== undefined) query.set("streamId", streamId);
  return readJson<BelaboxHistoryPoint[]>(await fetch(`${modulePath(channelId)}/history?${query.toString()}`, signal === undefined ? {} : { signal }));
};

export const loadBelaboxStreams = async (channelId: string, signal?: AbortSignal): Promise<BelaboxStreamSummary[]> =>
  readJson<BelaboxStreamSummary[]>(await fetch(`${modulePath(channelId)}/streams`, signal === undefined ? {} : { signal }));

export const replaceBelaboxStatsUrl = async (channelId: string, url: string): Promise<void> => {
  await mutate<{ configured: true }>(channelId, "/stats-url", "PUT", { url });
};

export const removeBelaboxStatsUrl = async (channelId: string): Promise<void> => {
  await mutate<{ configured: false }>(channelId, "/stats-url", "DELETE");
};

export const retryBelaboxPolling = async (channelId: string): Promise<void> => {
  await mutate<{ ensured: true }>(channelId, "/polling/retry", "POST");
};

export const testBelaboxConnection = async (channelId: string, url?: string): Promise<BelaboxTestResult> =>
  mutate<BelaboxTestResult>(channelId, "/test", "POST", url === undefined ? {} : { url });
