import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import {
  readChannelStreamState,
  refreshHelixStreamState,
  writeHelixStreamStateIfUnknown,
  type StoredStreamState,
  type StoredStreamStateRecord,
} from "./db/stream-state";
import { listChannelIdsNeedingStreamStateRefresh } from "./db/channels";
import { prepareResetChannelVariablesForStream } from "./db/channel-variables";
import { logMaintenanceError } from "./bot-maintenance";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arrayValue = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * Ten minutes bounds how stale any stored stream state may get before the
 * next read pays for a fresh Helix check.
 */
const HELIX_STREAM_STATE_TTL_MS = 10 * 60 * 1000;

/** Cron cap (#178): oldest rows are refreshed first so a large backlog is
 *  spread across ticks without starving later channel ids. */
const MAX_STREAM_STATE_REFRESHES_PER_TICK = 50;

export interface StreamStateLookupResult {
  state: StoredStreamState | null;
  startedAt: string | null;
  /** Twitch is rate-limiting this app token; the caller should stop issuing further Helix calls this tick. */
  rateLimited: boolean;
}

type HelixStreamLookup = { state: StoredStreamState; startedAt: string | null };

const fetchLiveStreamState = async (
  env: Env,
  channelId: string,
  now: string,
  fetcher: typeof fetch,
): Promise<HelixStreamLookup | "rate_limited" | null> => {
  try {
    const accessToken = await getAppAccessToken(env, now, fetcher);
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: channelId, type: "live" },
      accessToken,
      clientId: env.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok) return result.reason === "rate_limited" ? "rate_limited" : null;
    if (!isRecord(result.data) || !arrayValue(result.data.data)) return null;
    if (result.data.data.length === 0) return { state: "offline", startedAt: null };
    const firstStream = result.data.data[0];
    if (!isRecord(firstStream) || typeof firstStream.id !== "string") return null;
    const startedAt = typeof firstStream.started_at === "string" ? firstStream.started_at : null;
    return { state: "online", startedAt };
  } catch {
    return null;
  }
};

const isStaleRow = (row: StoredStreamStateRecord, now: string): boolean =>
  Date.parse(now) - Date.parse(row.checkedAt ?? row.changedAt) >= HELIX_STREAM_STATE_TTL_MS;

const asResult = (stored: StoredStreamStateRecord | null, rateLimited = false): StreamStateLookupResult => ({
  state: stored?.state ?? null,
  startedAt: stored?.startedAt ?? null,
  rateLimited,
});

/**
 * Looks up a channel's live state through Helix Get Streams and stores it
 * (`source: 'helix'`) -- on a first lookup or once any stored row has gone
 * stale (`HELIX_STREAM_STATE_TTL_MS`). A fresh row is returned as-is, with
 * no Helix call at all.
 *
 * Both writes are conditional: `writeHelixStreamStateIfUnknown`'s
 * `ON CONFLICT DO NOTHING` means a concurrent EventSub write always wins the
 * race on a first lookup. Refresh writes only use timestamp ordering, so a
 * newer EventSub transition wins over a poll already in flight.
 */
export const lookupAndRefreshStreamState = async (
  env: Env,
  channelId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<StreamStateLookupResult> => {
  const stored = await readChannelStreamState(env.DB, channelId);
  if (stored !== null && !isStaleRow(stored, now)) return asResult(stored);

  const fromHelix = await fetchLiveStreamState(env, channelId, now, fetcher);
  if (fromHelix === "rate_limited") return asResult(stored, true);
  if (fromHelix === null) return asResult(stored);

  if (stored === null) {
    const storedByHelix = await writeHelixStreamStateIfUnknown(env.DB, channelId, fromHelix.state, now, fromHelix.startedAt);
    if (storedByHelix) return asResult({
      state: fromHelix.state,
      source: "helix",
      changedAt: now,
      startedAt: fromHelix.startedAt,
      checkedAt: now,
    });
    return asResult(await readChannelStreamState(env.DB, channelId));
  }

  await refreshHelixStreamState(env.DB, channelId, fromHelix.state, now, fromHelix.startedAt);
  if (stored.state === "offline" && fromHelix.state === "online" && fromHelix.startedAt !== null) {
    await prepareResetChannelVariablesForStream(env.DB, channelId, fromHelix.startedAt, now);
  }
  return asResult(await readChannelStreamState(env.DB, channelId));
};

/** Hourly cron task: backfills missing states and refreshes any stale row. */
export const maintainStreamStates = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  let channelIds: string[];
  try {
    channelIds = await listChannelIdsNeedingStreamStateRefresh(
      env.DB,
      now,
      HELIX_STREAM_STATE_TTL_MS / 1000,
      MAX_STREAM_STATE_REFRESHES_PER_TICK,
    );
  } catch (error: unknown) {
    logMaintenanceError({ channelId: "global", subscriptionType: "stream-state", variant: "channels" }, error);
    return;
  }
  for (const channelId of channelIds) {
    const result = await lookupAndRefreshStreamState(env, channelId, now, fetcher);
    // Twitch is already rate-limiting this app token -- further calls this
    // tick would only make it worse. The next hourly tick resumes.
    if (result.rateLimited) break;
  }
};
