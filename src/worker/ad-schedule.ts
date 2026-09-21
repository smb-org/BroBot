import { getAppAccessToken } from "./app-token";
import { TwitchApiError } from "./bot-maintenance";

export const AD_SCHEDULE_URL = "https://api.twitch.tv/helix/channels/ads";

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

interface AdScheduleEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

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

/** Holt Get Ad Schedule mit dem App-Token; ein leerer Termin ist Erfolg. */
export const getAdSchedule = async (
  environment: AdScheduleEnvironment,
  channelId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<AdScheduleResult> => {
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(environment as unknown as Env, now, fetcher);
  } catch (error: unknown) {
    if (error instanceof TwitchApiError) {
      const reason = error.status === 429 ? "rate_limited" : error.status === 401 ? "unauthorized" : "app_token_error";
      return failure(reason, { status: error.status, message: error.message });
    }
    return failure("app_token_error", { status: null, message: error instanceof Error ? error.message : String(error) });
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
