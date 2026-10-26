import { PanelApiError } from "../../../contracts/panel-error";
import type {
  StatisticsStreamDetailResponse,
  StatisticsStreamListResponse,
  StatisticsTrendsResponse,
  StatisticsTrendsWeeks,
  StatisticsWordsResponse,
} from "../contracts";

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
): Promise<StatisticsWordsResponse> => {
  const query = new URLSearchParams({
    page: String(page),
    search,
    hideFillers: String(hideFillers),
  });
  return readJson<StatisticsWordsResponse>(await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/modules/statistics/words?${query.toString()}`,
    { signal },
  ));
};
