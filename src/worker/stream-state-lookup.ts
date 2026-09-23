import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import {
  hasActiveStreamEventSubCoverage,
  readChannelStreamState,
  refreshHelixStreamState,
  writeHelixStreamStateIfUnknown,
  type StoredStreamState,
  type StoredStreamStateRecord,
} from "./db/stream-state";
import { listChannelIdsNeedingStreamStateRefresh } from "./db/channels";
import { clearStreamEndChannelControls } from "./db/channel-controls";
import { logMaintenanceError } from "./bot-maintenance";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arrayValue = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * A channel without active stream EventSub coverage cannot keep its stored
 * state current from events. Ten minutes bounds how stale a Helix guess is
 * allowed to get before the next read pays for a fresh Helix call.
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

const isStaleHelixRow = (row: StoredStreamStateRecord, now: string): boolean =>
  row.source === "helix" && Date.parse(now) - Date.parse(row.changedAt) >= HELIX_STREAM_STATE_TTL_MS;

const asResult = (stored: StoredStreamStateRecord | null, rateLimited = false): StreamStateLookupResult => ({
  state: stored?.state ?? null,
  startedAt: stored?.startedAt ?? null,
  rateLimited,
});

/**
 * Looks up a channel's live state through Helix Get Streams and stores it
 * (`source: 'helix'`) -- on a first lookup, once a Helix-sourced row has gone
 * stale (`HELIX_STREAM_STATE_TTL_MS`), or when either stream EventSub
 * subscription is no longer active. A fresh Helix row or covered EventSub
 * row is returned as-is, with no Helix call at all.
 *
 * Both writes are conditional: `writeHelixStreamStateIfUnknown`'s
 * `ON CONFLICT DO NOTHING` means a concurrent EventSub write always wins the
 * race on a first lookup, and `refreshHelixStreamState` only takes over an
 * EventSub row while coverage is absent. Its SQL guard prevents concurrent
 * restored coverage and an EventSub write from being clobbered.
 */
export const lookupAndRefreshStreamState = async (
  env: Env,
  channelId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<StreamStateLookupResult> => {
  const stored = await readChannelStreamState(env.DB, channelId);
  const eventSubCoverage = stored?.source === "eventsub"
    ? await hasActiveStreamEventSubCoverage(env.DB, channelId)
    : true;
  const eventSubCoverageLost = stored?.source === "eventsub" && !eventSubCoverage;
  if (stored !== null && !isStaleHelixRow(stored, now) && !eventSubCoverageLost) return asResult(stored);

  const fromHelix = await fetchLiveStreamState(env, channelId, now, fetcher);
  if (fromHelix === "rate_limited") return asResult(stored, true);
  if (fromHelix === null) return asResult(stored);

  if (stored === null) {
    const storedByHelix = await writeHelixStreamStateIfUnknown(env.DB, channelId, fromHelix.state, now, fromHelix.startedAt);
    if (storedByHelix) return asResult({ state: fromHelix.state, source: "helix", changedAt: now, startedAt: fromHelix.startedAt });
    return asResult(await readChannelStreamState(env.DB, channelId));
  }

  const refreshed = await refreshHelixStreamState(env.DB, channelId, fromHelix.state, now, fromHelix.startedAt);
  if (refreshed && stored.state === "online" && fromHelix.state === "offline") {
    await clearStreamEndChannelControls(env.DB, channelId, now);
  }
  return asResult(await readChannelStreamState(env.DB, channelId));
};

/** Hourly cron task: backfills missing states, refreshes stale Helix rows,
 *  and moves uncovered EventSub rows to Helix polling. */
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
