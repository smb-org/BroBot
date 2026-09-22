import { helixRequest } from "./twitch/helix";

export const CREATE_CLIP_URL = "https://api.twitch.tv/helix/clips";

export interface CreateClipResult {
  created: boolean;
  /** Machine-readable reason when the clip was not created. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  clipId: string | null;
  editUrl: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const failure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): CreateClipResult => ({ created: false, reason, detail, clipId: null, editUrl: null });

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
      return failure(result.reason, { status: null, message: result.message });
    }
    return failure(clipReasonFor(result.status ?? 0), { status: result.status, message: result.message });
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};
  return {
    created: true,
    reason: null,
    detail: { status: result.status },
    clipId: textOrNull(first.id),
    editUrl: textOrNull(first.edit_url),
  };
};
