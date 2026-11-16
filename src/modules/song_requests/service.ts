import type { ModuleAlarmContext, ModuleChannelPointsAccess, ModuleChannelPointsStatus, ModuleDurableAction, ModuleEvent, ModuleExecutionContext, ModuleResult, ModulePointsAccess } from "../contract";
import { voteWinner } from "./domain/vote-result";
import { isSpotifyTrack, spotifyTrackIdFromInput, type SpotifyTrack } from "./domain/track";
import { canUseFreeSongRequest, isOpenSongRequestState } from "./domain/rules";
import { songRequestsSettingsSchema, type SongRequestsSettings } from "./contracts";
import { songRequestChatTexts } from "./chat-locale";
import {
  admitSongRequest,
  closeOfflineSongRequestRound,
  createNowPlayingSnapshot,
  createVoteRequestClaim,
  cleanupSongRequestRound,
  clearSongRequestsForStreamEnd,
  ensureOfflineSongRequestRound,
  finishVoteWithoutRequest,
  readOfflineSongRequestRound,
  readSongRequest,
  clearSongRequestChannelPointResolution,
  songRequestChannelPointResolutionDue,
  markSongRequestRefundDue,
  markSongRequestRefundComplete,
  songRequestRefundDueIds,
  songRequestRefundIsDue,
  songRequestAdmissionFailure,
  spotifySlotHeld,
  songRequestTrackFromSpotify,
  transitionRequest,
  voteRecord,
} from "./adapters/d1";
import type { SongRequestRow, SongRequestState } from "./adapters/d1";
import { SpotifyRequestError, refreshSpotifyToken, spotifyApiRequest, spotifySearchTracks, spotifyTrackById } from "./adapters/spotify";
import { readSongRequestQueueState } from "./overlay/queue-state";

export const songRequestQueueOverlayPayload = readSongRequestQueueState;

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
const IN_FLIGHT_MAX_AGE_MS = 60_000;
const OFFLINE_POLL_INTERVAL_MS = 60_000;
const CHANNEL_POINT_RESOLUTION_RETRY_MS = 15_000;

const scheduleAlarmIfEarlier = async (
  context: ModuleAlarmContext,
  ...args: Parameters<ModuleAlarmContext["schedule"]>
): Promise<void> => {
  await (context.scheduleIfEarlier ?? context.schedule)(...args);
};

const scheduleEventAlarmIfEarlier = async (
  context: ModuleExecutionContext,
  ...args: Parameters<ModuleExecutionContext["scheduleAlarm"]>
): Promise<void> => {
  await (context.scheduleAlarmIfEarlier ?? context.scheduleAlarm)(...args);
};

const deliverChannelPointResolutionObligations = async (
  db: D1Database,
  channelId: string,
  channelPoints: ModuleChannelPointsAccess | undefined,
): Promise<boolean> => {
  const due = await songRequestChannelPointResolutionDue(db, channelId);
  if (due.length === 0) return false;
  if (channelPoints === undefined) return true;
  let retry = false;
  for (const obligation of due) {
    try {
      if (await channelPoints.resolveRedemption(obligation.operationId, obligation.status)) {
        await clearSongRequestChannelPointResolution(db, channelId, obligation.requestId, obligation.status);
      } else retry = true;
    } catch {
      retry = true;
    }
  }
  return retry || (await songRequestChannelPointResolutionDue(db, channelId, 1)).length > 0;
};

const flushChannelPointResolutions = async (context: ModuleAlarmContext): Promise<void> => {
  const pending = await deliverChannelPointResolutionObligations(context.DB, context.channelId, context.channelPoints);
  if (pending) {
    await scheduleAlarmIfEarlier(context,
      "channel-point-resolutions",
      Date.now() + CHANNEL_POINT_RESOLUTION_RETRY_MS,
      undefined,
      null,
      undefined,
      undefined,
      SONG_REQUESTS_LIFECYCLE_HANDLER,
    );
  } else {
    await context.clear("channel-point-resolutions");
  }
};

const scheduleChannelPointResolutionRetry = async (context: ModuleAlarmContext): Promise<void> => {
  await scheduleAlarmIfEarlier(context,
    "channel-point-resolutions",
    Date.now() + CHANNEL_POINT_RESOLUTION_RETRY_MS,
    undefined,
    null,
    undefined,
    undefined,
    SONG_REQUESTS_LIFECYCLE_HANDLER,
  );
};

const flushChannelPointResolutionsFromEvent = async (context: ModuleExecutionContext): Promise<void> => {
  const channelId = context.channelId;
  if (channelId === undefined) return;
  const pending = await deliverChannelPointResolutionObligations(context.DB, channelId, context.channelPoints);
  if (pending) {
    await scheduleEventAlarmIfEarlier(context,
      SONG_REQUESTS_LIFECYCLE_HANDLER,
      "channel-point-resolutions",
      Date.now() + CHANNEL_POINT_RESOLUTION_RETRY_MS,
      undefined,
      null,
    );
  } else {
    await context.clearAlarm("channel-point-resolutions");
  }
};

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
  await context.DB.prepare(
    `UPDATE song_requests_connections SET state = ?, error_message = ?, updated_at = ?
      WHERE channel_id = ? AND (state IS NOT ? OR error_message IS NOT ?)`,
  ).bind(state, errorMessage, now, context.channelId, state, errorMessage).run();
};

/** This runs inside ChannelObject only. Worker routes retrieve its result through the DO RPC. */
export const spotifyAccessToken = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "environment" | "secrets">,
  now = Date.now(),
): Promise<string | null> => {
  if (!await spotifySlotHeld(context.DB, context.channelId)) {
    await setConnectionState(context, "not_connected", new Date(now).toISOString());
    return null;
  }
  const stored = await context.secrets.readWithVersion(SONG_REQUESTS_CREDENTIAL_SECRET);
  const current = credentialsFrom(stored?.value ?? null);
  if (stored === null || current === null) {
    await setConnectionState(context, "not_connected", new Date(now).toISOString());
    return null;
  }
  if (context.environment === undefined) return null;
  if (current.expiresAt > now + 60_000) {
    if (!await spotifySlotHeld(context.DB, context.channelId)) {
      await setConnectionState(context, "not_connected", new Date(now).toISOString());
      return null;
    }
    return current.accessToken;
  }
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
    if (!await spotifySlotHeld(context.DB, context.channelId)) {
      await setConnectionState(context, "not_connected", new Date(now).toISOString());
      return null;
    }
    if ((result[0]?.meta.changes ?? 0) < 1) {
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
    if (!await spotifySlotHeld(context.DB, context.channelId)) {
      await setConnectionState(context, "not_connected", new Date(now).toISOString());
      return null;
    }
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

const requestRoundIsCurrent = async (
  db: D1Database,
  channelId: string,
  row: { streamId: string | null; roundId: string | null },
): Promise<boolean> => {
  if (row.roundId === null) return false;
  const [stream, module, offlineRound] = await Promise.all([
    db.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null }>(),
    db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1")
      .bind(channelId).first<{ settings: string }>(),
    db.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(channelId).first<{ round_id: string }>(),
  ]);
  if (stream?.state === "online") return stream.stream_id !== null && row.streamId === stream.stream_id && row.roundId === stream.stream_id;
  if (stream?.state !== "offline" || row.streamId !== null || offlineRound?.round_id !== row.roundId || module === null) return false;
  try {
    return songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown).alsoOffline;
  } catch {
    return false;
  }
};

/** Live rows also have to match the host's live stream view; offline rounds only exist in D1. */
const roundIsCurrentForSubmit = async (
  context: ModuleAlarmContext,
  row: { streamId: string | null; roundId: string | null },
): Promise<boolean> => {
  if (row.streamId !== null) {
    const stream = await context.streamStartedAt();
    if (await context.streamState() !== "online" || stream.streamId !== row.streamId) return false;
  }
  return await requestRoundIsCurrent(context.DB, context.channelId, row);
};

/**
 * Re-checks claim, activation, slot and live stream in one statement. The update is a value no-op, so no panel
 * revision trigger fires and meta.changes is exactly the number of matched base rows.
 */
export const holdSubmitClaim = async (
  db: D1Database,
  channelId: string,
  requestId: string,
  roundId: string | null,
): Promise<boolean> => {
  if (roundId === null) return false;
  const claim = await db.prepare(
    `UPDATE song_requests SET updated_at = updated_at
      WHERE channel_id = ? AND id = ? AND state = 'submitting' AND round_id = ?
        AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
        )
        AND EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
        AND (
          (song_requests.stream_id = ? AND EXISTS (
            SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?
          )) OR (song_requests.stream_id IS NULL AND EXISTS (
            SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline'
          ) AND EXISTS (
            SELECT 1 FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ?
          ) AND EXISTS (
            SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
              AND json_extract(settings, '$.alsoOffline') = 1
          ))
        )`,
  ).bind(channelId, requestId, roundId, channelId, channelId, roundId, channelId, roundId,
    channelId, channelId, roundId, channelId).run();
  return claim.meta.changes > 0;
};

const scheduleSubmitRetry = async (context: ModuleAlarmContext, requestId: string): Promise<void> => {
  await scheduleAlarmIfEarlier(context,
    `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`,
    Date.now() + CHANNEL_POINT_RESOLUTION_RETRY_MS,
    undefined,
    null,
    undefined,
    undefined,
    SONG_REQUESTS_SUBMIT_HANDLER,
  );
};

const channelPointStatusBeforeSubmit = async (
  context: ModuleAlarmContext,
  row: SongRequestRow,
): Promise<ModuleChannelPointsStatus> => {
  if (row.requestType !== "channel_points") return "UNFULFILLED";
  if (context.channelPoints === undefined) {
    await scheduleSubmitRetry(context, row.requestId);
    return "unavailable";
  }
  try {
    const status = await context.channelPoints.readRedemptionStatus(row.operationId);
    if (status === "unavailable") await scheduleSubmitRetry(context, row.requestId);
    return status;
  } catch {
    await scheduleSubmitRetry(context, row.requestId);
    return "unavailable";
  }
};

const submitClaimStillValid = async (context: ModuleAlarmContext, requestId: string): Promise<boolean> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || row.state !== "submitting") return false;
  const now = new Date().toISOString();
  const module = await context.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ enabled: number }>();
  if (module?.enabled !== 1) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "module_disabled", refundDue: true, now,
    });
    return false;
  }
  if (!await spotifySlotHeld(context.DB, context.channelId)) {
    await setConnectionState(context, "not_connected", now);
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "spotify_not_enabled", refundDue: true, now,
    });
    return false;
  }
  if (!await roundIsCurrentForSubmit(context, row)) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "stream_offline", refundDue: true, now,
    });
    return false;
  }
  const initialTwitchStatus = await channelPointStatusBeforeSubmit(context, row);
  if (initialTwitchStatus !== "UNFULFILLED") {
    if (initialTwitchStatus === "unavailable") {
      await transitionRequest(context.DB, {
        channelId: context.channelId, requestId, fromState: "submitting", toState: "approved",
        now: new Date().toISOString(),
      });
    }
    return false;
  }
  if (await holdSubmitClaim(context.DB, context.channelId, requestId, row.roundId)) {
    const current = await readSongRequest(context.DB, context.channelId, requestId);
    if (current === null || current.state !== "submitting") return false;
    if (await channelPointStatusBeforeSubmit(context, current) === "UNFULFILLED") {
      if (await holdSubmitClaim(context.DB, context.channelId, requestId, current.roundId)) return true;
    } else {
      const latest = await readSongRequest(context.DB, context.channelId, requestId);
      if (latest?.state === "submitting") {
        await transitionRequest(context.DB, {
          channelId: context.channelId, requestId, fromState: "submitting", toState: "approved",
          now: new Date().toISOString(),
        });
      }
      return false;
    }
  }

  const current = await readSongRequest(context.DB, context.channelId, requestId);
  if (current === null || current.state !== "submitting") return false;
  const currentModule = await context.DB.prepare(
    "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'",
  ).bind(context.channelId).first<{ enabled: number }>();
  if (currentModule?.enabled !== 1) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "module_disabled", refundDue: true, now: new Date().toISOString(),
    });
    return false;
  }
  if (!await spotifySlotHeld(context.DB, context.channelId)) {
    const failedAt = new Date().toISOString();
    await setConnectionState(context, "not_connected", failedAt);
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "spotify_not_enabled", refundDue: true, now: failedAt,
    });
    return false;
  }
  if (!await requestRoundIsCurrent(context.DB, context.channelId, current)) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "stream_offline", refundDue: true, now: new Date().toISOString(),
    });
  }
  return false;
};

const transitionAfterSpotifyPost = async (
  context: ModuleAlarmContext,
  requestId: string,
  toState: "submitted" | "outcome_unknown" | "failed",
  failureReason: string | null = null,
  activeRoundId: string | null = null,
): Promise<void> => {
  const now = new Date().toISOString();
  const transitioned = toState === "submitted" && activeRoundId === null ? false : await transitionRequest(context.DB, {
    channelId: context.channelId,
    requestId,
    fromState: "submitting",
    toState,
    failureReason,
    ...(toState === "failed" ? { refundDue: true } : {}),
    now,
    ...(toState === "submitted" && activeRoundId !== null
      ? { activeRoundId }
      : {}),
  });
  if (transitioned) return;
  const current = await readSongRequest(context.DB, context.channelId, requestId);
  if (toState === "submitted" && current?.state === "submitting") {
    await transitionRequest(context.DB, {
      channelId: context.channelId,
      requestId,
      fromState: "submitting",
      toState: "outcome_unknown",
      failureReason: "submit_state_conflict",
      now: new Date().toISOString(),
    });
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
      failureReason: "module_disabled", refundDue: true, now,
    });
    return;
  }
  if (!await roundIsCurrentForSubmit(context, row)) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "approved", toState: "rejected",
      failureReason: "stream_offline", refundDue: true, now,
    });
    return;
  }
  if (await channelPointStatusBeforeSubmit(context, row) !== "UNFULFILLED") return;
  if (!await transitionRequest(context.DB, { channelId: context.channelId, requestId, fromState: "approved", toState: "submitting", now })) return;
  const environment = context.environment;
  if (environment === undefined) {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "spotify_not_configured", refundDue: true, now: new Date().toISOString(),
    });
    return;
  }
  let token: string | null;
  try { token = await spotifyAccessToken(context); } catch {
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason: "token_refresh_failed", refundDue: true, now: new Date().toISOString(),
    });
    return;
  }
  if (token === null) {
    const failureReason = await spotifySlotHeld(context.DB, context.channelId) ? "reconnect_required" : "spotify_not_enabled";
    await transitionRequest(context.DB, {
      channelId: context.channelId, requestId, fromState: "submitting", toState: "failed",
      failureReason, refundDue: true, now: new Date().toISOString(),
    });
    return;
  }
  if (!await submitClaimStillValid(context, requestId)) return;
  const enqueue = (): Promise<Response> => spotifyApiRequest(
    environment,
    token,
    `me/player/queue?uri=${encodeURIComponent(row.uri)}`,
    { method: "POST" },
  );
  try {
    await enqueue();
    await transitionAfterSpotifyPost(context, requestId, "submitted", null, row.roundId);
  } catch (error) {
    if (!(error instanceof SpotifyRequestError)) {
      await transitionAfterSpotifyPost(context, requestId, "outcome_unknown", "network_or_timeout", row.roundId);
      return;
    }
    await updateConnectionForError(context, error);
    if (error.status >= 500) {
      await transitionAfterSpotifyPost(context, requestId, "outcome_unknown", "spotify_server_error", row.roundId);
      return;
    }
    if (error.status === 429) {
      if (error.retryAfterMs !== null && error.retryAfterMs <= 2_000) {
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 0));
        if (!await submitClaimStillValid(context, requestId)) return;
        try {
          await enqueue();
          await transitionAfterSpotifyPost(context, requestId, "submitted", null, row.roundId);
          return;
        } catch (retryError) {
          if (retryError instanceof SpotifyRequestError) await updateConnectionForError(context, retryError);
          if (!(retryError instanceof SpotifyRequestError) || retryError.status >= 500) {
            await transitionAfterSpotifyPost(context, requestId, "outcome_unknown", "retry_response_uncertain", row.roundId);
            return;
          }
        }
      }
      await transitionAfterSpotifyPost(context, requestId, "failed", "rate_limited", row.roundId);
      return;
    }
    await transitionAfterSpotifyPost(context, requestId, "failed",
      error.status === 403 && error.reason !== "PREMIUM_REQUIRED" ? error.message.slice(0, 200)
        : error.reason ?? `spotify_${String(error.status)}`, row.roundId);
  }
};

export const songRequestChargeOperationId = (requestId: string): string => `sr:${requestId}:charge`;
export const songRequestRefundOperationId = (requestId: string): string => `sr:${requestId}:refund`;

const pointOperationAmount = (result: unknown): number | null => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const amount: unknown = Reflect.get(result, "amount");
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

const isSongRequestChargeVoid = (
  operation: { kind: string; result: unknown } | null,
  requestId: string,
): boolean => operation?.kind === "refund" && typeof operation.result === "object" && operation.result !== null &&
  !Array.isArray(operation.result) && Reflect.get(operation.result, "requestId") === requestId &&
  Reflect.get(operation.result, "cancelled") === true && Reflect.get(operation.result, "purpose") === "cancel_charge";

type SongRequestChargeOperation = { kind: "void" } | { kind: "stake"; amount: number };

/** Claims the charge id in the ledger so no later stake can commit under that id. */
const claimSongRequestCharge = async (
  points: ModulePointsAccess,
  requestId: string,
): Promise<SongRequestChargeOperation> => {
  const operationId = songRequestChargeOperationId(requestId);
  try {
    await points.apply(operationId, "refund", [], { requestId, cancelled: true, purpose: "cancel_charge" }, { requestId, purpose: "cancel_charge" });
    return { kind: "void" };
  } catch (error) {
    const existing = await points.getOperation(operationId);
    if (existing?.kind === "stake") {
      const amount = pointOperationAmount(existing.result);
      if (amount === null) throw new Error("song_request_charge_amount_missing", { cause: error });
      return { kind: "stake", amount };
    }
    if (isSongRequestChargeVoid(existing, requestId)) return { kind: "void" };
    throw error;
  }
};

type SongRequestChargeResult = { status: "charged"; amount: number } | { status: "cancelled" } | { status: "failed" };

const chargeSongRequest = async (
  points: ModulePointsAccess,
  row: NonNullable<Awaited<ReturnType<typeof readSongRequest>>>,
): Promise<SongRequestChargeResult> => {
  if (row.requestType !== "bot_points" || row.chargedAmount < 1 || row.requesterUserId === null) return { status: "failed" };
  const operationId = songRequestChargeOperationId(row.requestId);
  try {
    const applied = await points.apply(operationId, "stake", [{
      accountId: row.requesterUserId,
      login: row.requesterLogin ?? row.requesterUserId,
      delta: -row.chargedAmount,
    }, {
      accountId: "__house",
      delta: row.chargedAmount,
    }], { requestId: row.requestId, trackId: row.id, amount: row.chargedAmount }, { requestId: row.requestId });
    const amount = pointOperationAmount(applied.result);
    return amount === null ? { status: "failed" } : { status: "charged", amount };
  } catch (error) {
    const operation = await points.getOperation(operationId);
    if (operation?.kind === "stake") {
      const amount = pointOperationAmount(operation.result);
      return amount === null ? { status: "failed" } : { status: "charged", amount };
    }
    if (isSongRequestChargeVoid(operation, row.requestId)) return { status: "cancelled" };
    if (operation === null) return { status: "failed" };
    throw error;
  }
};

const refundSongRequest = async (
  db: D1Database,
  points: ModulePointsAccess,
  channelId: string,
  row: NonNullable<Awaited<ReturnType<typeof readSongRequest>>>,
): Promise<boolean> => {
  if (row.requestType !== "bot_points") {
    await markSongRequestRefundComplete(db, channelId, row.requestId);
    return true;
  }
  const refundId = songRequestRefundOperationId(row.requestId);
  const existingRefund = await points.getOperation(refundId);
  if (existingRefund !== null) {
    if (existingRefund.kind !== "refund") throw new Error("song_request_refund_operation_conflict");
    await markSongRequestRefundComplete(db, channelId, row.requestId);
    return true;
  }
  const charge = await claimSongRequestCharge(points, row.requestId);
  if (charge.kind === "void") {
    await markSongRequestRefundComplete(db, channelId, row.requestId);
    return true;
  }
  const chargedAmount = charge.amount;
  if (row.requesterUserId === null) throw new Error("song_request_refund_account_missing");
  try {
    await points.apply(refundId, "refund", [{
      accountId: row.requesterUserId,
      login: row.requesterLogin ?? row.requesterUserId,
      delta: chargedAmount,
    }, {
      accountId: "__house",
      delta: -chargedAmount,
    }], { requestId: row.requestId, amount: chargedAmount }, { requestId: row.requestId });
  } catch (error) {
    const completed = await points.getOperation(refundId);
    if (completed === null) throw error;
    if (completed.kind !== "refund") throw new Error("song_request_refund_operation_conflict", { cause: error });
  }
  await markSongRequestRefundComplete(db, channelId, row.requestId);
  return true;
};

const finalizeChargingSongRequest = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "points">,
  requestId: string,
  failureReason: string,
  now: string,
  expectedChargingBefore?: string,
): Promise<{ changed: boolean; charge: SongRequestChargeOperation }> => {
  const charge = await claimSongRequestCharge(context.points, requestId);
  const changed = await transitionRequest(context.DB, {
    channelId: context.channelId,
    requestId,
    fromState: "charging",
    toState: "failed",
    failureReason,
    refundDue: charge.kind === "stake",
    chargedAmount: charge.kind === "stake" ? charge.amount : 0,
    ...(charge.kind === "stake" ? { chargedAt: now } : {}),
    now,
    ...(expectedChargingBefore === undefined ? {} : { expectedChargingBefore }),
  });
  if (charge.kind === "stake") {
    const latest = await readSongRequest(context.DB, context.channelId, requestId);
    if (latest !== null && !isOpenSongRequestState(latest.state) &&
        await songRequestRefundIsDue(context.DB, context.channelId, requestId)) {
      await refundRequestId(context, requestId);
    }
  }
  return { changed, charge };
};

export const refundRequestId = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "points">,
  requestId: string,
): Promise<void> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || isOpenSongRequestState(row.state) || !await songRequestRefundIsDue(context.DB, context.channelId, requestId)) return;
  await refundSongRequest(context.DB, context.points, context.channelId, row);
};

export const retrySongRequestRefunds = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "points">,
  roundId?: string,
): Promise<number> => {
  const dueIds = await songRequestRefundDueIds(context.DB, context.channelId, roundId);
  for (const requestId of dueIds) {
    try { await refundRequestId(context, requestId); } catch { /* The persisted due flag keeps this refund retryable. */ }
  }
  return (await songRequestRefundDueIds(context.DB, context.channelId, roundId)).length;
};

const failureMessage = (reason: string | null): { de: string; en: string } => {
  if (reason === "stream_offline") return {
    de: "Der Stream ist offline; der Song wurde nicht in Spotify eingereiht.",
    en: "The stream is offline; the song was not queued in Spotify.",
  };
  if (reason === "submit_outcome_uncertain") return {
    de: "Der Song könnte in Spotify eingereiht worden sein; bitte prüfe Spotify vor einem erneuten Versuch.",
    en: "The song may have been queued in Spotify; check Spotify before retrying.",
  };
  if (reason === "outcome_unknown" || reason === "network_or_timeout" || reason === "spotify_server_error" || reason === "retry_response_uncertain" || reason === "submit_interrupted" || reason === "submit_state_conflict") return {
    de: `Das Spotify-Ergebnis ist unklar (${reason}); bitte die Warteschlange prüfen.`,
    en: `The Spotify result is unclear (${reason}); check the queue before retrying.`,
  };
  const detail = reason ?? "unknown";
  return {
    de: `Der Song wurde nicht in Spotify eingereiht: ${detail}.`,
    en: `The song was not queued in Spotify: ${detail}.`,
  };
};

const announceSubmitResult = async (context: ModuleAlarmContext, requestId: string): Promise<boolean> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || row.state === "charging" || row.state === "approved" || row.state === "submitting") return false;
  const language = await context.channelLanguage();
  const message = row.state === "submitted"
    ? language === "de"
      ? `„${row.title}“ wurde in Spotify eingereiht.`
      : `“${row.title}” was queued in Spotify.`
    : failureMessage(row.state === "outcome_unknown" ? "outcome_unknown" : row.failureReason)[language];
  const delivery = await context.sendChat(
    message,
    `song-vote-queue:${row.operationId}`,
    undefined,
    undefined,
    undefined,
    { automated: true },
  );
  return delivery.retryable;
};

export const handleSubmitAlarm = async (context: ModuleAlarmContext, alarmKey: string): Promise<undefined | "retry"> => {
  await flushChannelPointResolutions(context);
  if (!alarmKey.startsWith(SONG_REQUESTS_SUBMIT_ALARM_PREFIX)) return;
  const requestId = alarmKey.slice(SONG_REQUESTS_SUBMIT_ALARM_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) return;
  await scheduleChannelPointResolutionRetry(context);
  const request = await readSongRequest(context.DB, context.channelId, requestId);
  if (request === null) return;
  if (request.state === "charging") return;
  if (request.state === "approved") await submitRequest(context, requestId);
  await flushChannelPointResolutions(context);
  const current = await readSongRequest(context.DB, context.channelId, requestId);
  if (current?.state === "failed" || current?.state === "rejected") await refundRequestId(context, requestId);
  if (await announceSubmitResult(context, requestId)) return "retry";
  await notifyQueueOverlay(context);
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
    const roundId = vote.roundId ?? vote.streamId;
    const streamId = vote.streamId;
    const active = roundId !== null && await roundIsCurrentForSubmit(context, { streamId, roundId });
    const requestId = crypto.randomUUID();
    const claimed = await createVoteRequestClaim(context.DB, {
      channelId: context.channelId,
      ballotId: action.ballotId,
      moderatorUserId: "system",
      track,
      streamId,
      roundId,
      requestId,
      now: action.closedAt,
      ...(active ? { activeRoundId: roundId } : {}),
      initialState: active ? "approved" : "rejected",
      failureReason: active ? null : "stream_offline",
    });
    if (!claimed) {
      const current = await voteRecord(context.DB, context.channelId, action.ballotId);
      if (current?.state === "open") await finishVoteWithoutRequest(context.DB, context.channelId, action.ballotId, "failed", action.closedAt);
    }
    vote = await voteRecord(context.DB, context.channelId, action.ballotId);
  }
  if (vote?.state === "queued" && vote.requestId !== null) await scheduleSubmitAlarm(context, vote.requestId);
};

const notifyNowPlaying = async (context: Pick<ModuleAlarmContext, "publishModuleOverlayMessage">, revision: number): Promise<void> => {
  await context.publishModuleOverlayMessage("state_changed", "song_requests.now_playing", { revision });
};

export const reconcileStaleSongRequestCharges = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "points">,
  now = Date.now(),
  roundId?: string,
): Promise<number> => {
  const cutoff = new Date(now - IN_FLIGHT_MAX_AGE_MS).toISOString();
  const roundFilter = roundId === undefined ? "" : " AND round_id = ?";
  const statement = context.DB.prepare(
    `SELECT id FROM song_requests WHERE channel_id = ? AND state = 'charging' AND charging_since < ?${roundFilter}
      ORDER BY charging_since, id`,
  );
  const rows = await (roundId === undefined ? statement.bind(context.channelId, cutoff) : statement.bind(context.channelId, cutoff, roundId))
    .all<{ id: string }>();
  let reconciled = 0;
  for (const row of rows.results) {
    const timestamp = new Date(now).toISOString();
    let finalized: Awaited<ReturnType<typeof finalizeChargingSongRequest>>;
    try { finalized = await finalizeChargingSongRequest(context, row.id, "charge_interrupted", timestamp, cutoff); }
    catch { continue; }
    if (finalized.changed) reconciled += 1;
  }
  return reconciled;
};

const hasFreshChargingSongRequests = async (db: D1Database, channelId: string, now = Date.now()): Promise<boolean> => {
  const cutoff = new Date(now - IN_FLIGHT_MAX_AGE_MS).toISOString();
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND state = 'charging' AND charging_since >= ?",
  ).bind(channelId, cutoff).first<{ count: number }>();
  return (row?.count ?? 0) > 0;
};

const scheduleFreshChargingReconciliation = async (context: ModuleAlarmContext, now = Date.now()): Promise<boolean> => {
  if (!await hasFreshChargingSongRequests(context.DB, context.channelId, now)) return false;
  await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, now + IN_FLIGHT_MAX_AGE_MS, undefined, null);
  return true;
};

const ageSubmittingRequests = async (context: ModuleAlarmContext, now: number): Promise<void> => {
  const cutoff = new Date(now - IN_FLIGHT_MAX_AGE_MS).toISOString();
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

const recordPollFailure = async (
  context: ModuleAlarmContext,
  priorFailures: number,
  error?: unknown,
  streamGeneration: number | null | undefined = context.streamGeneration,
  baseBackoffMs = BASE_BACKOFF_MS,
): Promise<void> => {
  const failures = Math.min(priorFailures + 1, 8);
  let delay = Math.min(MAX_BACKOFF_MS, baseBackoffMs * 2 ** (failures - 1));
  if (error instanceof SpotifyRequestError) {
    await updateConnectionForError(context, error);
    if (error.status === 429 && error.retryAfterMs !== null) delay = Math.max(delay, error.retryAfterMs);
  }
  const now = Date.now();
  await context.DB.prepare(
    `INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at, poll_failures)
     VALUES (?, 'not_connected', NULL, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET poll_failures = excluded.poll_failures, updated_at = excluded.updated_at`,
  ).bind(context.channelId, new Date(now).toISOString(), failures).run();
  await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, now + delay, undefined, streamGeneration);
};

const reconcileApprovedSubmissionAlarms = async (context: ModuleAlarmContext): Promise<void> => {
  const rows = await context.DB.prepare(
    "SELECT id FROM song_requests WHERE channel_id = ? AND state = 'approved' ORDER BY created_at, id",
  ).bind(context.channelId).all<{ id: string }>();
  for (const row of rows.results) {
    const alarmKey = `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${row.id}`;
    if (context.getAlarmDeadline !== undefined && await context.getAlarmDeadline(alarmKey) !== null) continue;
    await scheduleSubmitAlarm(context, row.id);
  }
};

const playbackCycleIsCurrent = async (context: ModuleAlarmContext, roundId: string): Promise<boolean> => {
  const [stream, offlineRound, slotHeld] = await Promise.all([
    context.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string; stream_id: string | null }>(),
    readOfflineSongRequestRound(context.DB, context.channelId),
    spotifySlotHeld(context.DB, context.channelId),
  ]);
  if (!slotHeld) return false;
  return await requestRoundIsCurrent(context.DB, context.channelId, {
    streamId: stream?.state === "online" ? stream.stream_id : null,
    roundId: stream?.state === "online" ? stream.stream_id : offlineRound,
  }) && (stream?.state !== "online" || stream.stream_id === roundId) && (stream?.state !== "offline" || offlineRound === roundId);
};

export const pollSongRequestsPlayback = async (
  context: ModuleAlarmContext,
  _alarmKey?: string,
  _deadline?: number,
  _ownerRevision?: number,
  invocation?: unknown,
): Promise<void> => {
  const now = Date.now();
  await reconcileStaleSongRequestCharges(context, now);
  await ageSubmittingRequests(context, now);
  const module = await context.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ enabled: number; settings: string }>();
  const pendingRefunds = await retrySongRequestRefunds(context);
  if (typeof invocation === "object" && invocation !== null && (invocation as Record<string, unknown>).kind === "disconnect") {
    if (module?.enabled === 1 && pendingRefunds > 0) await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
    else if (!await scheduleFreshChargingReconciliation(context, now)) await context.clear(SONG_REQUESTS_ALARM);
    await notifyQueueOverlay(context);
    return;
  }
  if (module?.enabled !== 1) {
    if (!await scheduleFreshChargingReconciliation(context, now)) await context.clear(SONG_REQUESTS_ALARM);
    return;
  }
  let settings: SongRequestsSettings;
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown); }
  catch { settings = songRequestsSettingsSchema.parse({}); }
  const streamRow = await context.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
    .bind(context.channelId).first<{ state: string; stream_id: string | null }>();
  let roundId: string | null;
  let streamGeneration: number | null | undefined = context.streamGeneration;
  let interval = POLL_INTERVAL_MS;
  let backoffBase = BASE_BACKOFF_MS;
  if (streamRow?.state === "online" && streamRow.stream_id !== null) roundId = streamRow.stream_id;
  else if (streamRow?.state === "offline" && settings.alsoOffline) {
    roundId = await ensureOfflineSongRequestRound(context.DB, context.channelId, new Date(now).toISOString());
    streamGeneration = null;
    interval = OFFLINE_POLL_INTERVAL_MS;
    backoffBase = OFFLINE_POLL_INTERVAL_MS;
  } else {
    if (pendingRefunds > 0) await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
    else if (!await scheduleFreshChargingReconciliation(context, now)) await context.clear(SONG_REQUESTS_ALARM);
    return;
  }
  if (roundId === null) {
    if (pendingRefunds > 0) await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
    return;
  }
  const connection = await context.DB.prepare("SELECT state, poll_failures FROM song_requests_connections WHERE channel_id = ?")
    .bind(context.channelId).first<{ state: string; poll_failures: number }>();
  await reconcileApprovedSubmissionAlarms(context);
  if (context.environment === undefined) {
    await recordPollFailure(context, connection?.poll_failures ?? 0, undefined, streamGeneration, backoffBase);
    return;
  }
  if (connection?.state !== "connected" && connection?.state !== "no_active_device") {
    await recordPollFailure(context, connection?.poll_failures ?? 0, undefined, streamGeneration, backoffBase);
    return;
  }
  try {
    if (!await spotifySlotHeld(context.DB, context.channelId)) {
      await setConnectionState(context, "not_connected", new Date(now).toISOString());
      await recordPollFailure(context, connection.poll_failures, undefined, streamGeneration, backoffBase);
      return;
    }
    const token = await spotifyAccessToken(context, now);
    const currentConnection = await context.DB.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string }>();
    if (token === null || currentConnection?.state !== "connected" && currentConnection?.state !== "no_active_device") {
      await recordPollFailure(context, connection.poll_failures, undefined, streamGeneration, backoffBase);
      return;
    }
    if (!await playbackCycleIsCurrent(context, roundId)) return;
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
    if (!await playbackCycleIsCurrent(context, roundId)) return;
    const snapshot = await createNowPlayingSnapshot(
      context.DB,
      context.channelId,
      roundId,
      track,
      new Date(now).toISOString(),
      progressMs,
      streamRow.state === "online" ? { activeStreamId: roundId } : { offlineRoundId: roundId },
    );
    if (!snapshot.committed || !await playbackCycleIsCurrent(context, roundId)) return;
    await setConnectionState(context, "connected", new Date(now).toISOString());
    await context.DB.prepare("UPDATE song_requests_connections SET poll_failures = 0 WHERE channel_id = ? AND poll_failures > 0")
      .bind(context.channelId).run();
    if (snapshot.changed) {
      await notifyNowPlaying(context, snapshot.revision);
      await notifyQueueOverlay(context);
    }
    if (!await playbackCycleIsCurrent(context, roundId)) return;
    await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + interval, undefined, streamGeneration);
  } catch (error) {
    if (!await playbackCycleIsCurrent(context, roundId)) return;
    await recordPollFailure(context, connection.poll_failures, error, streamGeneration, backoffBase);
  }
};

export const handleSongRequestsActivation = async (context: ModuleAlarmContext, enabled: boolean): Promise<void> => {
  await flushChannelPointResolutions(context);
  await scheduleChannelPointResolutionRetry(context);
  if (!enabled) {
    await reconcileStaleSongRequestCharges(context);
    const rows = await context.DB.prepare(
      `SELECT id, state FROM song_requests WHERE channel_id = ?
        AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown') ORDER BY created_at, id`,
    ).bind(context.channelId).all<{ id: string; state: SongRequestState }>();
    for (const row of rows.results) {
      const toState: SongRequestState = row.state === "submitted" ? "removed"
        : row.state === "outcome_unknown" || row.state === "submitting" ? "failed" : "rejected";
      await transitionRequest(context.DB, {
        channelId: context.channelId,
        requestId: row.id,
        fromState: row.state,
        toState,
        failureReason: row.state === "submitting" || row.state === "outcome_unknown"
          ? "submit_outcome_uncertain"
          : "module_disabled",
        refundDue: true,
        now: new Date().toISOString(),
      });
    }
    const stream = await context.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string; stream_id: string | null }>();
    if (stream?.state === "online" && stream.stream_id !== null) {
      const cleanup = await cleanupSongRequestRound(context.DB, context.channelId, stream.stream_id, new Date().toISOString(), "module_disabled");
      await retrySongRequestRefunds(context, stream.stream_id);
      if (cleanup.changed) await notifyNowPlaying(context, cleanup.revision);
    }
    const offlineRoundId = await closeOfflineSongRequestRound(context.DB, context.channelId);
    if (offlineRoundId !== null) {
      const cleanup = await cleanupSongRequestRound(context.DB, context.channelId, offlineRoundId, new Date().toISOString(), "module_disabled");
      await retrySongRequestRefunds(context, offlineRoundId);
      if (cleanup.changed) await notifyNowPlaying(context, cleanup.revision);
    }
    await retrySongRequestRefunds(context);
    await flushChannelPointResolutions(context);
    if (!await scheduleFreshChargingReconciliation(context)) await context.clear(SONG_REQUESTS_ALARM);
    await notifyQueueOverlay(context);
    return;
  }
  await handleSongRequestsSettingsChanged(context);
};

export const handleSongRequestsSettingsChanged = async (context: ModuleAlarmContext): Promise<void> => {
  await flushChannelPointResolutions(context);
  const module = await context.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ enabled: number; settings: string }>();
  if (module?.enabled !== 1) return;
  await scheduleChannelPointResolutionRetry(context);
  let settings: SongRequestsSettings;
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown); }
  catch { settings = songRequestsSettingsSchema.parse({}); }
  await reconcileStaleSongRequestCharges(context);
  const pendingRefunds = await retrySongRequestRefunds(context);
  const stream = await context.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
    .bind(context.channelId).first<{ state: string; stream_id: string | null }>();
  if (stream?.state === "offline") {
    if (!settings.alsoOffline) {
      const roundId = await closeOfflineSongRequestRound(context.DB, context.channelId);
      if (roundId !== null) {
        const cleanup = await cleanupSongRequestRound(context.DB, context.channelId, roundId, new Date().toISOString(), "offline_round_ended");
        await retrySongRequestRefunds(context, roundId);
        if (cleanup.changed) await notifyNowPlaying(context, cleanup.revision);
      }
      if (await retrySongRequestRefunds(context) > 0) {
        await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
      } else if (!await scheduleFreshChargingReconciliation(context)) await context.clear(SONG_REQUESTS_ALARM);
      await flushChannelPointResolutions(context);
      await notifyQueueOverlay(context);
      return;
    }
    await ensureOfflineSongRequestRound(context.DB, context.channelId, new Date().toISOString());
    const connection = await context.DB.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string }>();
    if (await spotifySlotHeld(context.DB, context.channelId) && (connection?.state === "connected" || connection?.state === "no_active_device")) {
      await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + OFFLINE_POLL_INTERVAL_MS, undefined, null);
    } else {
      if (pendingRefunds > 0) await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
      else if (!await scheduleFreshChargingReconciliation(context)) await context.clear(SONG_REQUESTS_ALARM);
    }
    await flushChannelPointResolutions(context);
    return;
  }
  if (stream?.state === "online" && stream.stream_id !== null) {
    await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + POLL_INTERVAL_MS, undefined, context.streamGeneration);
  } else {
    if (pendingRefunds > 0) await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
    else if (!await scheduleFreshChargingReconciliation(context)) await context.clear(SONG_REQUESTS_ALARM);
  }
  await flushChannelPointResolutions(context);
  await notifyQueueOverlay(context);
};

export const handleSongRequestsLifecycleAlarm = async (
  context: ModuleAlarmContext,
  _alarmKey: string,
  _deadline: number,
  _ownerRevision: number | undefined,
  invocation?: unknown,
): Promise<void> => {
  if (typeof invocation === "object" && invocation !== null && typeof (invocation as Record<string, unknown>).enabled === "boolean") {
    await handleSongRequestsActivation(context, (invocation as Record<string, unknown>).enabled as boolean);
    return;
  }
  await handleSongRequestsSettingsChanged(context);
};

export const readSpotifyAccessTokenAlarm = async (context: ModuleAlarmContext): Promise<string | null> => await spotifyAccessToken(context);

const notifyQueueOverlay = async (context: Pick<ModuleAlarmContext, "DB" | "channelId" | "publishModuleOverlayMessage">): Promise<void> => {
  await context.publishModuleOverlayMessage(
    "queue_changed",
    "song_requests.queue",
    await songRequestQueueOverlayPayload(context.DB, context.channelId),
  );
};

const queueOverlayChange = async (context: { DB: D1Database; channelId: string }): Promise<ModuleResult["actions"][number]> => ({
  kind: "overlay",
  type: "queue_changed",
  elementKind: "song_requests.queue",
  payload: await songRequestQueueOverlayPayload(context.DB, context.channelId),
});

const readCurrentSongRequestScope = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<{ streamId: string | null; roundId: string; settingsJson: string; settings: SongRequestsSettings } | { error: "module_disabled" | "stream_offline" | "settings_invalid" }> => {
  const module = await db.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(channelId).first<{ enabled: number; settings: string }>();
  if (module?.enabled !== 1) return { error: "module_disabled" };
  let settings: SongRequestsSettings;
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown); }
  catch { return { error: "settings_invalid" }; }
  const stream = await db.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ state: string; stream_id: string | null }>();
  if (stream?.state === "online" && stream.stream_id !== null) {
    return { streamId: stream.stream_id, roundId: stream.stream_id, settingsJson: module.settings, settings };
  }
  if (stream?.state !== "offline" || !settings.alsoOffline) return { error: "stream_offline" };
  const roundId = await ensureOfflineSongRequestRound(db, channelId, now);
  return roundId === null ? { error: "stream_offline" } : { streamId: null, roundId, settingsJson: module.settings, settings };
};

const admissionFailureReply = (
  language: "de" | "en",
  failure: { code: string; position?: number },
): string => {
  const text = songRequestChatTexts[language];
  if (failure.code === "already_requested") return text.alreadyRequested(failure.position ?? 1);
  if (failure.code === "points_disabled") return text.pointsDisabled;
  const reason = text.reasons[failure.code as keyof typeof text.reasons];
  return text.rejected(typeof reason === "string" ? reason : text.reasons.request_unavailable);
};

const chatReply = (event: ModuleEvent, message: string): ModuleResult["actions"][number] => ({
  kind: "chat",
  text: message,
  automated: false,
  ...(typeof event.payload.message_id === "string" ? { replyToMessageId: event.payload.message_id } : {}),
});

const processSongRequestCommand = async (
  event: ModuleEvent<SongRequestsSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  const payload = event.payload;
  const message = typeof payload.message === "object" && payload.message !== null
    ? payload.message as Record<string, unknown> : null;
  const messageText = typeof message?.text === "string" ? message.text.trim() : "";
  const match = /^!sr(?:\s+([\s\S]+))?$/iu.exec(messageText);
  if (match === null) return { actions: [], diagnostics: [] };
  const language = await context.channelLanguage();
  const text = songRequestChatTexts[language === "en" ? "en" : "de"];
  const argument = match[1]?.trim() ?? "";
  if (argument.length === 0) return { actions: [chatReply(event, text.usage)], diagnostics: [] };
  const userId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  if (typeof userId !== "string" || userId.length === 0 || typeof login !== "string" || login.length === 0) return { actions: [], diagnostics: [] };
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  if (typeof payload.source_broadcaster_user_id === "string" && payload.source_broadcaster_user_id !== event.channelId) return { actions: [], diagnostics: [] };
  const scope = await readCurrentSongRequestScope(context.DB, event.channelId, event.receivedAt);
  if ("error" in scope) {
    const reply = scope.error === "stream_offline" ? text.offline
      : scope.error === "module_disabled" ? text.rejected(text.reasons.request_unavailable)
        : text.spotifyUnavailable;
    return { actions: [chatReply(event, reply)], diagnostics: [] };
  }
  let requestType: "bot_points" | "free";
  if (scope.settings.paymentMode === "free") {
    if (!canUseFreeSongRequest(scope.settings.freeRoleThreshold, event.chatStatus)) {
      return { actions: [chatReply(event, text.roleRequired(scope.settings.freeRoleThreshold))], diagnostics: [] };
    }
    requestType = "free";
  } else {
    const pointsModule = await context.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'points'")
      .bind(event.channelId).first<{ enabled: number }>();
    if (pointsModule?.enabled !== 1) return { actions: [chatReply(event, text.pointsDisabled)], diagnostics: [] };
    requestType = "bot_points";
  }
  if (!await spotifySlotHeld(context.DB, event.channelId)) return { actions: [chatReply(event, text.spotifySlot)], diagnostics: [] };
  const connection = await context.DB.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
    .bind(event.channelId).first<{ state: string }>();
  if (connection?.state === "no_active_device") return { actions: [chatReply(event, text.spotifyDevice)], diagnostics: [] };
  if (connection?.state !== "connected") {
    const reply = connection?.state === "reconnect_required" ? text.spotifyReconnect : text.spotifyNotConnected;
    return { actions: [chatReply(event, reply)], diagnostics: [] };
  }
  const environment = context.environment;
  if (environment === undefined) return { actions: [chatReply(event, text.spotifyUnavailable)], diagnostics: [] };
  let accessToken: string | null;
  try {
    accessToken = await environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId)).getSpotifyAccessToken();
  } catch {
    return { actions: [chatReply(event, text.spotifyReconnect)], diagnostics: [] };
  }
  if (accessToken === null) return { actions: [chatReply(event, text.spotifyReconnect)], diagnostics: [] };
  let track: SpotifyTrack | null;
  try {
    const trackId = spotifyTrackIdFromInput(argument);
    if (trackId !== null) track = await spotifyTrackById(environment, accessToken, trackId);
    else track = (await spotifySearchTracks(environment, accessToken, argument))[0] ?? null;
  } catch (error) {
    if (error instanceof SpotifyRequestError) await updateConnectionForError({ DB: context.DB, channelId: event.channelId }, error);
    return { actions: [chatReply(event, error instanceof SpotifyRequestError && error.reason === "NO_ACTIVE_DEVICE" ? text.spotifyDevice : text.spotifyUnavailable)], diagnostics: [] };
  }
  if (track === null) return { actions: [chatReply(event, text.noTrack)], diagnostics: [] };
  const requestId = `sr-${event.triggerId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 120) || crypto.randomUUID()}`;
  const operationId = `sr:${requestId}`;
  const parsedTime = Number.isFinite(Date.parse(event.receivedAt)) ? event.receivedAt : new Date().toISOString();
  const request = {
    channelId: event.channelId,
    requestId,
    operationId,
    track: songRequestTrackFromSpotify(track),
    requestType,
    streamId: scope.streamId,
    roundId: scope.roundId,
    settingsJson: scope.settingsJson,
    settings: scope.settings,
    requesterUserId: userId,
    requesterLogin: login,
    requesterDisplayName: typeof payload.chatter_user_name === "string" && payload.chatter_user_name.length > 0 ? payload.chatter_user_name : login,
    initialState: scope.settings.mode === "moderated" ? "pending_review" as const : "approved" as const,
    now: parsedTime,
  };
  const admission = await admitSongRequest(context.DB, request);
  if (!admission.accepted) {
    const failure = await songRequestAdmissionFailure(context.DB, request);
    return { actions: [chatReply(event, admissionFailureReply(language === "en" ? "en" : "de", failure))], diagnostics: [] };
  }
  const row = await readSongRequest(context.DB, event.channelId, requestId);
  if (row === null) return { actions: [chatReply(event, text.spotifyUnavailable)], diagnostics: [] };
  let current = await readSongRequest(context.DB, event.channelId, requestId);
  if (current === null) return { actions: [chatReply(event, text.spotifyUnavailable)], diagnostics: [] };
  if (requestType === "bot_points") {
    const charge = await chargeSongRequest(context.points, current);
    if (charge.status === "cancelled") {
      const cancelledRequest = await readSongRequest(context.DB, event.channelId, requestId);
      return {
        actions: [chatReply(event, cancelledRequest === null
          ? text.spotifyUnavailable
          : text.rejected(text.reasons.request_unavailable)), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })],
        diagnostics: [],
      };
    }
    if (charge.status === "failed") {
      const finalized = await finalizeChargingSongRequest(
        { DB: context.DB, channelId: event.channelId, points: context.points },
        requestId,
        "charge_failed",
        new Date().toISOString(),
      );
      if (finalized.charge.kind === "stake") {
        return {
          actions: [chatReply(event, text.rejected(text.reasons.request_unavailable)), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })],
          diagnostics: [],
        };
      }
      if (!finalized.changed) {
        current = await readSongRequest(context.DB, event.channelId, requestId);
        if (current !== null && !isOpenSongRequestState(current.state)) {
          return {
            actions: [chatReply(event, text.rejected(text.reasons.request_unavailable)), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })],
            diagnostics: [],
          };
        }
      }
      return { actions: [chatReply(event, text.insufficientPoints), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })], diagnostics: [] };
    }
    const chargedAmount = charge.amount;
    const toState = scope.settings.mode === "moderated" ? "pending_review" : "approved";
    const now = new Date().toISOString();
    const visible = await transitionRequest(context.DB, {
      channelId: event.channelId,
      requestId,
      fromState: "charging",
      toState,
      chargedAmount,
      chargedAt: now,
      activeRoundId: scope.roundId,
      now,
    });
    if (!visible) {
      current = await readSongRequest(context.DB, event.channelId, requestId);
      if (current?.state === "charging") {
        await finalizeChargingSongRequest(
          { DB: context.DB, channelId: event.channelId, points: context.points },
          requestId,
          "request_round_ended",
          now,
        );
      } else if (current !== null) {
        await markSongRequestRefundDue(context.DB, event.channelId, requestId);
      }
      await refundRequestId({ DB: context.DB, channelId: event.channelId, points: context.points }, requestId);
      return {
        actions: [chatReply(event, text.rejected(text.reasons.request_unavailable)), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })],
        diagnostics: [],
      };
    }
    current = await readSongRequest(context.DB, event.channelId, requestId);
    if (current === null) return { actions: [chatReply(event, text.spotifyUnavailable)], diagnostics: [] };
  }
  if ((current.state === "pending_review" || current.state === "approved") &&
      !await requestRoundIsCurrent(context.DB, event.channelId, current)) {
    await transitionRequest(context.DB, {
      channelId: event.channelId,
      requestId,
      fromState: current.state,
      toState: "rejected",
      failureReason: "request_round_ended",
      refundDue: true,
      now: new Date().toISOString(),
    });
    current = await readSongRequest(context.DB, event.channelId, requestId);
    if (current === null) return { actions: [chatReply(event, text.spotifyUnavailable)], diagnostics: [] };
  }
  if (!isOpenSongRequestState(current.state)) {
    await refundRequestId({ DB: context.DB, channelId: event.channelId, points: context.points }, requestId);
    return {
      actions: [chatReply(event, text.rejected(text.reasons.request_unavailable)), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })],
      diagnostics: [],
    };
  }
  if (scope.settings.mode === "automatic") {
    await context.scheduleAlarm(SONG_REQUESTS_SUBMIT_HANDLER, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`, Date.now(), undefined, null);
  }
  const position = admission.position ?? 1;
  const reply = scope.settings.mode === "moderated" ? text.waitingReview(position) : text.accepted(position);
  return { actions: [chatReply(event, reply), await queueOverlayChange({ DB: context.DB, channelId: event.channelId })], diagnostics: [] };
};

export const processSongRequestsEvent = async (event: ModuleEvent<SongRequestsSettings>, context: ModuleExecutionContext): Promise<ModuleResult> => {
  if (event.subscriptionType === "channel.chat.message") return await processSongRequestCommand(event, context);
  if (context.streamStateTransitionAccepted !== true) return { actions: [], diagnostics: [] };
  await scheduleEventAlarmIfEarlier(context,
    SONG_REQUESTS_LIFECYCLE_HANDLER,
    "channel-point-resolutions",
    Date.now() + CHANNEL_POINT_RESOLUTION_RETRY_MS,
    undefined,
    null,
  );
  const actions: ModuleResult["actions"][number][] = [];
  const enabled = await context.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(event.channelId).first<{ enabled: number; settings: string }>();
  let settings: SongRequestsSettings;
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(enabled?.settings ?? "{}") as unknown); }
  catch { settings = songRequestsSettingsSchema.parse({}); }
  if (event.subscriptionType === "stream.online") {
    const offlineRoundId = await closeOfflineSongRequestRound(context.DB, event.channelId);
    if (offlineRoundId !== null) {
      await reconcileStaleSongRequestCharges({ DB: context.DB, channelId: event.channelId, points: context.points }, Date.now(), offlineRoundId);
      const cleanup = await cleanupSongRequestRound(context.DB, event.channelId, offlineRoundId, event.receivedAt, "offline_round_ended");
      if (cleanup.changed) actions.push({ kind: "overlay", type: "state_changed", elementKind: "song_requests.now_playing", payload: { revision: cleanup.revision } });
    }
    await retrySongRequestRefunds({ DB: context.DB, channelId: event.channelId, points: context.points });
    if (enabled?.enabled === 1) {
      await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + POLL_INTERVAL_MS);
    } else if (await hasFreshChargingSongRequests(context.DB, event.channelId)) {
      await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + IN_FLIGHT_MAX_AGE_MS, undefined, null);
    } else await context.clearAlarm(SONG_REQUESTS_ALARM);
    actions.push(await queueOverlayChange({ DB: context.DB, channelId: event.channelId }));
  } else if (event.subscriptionType === "stream.offline") {
    const streamId = context.streamSession?.streamId ?? null;
    if (streamId !== null) {
      await reconcileStaleSongRequestCharges({ DB: context.DB, channelId: event.channelId, points: context.points }, Date.now(), streamId);
      const cleanup = await cleanupSongRequestRound(context.DB, event.channelId, streamId, event.receivedAt, "stream_ended");
      await retrySongRequestRefunds({ DB: context.DB, channelId: event.channelId, points: context.points }, streamId);
      if (cleanup.changed) actions.push({ kind: "overlay", type: "state_changed", elementKind: "song_requests.now_playing", payload: { revision: cleanup.revision } });
    } else {
      await reconcileStaleSongRequestCharges({ DB: context.DB, channelId: event.channelId, points: context.points }, Date.now());
      const cleared = await clearSongRequestsForStreamEnd(context.DB, event.channelId, streamId, event.receivedAt);
      await retrySongRequestRefunds({ DB: context.DB, channelId: event.channelId, points: context.points });
      if (cleared.changed) actions.push({ kind: "overlay", type: "state_changed", elementKind: "song_requests.now_playing", payload: { revision: cleared.revision } });
    }
    if (enabled?.enabled === 1 && settings.alsoOffline) {
      await ensureOfflineSongRequestRound(context.DB, event.channelId, event.receivedAt);
      await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + OFFLINE_POLL_INTERVAL_MS, undefined, null);
    } else if (enabled?.enabled === 1) {
      if ((await songRequestRefundDueIds(context.DB, event.channelId)).length > 0) {
        await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + BASE_BACKOFF_MS, undefined, null);
      } else if (await hasFreshChargingSongRequests(context.DB, event.channelId)) {
        await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + IN_FLIGHT_MAX_AGE_MS, undefined, null);
      } else await context.clearAlarm(SONG_REQUESTS_ALARM);
    } else if (await hasFreshChargingSongRequests(context.DB, event.channelId)) {
      await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + IN_FLIGHT_MAX_AGE_MS, undefined, null);
    } else await context.clearAlarm(SONG_REQUESTS_ALARM);
    if (streamId !== null) {
      const snapshot = await context.DB.prepare("SELECT revision FROM song_requests_now_playing WHERE channel_id = ?")
        .bind(event.channelId).first<{ revision: number }>();
      actions.push({ kind: "overlay", type: "state_changed", elementKind: "song_requests.now_playing", payload: { revision: snapshot?.revision ?? 0 } });
    }
    actions.push(await queueOverlayChange({ DB: context.DB, channelId: event.channelId }));
  }
  await flushChannelPointResolutionsFromEvent(context);
  return { actions, diagnostics: [] };
};

