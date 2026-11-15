import type { ModuleAlarmContext, ModuleDurableAction, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { voteWinner } from "./domain/vote-result";
import { isSpotifyTrack, type SpotifyTrack } from "./domain/track";
import {
  createNowPlayingSnapshot,
  createVoteRequestClaim,
  clearSongRequestsForStreamEnd,
  finishVoteWithoutRequest,
  readSongRequest,
  transitionRequest,
  voteRecord,
} from "./adapters/d1";
import type { SongRequestState } from "./adapters/d1";
import { SpotifyRequestError, refreshSpotifyToken, spotifyApiRequest } from "./adapters/spotify";

export const SONG_REQUESTS_ALARM = "poll";
export const SONG_REQUESTS_HANDLER = "poll";
export const SONG_REQUESTS_SUBMIT_HANDLER = "submit";
export const SONG_REQUESTS_LIFECYCLE_HANDLER = "lifecycle";
export const SONG_REQUESTS_ACCESS_TOKEN_HANDLER = "access_token";
export const SONG_REQUESTS_CREDENTIAL_SECRET = "spotify_credentials";
export const SONG_REQUESTS_SUBMIT_ALARM_PREFIX = "submit:";
const POLL_INTERVAL_MS = 12_000;
const BASE_BACKOFF_MS = 24_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
const SUBMITTING_MAX_AGE_MS = 60_000;

interface SpotifyCredentials { accessToken: string; refreshToken: string; expiresAt: number }
const credentialsFrom = (value: string | null): SpotifyCredentials | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const row = parsed as Record<string, unknown>;
    return typeof row.accessToken === "string" && typeof row.refreshToken === "string" && Number.isSafeInteger(row.expiresAt)
      ? { accessToken: row.accessToken, refreshToken: row.refreshToken, expiresAt: row.expiresAt as number } : null;
  } catch { return null; }
};

const setConnectionState = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId">,
  state: string,
  now: string,
  errorMessage: string | null = null,
): Promise<void> => {
  await context.DB.prepare("UPDATE song_requests_connections SET state = ?, error_message = ?, updated_at = ? WHERE channel_id = ?")
    .bind(state, errorMessage, now, context.channelId).run();
};

/** This runs inside ChannelObject only. Worker routes retrieve its result through the DO RPC. */
export const spotifyAccessToken = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "environment" | "secrets">,
  now = Date.now(),
): Promise<string | null> => {
  const stored = await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET);
  const current = credentialsFrom(stored?.value ?? null);
  if (stored === null || current === null) {
    await setConnectionState(context, "not_connected", new Date(now).toISOString());
    return null;
  }
  if (context.environment === undefined) return null;
  if (current.expiresAt > now + 60_000) return current.accessToken;
  try {
    const refreshed = await refreshSpotifyToken(context.environment, current.refreshToken);
    const next: SpotifyCredentials = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? current.refreshToken,
      expiresAt: now + refreshed.expires_in * 1_000,
    };
    if (context.secrets.prepareRotationWrite === undefined) throw new Error("Spotify token rotation is unavailable.");
    const update = await context.secrets.prepareRotationWrite(
      SONG_REQUESTS_CREDENTIAL_SECRET,
      JSON.stringify(next),
      stored.version,
      new Date(now).toISOString(),
    );
    const result = await context.DB.batch([update]);
    if ((result[0]?.meta.changes ?? 0) !== 1) {
      const latest = credentialsFrom((await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET))?.value ?? null);
      if (latest === null) {
        await setConnectionState(context, "not_connected", new Date(now).toISOString());
        return null;
      }
      if (latest.expiresAt <= now + 60_000) throw new Error("Spotify token rotation lost its version claim and the stored token is stale.");
      await setConnectionState(context, "connected", new Date(now).toISOString());
      return latest.accessToken;
    }
    await setConnectionState(context, "connected", new Date(now).toISOString());
    return next.accessToken;
  } catch (error) {
    if (error instanceof SpotifyRequestError && error.reason === "invalid_grant") {
      const latestStored = await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET);
      const latest = credentialsFrom(latestStored?.value ?? null);
      if (latestStored !== null && latestStored.version !== stored.version && latest !== null && latest.expiresAt > now + 60_000) {
        await setConnectionState(context, "connected", new Date(now).toISOString());
        return latest.accessToken;
      }
      await setConnectionState(context, "reconnect_required", new Date(now).toISOString());
      return null;
    }
    throw error;
  }
};

const connectionStateFor = (error: SpotifyRequestError): string | null => {
  if (error.status === 404 && error.reason === "NO_ACTIVE_DEVICE") return "no_active_device";
  if (error.status === 403 && error.reason === "PREMIUM_REQUIRED") return "premium_required";
  if (error.status === 403) return "spotify_error";
  if (error.reason === "invalid_grant") return "reconnect_required";
  return null;
};

const updateConnectionForError = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId">,
  error: SpotifyRequestError,
): Promise<void> => {
  const state = connectionStateFor(error);
  if (state !== null) {
    const message = state === "spotify_error" ? error.message.slice(0, 200) : null;
    await setConnectionState(context, state, new Date().toISOString(), message);
  }
};

const submitRequest = async (context: ModuleAlarmContext, requestId: string): Promise<void> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || row.state !== "approved") return;
  const now = new Date().toISOString();
  const module = await context.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ enabled: number }>();
  if (module?.enabled !== 1) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "approved", toState: "rejected",
      failureReason: "module_disabled", now,
    });
    return;
  }
  const stream = await context.streamStartedAt();
  if (await context.streamState() !== "online" || row.streamId === null || stream.streamId !== row.streamId) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "approved", toState: "rejected",
      failureReason: "stream_offline", now,
    });
    return;
  }
  if (!await transitionRequest(context.DB, { channelId: context.channelId, requestId, fromState: "approved", toState: "submitting", now })) return;
  const environment = context.environment;
  if (environment === undefined) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "spotify_not_configured", now: new Date().toISOString(),
    });
    return;
  }
  let token: string | null;
  try { token = await spotifyAccessToken(context); } catch {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "token_refresh_failed", now: new Date().toISOString(),
    });
    return;
  }
  if (token === null) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "reconnect_required", now: new Date().toISOString(),
    });
    return;
  }
  const enqueue = (): Promise<Response> => spotifyApiRequest(
    environment,
    token as string,
    `me/player/queue?uri=${encodeURIComponent(row.uri)}`,
    { method: "POST" },
  );
  try {
    await enqueue();
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "submitted",
      now: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof SpotifyRequestError)) {
      await transitionRequest(context.DB, {
        channelId: context.channelId, requestId, fromState: "submitting", toState: "outcome_unknown",
        failureReason: "network_or_timeout", now: new Date().toISOString(),
      });
      return;
    }
    await updateConnectionForError(context, error);
    if (error.status >= 500) {
      await transitionRequest(context.DB, {
        channelId: context.channelId, requestId, fromState: "submitting", toState: "outcome_unknown",
        failureReason: "spotify_server_error", now: new Date().toISOString(),
      });
      return;
    }
    if (error.status === 429) {
      if (error.retryAfterMs !== null && error.retryAfterMs <= 2_000) {
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 0));
        try {
          await enqueue();
          await transitionRequest(context.DB, {
            channelId: context.channelId, requestId, fromState: "submitting", toState: "submitted",
            now: new Date().toISOString(),
          });
          return;
        } catch (retryError) {
          if (retryError instanceof SpotifyRequestError) await updateConnectionForError(context, retryError);
          if (!(retryError instanceof SpotifyRequestError) || retryError.status >= 500) {
            await transitionRequest(context.DB, {
              channelId: context.channelId, requestId, fromState: "submitting", toState: "outcome_unknown",
              failureReason: "retry_response_uncertain", now: new Date().toISOString(),
            });
            return;
          }
        }
      }
      await transitionRequest(context.DB, {
        channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
        failureReason: "rate_limited", now: new Date().toISOString(),
      });
      return;
    }
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: error.status === 403 && error.reason !== "PREMIUM_REQUIRED" ? error.message.slice(0, 200)
        : error.reason ?? `spotify_${error.status}`,
      now: new Date().toISOString(),
    });
  }
};

const failureMessage = (reason: string | null): { de: string; en: string } => {
  if (reason === "stream_offline") return {
    de: "Der Stream ist offline; der Song wurde nicht in Spotify eingereiht.",
    en: "The stream is offline; the song was not queued in Spotify.",
  };
  if (reason === "outcome_unknown" || reason === "network_or_timeout" || reason === "spotify_server_error" || reason === "retry_response_uncertain" || reason === "submit_interrupted") return {
    de: `Das Spotify-Ergebnis ist unklar${reason === null ? "" : ` (${reason})`}; bitte die Warteschlange prüfen.`,
    en: `The Spotify result is unclear${reason === null ? "" : ` (${reason})`}; check the queue before retrying.`,
  };
  const detail = reason ?? "unknown";
  return {
    de: `Der Song wurde nicht in Spotify eingereiht: ${detail}.`,
    en: `The song was not queued in Spotify: ${detail}.`,
  };
};

const announceSubmitResult = async (context: ModuleAlarmContext, requestId: string): Promise<void> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || row.state === "approved" || row.state === "submitting") return;
  const language = await context.channelLanguage();
  const message = row.state === "submitted"
    ? language === "de"
      ? `„${row.title}“ wurde in Spotify eingereiht.`
      : `“${row.title}” was queued in Spotify.`
    : failureMessage(row.failureReason)[language];
  const delivery = await context.sendChat(
    message,
    `song-vote-queue:${row.operationId}`,
    undefined,
    undefined,
    undefined,
    { automated: true },
  );
  if (delivery.retryable) throw new Error("The song queue result is waiting for chat delivery.");
};

export const handleSubmitAlarm = async (context: ModuleAlarmContext, alarmKey: string): Promise<void> => {
  if (!alarmKey.startsWith(SONG_REQUESTS_SUBMIT_ALARM_PREFIX)) return;
  const requestId = alarmKey.slice(SONG_REQUESTS_SUBMIT_ALARM_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) return;
  const request = await readSongRequest(context.DB, context.channelId, requestId);
  if (request === null) return;
  if (request.state === "approved") await submitRequest(context, requestId);
  await announceSubmitResult(context, requestId);
};

const scheduleSubmitAlarm = async (context: ModuleAlarmContext, requestId: string, deadline = Date.now()): Promise<void> => {
  await context.schedule(
    `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`,
    deadline,
    undefined,
    null,
    undefined,
    undefined,
    SONG_REQUESTS_SUBMIT_HANDLER,
  );
};

export const handleSongRequestDurableAction = async (context: ModuleAlarmContext, action: ModuleDurableAction): Promise<void> => {
  if (action.kind !== "chat_vote.result") return;
  let vote = await voteRecord(context.DB, context.channelId, action.ballotId);
  if (vote === null) return;
  if (vote.state === "open") {
    const winner = voteWinner(action.counts);
    if (winner === null) {
      const zero = action.counts.every((count) => count === 0);
      await finishVoteWithoutRequest(context.DB, context.channelId, action.ballotId, zero ? "no_votes" : "tie", action.closedAt);
      return;
    }
    const track = vote.candidates[winner];
    if (track === undefined) return;
    const currentStream = await context.streamStartedAt();
    const online = await context.streamState() === "online" && currentStream.streamId !== null && currentStream.streamId === vote.streamId;
    const requestId = crypto.randomUUID();
    await createVoteRequestClaim(context.DB, {
      channelId: context.channelId,
      ballotId: action.ballotId,
      moderatorUserId: "system",
      track,
      streamId: vote.streamId,
      requestId,
      now: action.closedAt,
      initialState: online ? "approved" : "rejected",
      failureReason: online ? null : "stream_offline",
    });
    vote = await voteRecord(context.DB, context.channelId, action.ballotId);
  }
  if (vote?.state === "queued" && vote.requestId !== null) await scheduleSubmitAlarm(context, vote.requestId);
};

const notifyNowPlaying = async (context: Pick<ModuleAlarmContext, "publishModuleOverlayMessage">, revision: number): Promise<void> => {
  await context.publishModuleOverlayMessage("state_changed", "song_requests.now_playing", { revision });
};

const ageSubmittingRequests = async (context: ModuleAlarmContext, now: number): Promise<void> => {
  const cutoff = new Date(now - SUBMITTING_MAX_AGE_MS).toISOString();
  const rows = await context.DB.prepare(
    "SELECT id FROM song_requests WHERE channel_id = ? AND state = 'submitting' AND updated_at < ? ORDER BY updated_at, id",
  ).bind(context.channelId, cutoff).all<{ id: string }>();
  for (const row of rows.results) {
    const changed = await transitionRequest(context.DB, {
      channelId: context.channelId,
      requestId: row.id,
      fromState: "submitting",
      toState: "outcome_unknown",
      failureReason: "submit_interrupted",
      now: new Date(now).toISOString(),
      expectedUpdatedBefore: cutoff,
    });
    if (changed) await scheduleSubmitAlarm(context, row.id);
  }
};

const recordPollFailure = async (context: ModuleAlarmContext, priorFailures: number, error?: unknown): Promise<void> => {
  const failures = Math.min(priorFailures + 1, 8);
  let delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
  if (error instanceof SpotifyRequestError) {
    await updateConnectionForError(context, error);
    if (error.status === 429 && error.retryAfterMs !== null) delay = Math.min(MAX_BACKOFF_MS, Math.max(delay, error.retryAfterMs));
  }
  const now = Date.now();
  await context.DB.prepare(
    `INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at, poll_failures)
     VALUES (?, 'not_connected', NULL, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET poll_failures = excluded.poll_failures, updated_at = excluded.updated_at`,
  ).bind(context.channelId, new Date(now).toISOString(), failures).run();
  await context.schedule(SONG_REQUESTS_ALARM, now + delay, undefined, context.streamGeneration);
};

export const pollSongRequestsPlayback = async (context: ModuleAlarmContext): Promise<void> => {
  const now = Date.now();
  await ageSubmittingRequests(context, now);
  if (await context.streamState() !== "online") return;
  const module = await context.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ enabled: number }>();
  if (module?.enabled !== 1) return;
  const connection = await context.DB.prepare("SELECT state, poll_failures FROM song_requests_connections WHERE channel_id = ?")
    .bind(context.channelId).first<{ state: string; poll_failures: number }>();
  const stream = await context.streamStartedAt();
  if (stream.streamId === null || context.environment === undefined) {
    await recordPollFailure(context, connection?.poll_failures ?? 0);
    return;
  }
  if (connection?.state !== "connected") {
    await recordPollFailure(context, connection?.poll_failures ?? 0);
    return;
  }
  try {
    const token = await spotifyAccessToken(context, now);
    const currentConnection = await context.DB.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string }>();
    if (token === null || currentConnection?.state !== "connected") {
      await recordPollFailure(context, connection?.poll_failures ?? 0);
      return;
    }
    const response = await spotifyApiRequest(context.environment, token, "me/player/currently-playing");
    let track: SpotifyTrack | null = null;
    let progressMs: number | null | undefined;
    if (response.status !== 204) {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const row = payload as Record<string, unknown>;
        const item = row.item;
        if (isSpotifyTrack(item)) track = item;
        progressMs = Number.isSafeInteger(row.progress_ms) && (row.progress_ms as number) >= 0 ? row.progress_ms as number : undefined;
      }
    } else {
      progressMs = null;
    }
    const snapshot = await createNowPlayingSnapshot(context.DB, context.channelId, stream.streamId, track, new Date(now).toISOString(), progressMs);
    await setConnectionState(context, "connected", new Date(now).toISOString());
    await context.DB.prepare("UPDATE song_requests_connections SET poll_failures = 0 WHERE channel_id = ? AND poll_failures > 0")
      .bind(context.channelId).run();
    if (snapshot.changed) await notifyNowPlaying(context, snapshot.revision);
    await context.schedule(SONG_REQUESTS_ALARM, Date.now() + POLL_INTERVAL_MS, undefined, context.streamGeneration);
  } catch (error) {
    await recordPollFailure(context, connection?.poll_failures ?? 0, error);
  }
};

export const handleSongRequestsActivation = async (context: ModuleAlarmContext, enabled: boolean): Promise<void> => {
  if (!enabled) {
    const rows = await context.DB.prepare(
      `SELECT id, state FROM song_requests WHERE channel_id = ?
        AND state IN ('pending_review', 'approved', 'submitting', 'outcome_unknown') ORDER BY created_at, id`,
    ).bind(context.channelId).all<{ id: string; state: SongRequestState }>();
    for (const row of rows.results) {
      const toState: SongRequestState = row.state === "pending_review" || row.state === "approved" ? "rejected" : "failed";
      await transitionRequest(context.DB, {
        channelId: context.channelId,
        requestId: row.id,
        fromState: row.state,
        toState,
        failureReason: "module_disabled",
        now: new Date().toISOString(),
      });
    }
    await context.clear(SONG_REQUESTS_ALARM);
    return;
  }
  if (await context.streamState() === "online") {
    await context.schedule(SONG_REQUESTS_ALARM, Date.now() + POLL_INTERVAL_MS, undefined, context.streamGeneration);
  }
};

export const handleSongRequestsLifecycleAlarm = async (
  context: ModuleAlarmContext,
  _alarmKey: string,
  _deadline: number,
  _ownerRevision: number | undefined,
  invocation?: unknown,
): Promise<void> => {
  if (typeof invocation !== "object" || invocation === null || typeof (invocation as Record<string, unknown>).enabled !== "boolean") return;
  await handleSongRequestsActivation(context, (invocation as Record<string, unknown>).enabled as boolean);
};

export const readSpotifyAccessTokenAlarm = async (context: ModuleAlarmContext): Promise<string | null> => await spotifyAccessToken(context);

export const processSongRequestsEvent = async (event: ModuleEvent, context: ModuleExecutionContext): Promise<ModuleResult> => {
  if (!event.streamStateTransitionAccepted) return { actions: [], diagnostics: [] };
  const actions: ModuleResult["actions"][number][] = [];
  if (event.subscriptionType === "stream.online") {
    const enabled = await context.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(event.channelId).first<{ enabled: number }>();
    if (enabled?.enabled === 1) {
      await context.scheduleAlarm?.(SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + POLL_INTERVAL_MS);
    }
  } else if (event.subscriptionType === "stream.offline") {
    await context.clearAlarm?.(SONG_REQUESTS_ALARM);
    const streamId = context.streamSession?.streamId ?? null;
    const cleared = await clearSongRequestsForStreamEnd(context.DB, event.channelId, streamId, event.receivedAt);
    if (cleared.changed) actions.push({ kind: "overlay", type: "state_changed", elementKind: "song_requests.now_playing", payload: { revision: cleared.revision } });
  }
  return { actions, diagnostics: [] };
};

