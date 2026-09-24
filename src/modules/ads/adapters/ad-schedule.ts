import type { HelixRequest, ModuleRouteVariables } from "../contract";

export const AD_SCHEDULE_URL = "https://api.twitch.tv/helix/channels/ads";
export const SNOOZE_NEXT_AD_URL = "https://api.twitch.tv/helix/channels/ads/schedule/snooze";

export interface AdSchedule {
  nextAdAt: string | null;
  duration: number | null;
  lastAdAt: string | null;
  prerollFreeTime: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
}

export interface AdScheduleResult {
  fetched: boolean;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  schedule: AdSchedule | null;
}

export interface SnoozeNextAdResult {
  snoozed: boolean;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  schedule: AdSchedule | null;
}

type GetAppAccessToken = ModuleRouteVariables["getAppAccessToken"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const scheduleFrom = (body: Record<string, unknown>): AdSchedule => {
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};
  return {
    nextAdAt: textOrNull(first.next_ad_at),
    duration: numberOrNull(first.duration),
    lastAdAt: textOrNull(first.last_ad_at),
    prerollFreeTime: numberOrNull(first.preroll_free_time),
    snoozeCount: numberOrNull(first.snooze_count),
    snoozeRefreshAt: textOrNull(first.snooze_refresh_at),
  };
};

const failure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): AdScheduleResult => ({ fetched: false, reason, detail, schedule: null });

const snoozeFailure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): SnoozeNextAdResult => ({ snoozed: false, reason, detail, schedule: null });

const missingScopeMessage = (message: string | null): boolean =>
  message !== null && /(scope|permission)/i.test(message);

const twitchErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = error.status;
  return typeof status === "number" ? status : null;
};

/** The status-to-reason mapping is this endpoint's own business meaning, not `helixRequest`'s. */
const scheduleReasonFor = (status: number): string =>
  status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : `http_${String(status)}`;

/** Fetches Get Ad Schedule using the app token; an empty schedule counts as success. */
export const getAdSchedule = async (
  environment: Env,
  channelId: string,
  now: string,
  getAppAccessToken: GetAppAccessToken,
  helixRequest: HelixRequest,
  fetcher: typeof fetch = fetch,
): Promise<AdScheduleResult> => {
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(environment, now, fetcher);
  } catch (error: unknown) {
    const status = twitchErrorStatus(error);
    if (status !== null) {
      const reason = status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : "app_token_unavailable";
      return failure(reason, { status, message: error instanceof Error ? error.message : String(error) });
    }
    return failure("app_token_unavailable", { status: null, message: error instanceof Error ? error.message : String(error) });
  }

  const result = await helixRequest<Record<string, unknown>>({
    url: AD_SCHEDULE_URL,
    query: { broadcaster_id: channelId },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "network_error") {
      return failure(result.reason, { status: null, twitchMessage: result.message });
    }
    return failure(scheduleReasonFor(result.status ?? 0), { status: result.status, twitchMessage: result.message });
  }

  const body = isRecord(result.data) ? result.data : {};
  return {
    fetched: true,
    reason: null,
    detail: { status: result.status, twitchMessage: textOrNull(body.message) },
    schedule: scheduleFrom(body),
  };
};

/** Postpones the next automatic ad break using the app token. */
export const snoozeNextAd = async (
  environment: Env,
  channelId: string,
  now: string,
  getAppAccessToken: GetAppAccessToken,
  helixRequest: HelixRequest,
  fetcher: typeof fetch = fetch,
): Promise<SnoozeNextAdResult> => {
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(environment, now, fetcher);
  } catch (error: unknown) {
    const status = twitchErrorStatus(error);
    if (status !== null) {
      const reason = status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : "app_token_unavailable";
      return snoozeFailure(reason, { status, message: error instanceof Error ? error.message : String(error) });
    }
    return snoozeFailure("app_token_unavailable", { status: null, message: error instanceof Error ? error.message : String(error) });
  }

  const result = await helixRequest<Record<string, unknown>>({
    method: "POST",
    url: SNOOZE_NEXT_AD_URL,
    query: { broadcaster_id: channelId },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "network_error") {
      return snoozeFailure(result.reason, { status: null, twitchMessage: result.message });
    }
    const status = result.status ?? 0;
    const reason = status === 429
      ? "rate_limited"
      : status === 401 && missingScopeMessage(result.message)
        ? "scope_missing"
        : status === 401 ? "unauthorized" : `http_${String(status)}`;
    return snoozeFailure(reason, { status: result.status, twitchMessage: result.message });
  }

  const body = isRecord(result.data) ? result.data : {};
  return {
    snoozed: true,
    reason: null,
    detail: { status: result.status, twitchMessage: textOrNull(body.message) },
    schedule: scheduleFrom(body),
  };
};
