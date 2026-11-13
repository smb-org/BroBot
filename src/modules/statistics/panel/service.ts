import { PanelApiError } from "../../../contracts/panel-error";
import type {
  StatisticsSettings,
  StatisticsStreamDetailResponse,
  StatisticsStreamListResponse,
  StatisticsTrendsResponse,
  StatisticsTrendsWeeks,
  StatisticsWordsResponse,
} from "../contracts";
import { statisticsSettingsSchema } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/statistics/streams`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

export const loadStatisticsStreams = async (
  channelId: string,
  signal: AbortSignal,
  cursor?: string,
): Promise<StatisticsStreamListResponse> => {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return readJson<StatisticsStreamListResponse>(await fetch(`${modulePath(channelId)}?${query.toString()}`, { signal }));
};

export const loadStatisticsStream = async (
  channelId: string,
  streamId: string,
  signal: AbortSignal,
): Promise<StatisticsStreamDetailResponse> => readJson<StatisticsStreamDetailResponse>(await fetch(
  `${modulePath(channelId)}/${encodeURIComponent(streamId)}`,
  { signal },
));

export const loadStatisticsTrends = async (
  channelId: string,
  weeks: StatisticsTrendsWeeks,
  signal: AbortSignal,
): Promise<StatisticsTrendsResponse> => {
  const query = new URLSearchParams({ weeks: String(weeks) });
  return readJson<StatisticsTrendsResponse>(await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/modules/statistics/trends?${query.toString()}`,
    { signal },
  ));
};

export const loadStatisticsWords = async (
  channelId: string,
  page: number,
  search: string,
  hideFillers: boolean,
  signal: AbortSignal,
  scope: "stream" | "total" = "total",
): Promise<StatisticsWordsResponse> => {
  const query = new URLSearchParams({
    page: String(page),
    search,
    hideFillers: String(hideFillers),
    scope,
  });
  return readJson<StatisticsWordsResponse>(await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/modules/statistics/words?${query.toString()}`,
    { signal },
  ));
};

const settingsPath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/statistics/settings`;

export interface StatisticsSettingsState {
  settings: StatisticsSettings;
  revision: number;
}

export const loadStatisticsSettings = async (
  channelId: string,
  signal?: AbortSignal,
): Promise<StatisticsSettingsState> => {
  const result = await readJson<{ settings: unknown; revision: number }>(await fetch(
    settingsPath(channelId), signal === undefined ? undefined : { signal },
  ));
  return { ...result, settings: statisticsSettingsSchema.parse(result.settings) };
};

export const saveStatisticsSettings = async (
  channelId: string,
  revision: number,
  settings: StatisticsSettings,
): Promise<StatisticsSettingsState> => {
  const { token } = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const result = await readJson<{ settings: unknown; revision: number }>(await fetch(settingsPath(channelId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ revision, settings }),
  }));
  return { ...result, settings: statisticsSettingsSchema.parse(result.settings) };
};

export const statisticsSettingsErrorCode = (error: unknown): "conflict" | "save" =>
  error instanceof PanelApiError && error.status === 409 ? "conflict" : "save";
