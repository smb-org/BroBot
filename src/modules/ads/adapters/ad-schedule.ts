import type { ModuleRouteVariables } from "../contract";

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

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

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

/** Fetches Get Ad Schedule using the app token; an empty schedule counts as success. */
export const getAdSchedule = async (
  environment: Env,
  channelId: string,
  now: string,
  getAppAccessToken: GetAppAccessToken,
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

  const url = new URL(AD_SCHEDULE_URL);
  url.searchParams.set("broadcaster_id", channelId);
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      headers: {
        "Client-ID": environment.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error: unknown) {
    return failure("network_error", { status: null, message: error instanceof Error ? error.message : String(error) });
  }

  const body = await responseJson(response);
  const message = textOrNull(body.message);
  if (!response.ok) {
    return failure(
      response.status === 429 ? "rate_limited" : response.status === 401 ? "unauthorized" : `http_${String(response.status)}`,
      { status: response.status, message },
    );
  }

  return {
    fetched: true,
    reason: null,
    detail: { status: response.status, message },
    schedule: scheduleFrom(body),
  };
};

/** Postpones the next automatic ad break using the app token. */
export const snoozeNextAd = async (
  environment: Env,
  channelId: string,
  now: string,
  getAppAccessToken: GetAppAccessToken,
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

  const url = new URL(SNOOZE_NEXT_AD_URL);
  url.searchParams.set("broadcaster_id", channelId);
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      headers: {
        "Client-ID": environment.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error: unknown) {
    return snoozeFailure("network_error", { status: null, message: error instanceof Error ? error.message : String(error) });
  }

  const body = await responseJson(response);
  const message = textOrNull(body.message);
  if (!response.ok) {
    const reason = response.status === 429
      ? "rate_limited"
      : response.status === 401 && missingScopeMessage(message)
        ? "scope_missing"
        : response.status === 401 ? "unauthorized" : `http_${String(response.status)}`;
    return snoozeFailure(reason, { status: response.status, message });
  }

  return {
    snoozed: true,
    reason: null,
    detail: { status: response.status, message },
    schedule: scheduleFrom(body),
  };
};
