import { helixRequest } from "./twitch/helix";

const CREATE_CLIP_URL = "https://api.twitch.tv/helix/clips";
const CONFIRM_CLIP_URL = "https://api.twitch.tv/helix/clips";
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRMATION_INTERVAL_MS = 2_000;

export interface CreateClipResult {
  created: boolean;
  /** Machine-readable reason when the clip was not created. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  clipId: string | null;
  editUrl: string | null;
}

export interface ClipAvailabilityOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const failure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): CreateClipResult => ({ created: false, reason, detail, clipId: null, editUrl: null });

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const clipIsAvailable = (value: unknown, clipId: string): boolean => {
  if (!isRecord(value) || !Array.isArray(value.data)) return false;
  return value.data.some((clip) => isRecord(clip) && clip.id === clipId);
};

/** The status-to-reason mapping is this endpoint's own business meaning, not `helixRequest`'s. */
const clipReasonFor = (status: number): string => {
  if (status === 429) return "rate_limited";
  if (status === 401) return "scope_missing";
  // Twitch rejects Create Clip with 400 when the channel isn't currently live.
  if (status === 400) return "not_live";
  return `http_${String(status)}`;
};

/**
 * Creates a clip on the bot's own identity -- the bot already carries
 * `clips:edit` (see `auth/oauth.ts`'s `BOT_SCOPES`), so this needs no
 * broadcaster consent, unlike ads snooze/commercial.
 */
export const createClip = async (
  environment: { TWITCH_CLIENT_ID: string },
  accessToken: string,
  channelId: string,
  fetcher: typeof fetch = fetch,
  availabilityOptions: ClipAvailabilityOptions = {},
): Promise<CreateClipResult> => {
  const result = await helixRequest<Record<string, unknown>>({
    method: "POST",
    url: CREATE_CLIP_URL,
    query: { broadcaster_id: channelId },
    accessToken,
    clientId: environment.TWITCH_CLIENT_ID,
    fetcher,
  });
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "network_error") {
      return failure(result.reason, { status: null, twitchMessage: result.message });
    }
    return failure(clipReasonFor(result.status ?? 0), { status: result.status, twitchMessage: result.message });
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};
  const clipId = textOrNull(first.id);
  if (clipId === null) return failure("missing_clip_id", { status: result.status });

  const timeoutMs = availabilityOptions.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const pollIntervalMs = availabilityOptions.pollIntervalMs ?? DEFAULT_CONFIRMATION_INTERVAL_MS;
  const now = availabilityOptions.now ?? Date.now;
  const wait = availabilityOptions.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  const availabilityTimeout = (): CreateClipResult => failure("availability_timeout", {
    status: result.status,
    waitedMs: timeoutMs,
  });
  for (;;) {
    const requestTimeoutMs = deadline - now();
    if (requestTimeoutMs <= 0) return availabilityTimeout();
    const availability = await helixRequest<Record<string, unknown>>({
      method: "GET",
      url: CONFIRM_CLIP_URL,
      query: { id: clipId },
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      timeoutMs: requestTimeoutMs,
      fetcher,
    });
    if (now() > deadline) return availabilityTimeout();
    if (!availability.ok) {
      if (availability.reason === "timeout") return availabilityTimeout();
      const reason = availability.reason === "rate_limited"
        ? "rate_limited"
        : availability.reason === "network_error"
          ? availability.reason
          : "availability_check_failed";
      return failure(reason, { status: availability.status, twitchMessage: availability.message });
    }
    if (clipIsAvailable(availability.data, clipId)) {
      return {
        created: true,
        reason: null,
        detail: { status: result.status, confirmationStatus: availability.status },
        clipId,
        editUrl: textOrNull(first.edit_url),
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) return availabilityTimeout();
    await wait(Math.min(pollIntervalMs, remaining));
  }
};
