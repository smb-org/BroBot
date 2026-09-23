import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import { readChannelStreamState, writeHelixStreamStateIfUnknown, type StoredStreamState } from "./db/stream-state";
import { listChannelIdsWithoutStreamState } from "./db/channels";
import { logMaintenanceError } from "./bot-maintenance";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arrayValue = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const fetchLiveStreamState = async (
  env: Env,
  channelId: string,
  now: string,
  fetcher: typeof fetch,
): Promise<StoredStreamState | null> => {
  try {
    const accessToken = await getAppAccessToken(env, now, fetcher);
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: channelId, type: "live" },
      accessToken,
      clientId: env.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok || !isRecord(result.data) || !arrayValue(result.data.data)) return null;
    if (result.data.data.length === 0) return "offline";
    const firstStream = result.data.data[0];
    return isRecord(firstStream) && typeof firstStream.id === "string" ? "online" : null;
  } catch {
    return null;
  }
};

/**
 * Looks up a channel's live state through Helix Get Streams and stores it
 * (`source: 'helix'`) only when `channel_stream_state` has no row for the
 * channel yet -- `writeHelixStreamStateIfUnknown`'s `ON CONFLICT DO NOTHING`
 * means a concurrent EventSub write always wins the race. Once a row exists,
 * this returns it directly and makes no Helix call at all.
 */
export const lookupAndStoreStreamStateIfMissing = async (
  env: Env,
  channelId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredStreamState | null> => {
  const stored = await readChannelStreamState(env.DB, channelId);
  if (stored !== null) return stored;
  const fromHelix = await fetchLiveStreamState(env, channelId, now, fetcher);
  if (fromHelix === null) return null;
  const storedByHelix = await writeHelixStreamStateIfUnknown(env.DB, channelId, fromHelix, now);
  return storedByHelix ? fromHelix : (await readChannelStreamState(env.DB, channelId)) ?? fromHelix;
};

/** Hourly cron task: backfills `channel_stream_state` for channels with no row yet. */
export const maintainMissingStreamStates = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  let channelIds: string[];
  try {
    channelIds = await listChannelIdsWithoutStreamState(env.DB);
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "stream-state", variant: "channels" }, error);
    return;
  }
  for (const channelId of channelIds) await lookupAndStoreStreamStateIfMissing(env, channelId, now, fetcher);
};
