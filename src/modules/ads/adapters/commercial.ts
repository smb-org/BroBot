import type { HelixRequest, ModuleRouteVariables } from "../contract";

export const START_COMMERCIAL_URL = "https://api.twitch.tv/helix/channels/commercial";

/** Twitch's own accepted lengths (seconds) for Start Commercial. */
export const COMMERCIAL_LENGTHS = [30, 60, 90, 120, 150, 180] as const;
export type CommercialLength = (typeof COMMERCIAL_LENGTHS)[number];

export interface CommercialResult {
  started: boolean;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  length: number | null;
  message: string | null;
  retryAfter: number | null;
}

type GetAppAccessToken = ModuleRouteVariables["getAppAccessToken"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const failure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): CommercialResult => ({ started: false, reason, detail, length: null, message: null, retryAfter: null });

/** The status-to-reason mapping is this endpoint's own business meaning, not `helixRequest`'s. */
const commercialReasonFor = (status: number): string =>
  status === 429 ? "rate_limited" : status === 401 ? "scope_missing" : `http_${String(status)}`;

/** Starts a commercial on the app token, the same path as the ads snooze action. */
export const startCommercial = async (
  environment: Env,
  channelId: string,
  length: CommercialLength,
  now: string,
  getAppAccessToken: GetAppAccessToken,
  helixRequest: HelixRequest,
  fetcher: typeof fetch = fetch,
): Promise<CommercialResult> => {
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(environment, now, fetcher);
  } catch (error: unknown) {
    return failure("app_token_unavailable", { message: error instanceof Error ? error.message : String(error) });
  }

  const result = await helixRequest<Record<string, unknown>>({
    method: "POST",
    url: START_COMMERCIAL_URL,
    body: { broadcaster_id: channelId, length },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "network_error") {
      return failure(result.reason, { status: null, message: result.message });
    }
    return failure(commercialReasonFor(result.status ?? 0), { status: result.status, message: result.message });
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};
  return {
    started: true,
    reason: null,
    detail: { status: result.status },
    length: numberOrNull(first.length),
    message: textOrNull(first.message),
    retryAfter: numberOrNull(first.retry_after),
  };
};
