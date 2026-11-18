import type { ModuleAlarmContext, ModuleOverlayAlertQueueAccess, ModuleChannelPointsAccess, ModuleChannelPointsStatus, ModuleDurableAction, ModuleEvent, ModuleExecutionContext, ModuleResult, ModulePointsAccess } from "../contract";
import { renderTemplate } from "../contract";
import { voteWinner } from "./domain/vote-result";
import { decideSkipVote } from "./domain/skip-result";
import { isSpotifyTrack, spotifyTrackIdFromInput, type SpotifyTrack } from "./domain/track";
import { canUseFreeSongRequest, isOpenSongRequestState } from "./domain/rules";
import { songRequestsSettingsForLanguage, songRequestsSettingsSchema, type SongRequestsSettings } from "./contracts";
import { songRequestChatTexts } from "./chat-locale";
import { formatSongRequestTrack, songRequestArtistDisplay } from "./domain/track-display";
import { songRequestRecapMessage } from "./domain/recap";
import { SONG_REQUEST_TEMPLATE_VARIABLES } from "./contracts/template-variables";
import {
  admitSongRequest,
  closeOfflineSongRequestRound,
  createNowPlayingSnapshot,
  createVoteRequestClaim,
  createSkipVoteMapping,
  cleanupSongRequestRound,
  clearSongRequestsForStreamEnd,
  ensureOfflineSongRequestRound,
  finishVoteWithoutRequest,
  claimSkipVoteResult,
  finishSkipVoteResult,
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
  openSkipVoteMapping,
  removeUnstartedSkipVoteMapping,
} from "./adapters/d1";
import type { SongRequestRow, SongRequestState } from "./adapters/d1";
import { SpotifyRequestError, refreshSpotifyToken, spotifyApiRequest, spotifySearchTracks, spotifySkipCurrentTrack, spotifyTrackById } from "./adapters/spotify";
import { readSongRequestQueueState } from "./overlay/queue-state";

export const songRequestQueueOverlayPayload = readSongRequestQueueState;

export const SONG_REQUESTS_ALARM = "poll";
export const SONG_REQUESTS_HANDLER = "poll";
export const SONG_REQUESTS_SUBMIT_HANDLER = "submit";
export const SONG_REQUESTS_LIFECYCLE_HANDLER = "lifecycle";
export const SONG_REQUESTS_ACCESS_TOKEN_HANDLER = "access_token";
export const SONG_REQUESTS_SKIP_HANDLER = "skip";
export const SONG_REQUESTS_SKIP_ALARM = "execute";
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

export type SongSkipOutcome = "skipped" | "nothing_playing" | "track_changed" | "not_connected" |
  "no_active_device" | "spotify_unavailable";

const nowPlayingTrackId = async (db: D1Database, channelId: string): Promise<string | null> => {
  const row = await db.prepare("SELECT track_json FROM song_requests_now_playing WHERE channel_id = ?")
    .bind(channelId).first<{ track_json: string | null }>();
  if (row?.track_json === null || row?.track_json === undefined) return null;
  try {
    const track: unknown = JSON.parse(row.track_json);
    return typeof track === "object" && track !== null && typeof (track as Record<string, unknown>).id === "string"
      ? (track as Record<string, unknown>).id as string
      : null;
  } catch { return null; }
};

const recordSkipBackoff = async (db: D1Database, channelId: string, error: SpotifyRequestError, now: number): Promise<void> => {
  const retryAfter = error.status === 429 ? error.retryAfterMs ?? 0 : 0;
  const deadline = now + Math.max(BASE_BACKOFF_MS, retryAfter);
  await db.prepare(
    `INSERT INTO song_requests_connections
       (channel_id, state, error_message, updated_at, poll_failures, poll_backoff_until)
     VALUES (?, 'connected', NULL, ?, 1, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       poll_failures = MIN(song_requests_connections.poll_failures + 1, 8),
       poll_backoff_until = MAX(COALESCE(song_requests_connections.poll_backoff_until, 0), excluded.poll_backoff_until)
     RETURNING channel_id`,
  ).bind(channelId, new Date(now).toISOString(), deadline).first<{ channel_id: string }>();
};

/** Makes exactly one Spotify next-track request after all local guards pass. */
export const skipSongTrack = async (
  context: { DB: D1Database; channelId: string; environment?: Env | undefined },
  readAccessToken: () => Promise<string | null>,
  expectedTrackId?: string,
): Promise<SongSkipOutcome> => {
  const [slotHeld, connection] = await Promise.all([
    spotifySlotHeld(context.DB, context.channelId),
    context.DB.prepare("SELECT state, poll_backoff_until FROM song_requests_connections WHERE channel_id = ?")
      .bind(context.channelId).first<{ state: string; poll_backoff_until: number | null }>(),
  ]);
  if (!slotHeld || connection?.state === undefined || connection.state === "not_connected" || connection.state === "reconnect_required") {
    return "not_connected";
  }
  if (connection.state === "no_active_device") return "no_active_device";
  if (connection.state !== "connected") return "not_connected";
  const now = Date.now();
  if (connection.poll_backoff_until !== null && connection.poll_backoff_until > now) return "spotify_unavailable";
  const trackId = await nowPlayingTrackId(context.DB, context.channelId);
  if (trackId === null) return expectedTrackId === undefined ? "nothing_playing" : "track_changed";
  if (expectedTrackId !== undefined && trackId !== expectedTrackId) return "track_changed";
  if (context.environment === undefined) return "not_connected";
  let accessToken: string | null;
  try { accessToken = await readAccessToken(); } catch { return "not_connected"; }
  if (accessToken === null) return "not_connected";
  if (expectedTrackId !== undefined) {
    try {
      const response = await spotifyApiRequest(context.environment, accessToken, "me/player/currently-playing");
      if (response.status === 204) return "track_changed";
      const payload: unknown = await response.json();
      const row = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const liveItem = row?.item;
      if (!isSpotifyTrack(liveItem) || liveItem.id !== expectedTrackId) return "track_changed";
    } catch (error) {
      if (error instanceof SpotifyRequestError && (error.status === 429 || error.status >= 500)) {
        await recordSkipBackoff(context.DB, context.channelId, error, now);
      } else if (error instanceof SpotifyRequestError) {
        await updateConnectionForError({ DB: context.DB, channelId: context.channelId }, error);
      }
      return "spotify_unavailable";
    }
  }
  try {
    await spotifySkipCurrentTrack(context.environment, accessToken);
    return "skipped";
  } catch (error) {
    if (!(error instanceof SpotifyRequestError)) return "spotify_unavailable";
    if (error.status === 404) {
      await setConnectionState({ DB: context.DB, channelId: context.channelId }, "no_active_device", new Date().toISOString());
      return "no_active_device";
    }
    if (error.status === 429 || error.status >= 500) {
      await recordSkipBackoff(context.DB, context.channelId, error, now);
      return "spotify_unavailable";
    }
    await updateConnectionForError({ DB: context.DB, channelId: context.channelId }, error);
    return "spotify_unavailable";
  }
};

const isSongSkipOutcome = (value: unknown): value is SongSkipOutcome =>
  value === "skipped" || value === "nothing_playing" || value === "track_changed" || value === "not_connected" ||
  value === "no_active_device" || value === "spotify_unavailable";

export const skipSongTrackThroughChannelObject = async (
  runModuleAlarm: ((handlerKey: string, alarmKey: string, invocation?: unknown) => Promise<unknown>) | undefined,
  expectedTrackId?: string,
): Promise<SongSkipOutcome> => {
  if (runModuleAlarm === undefined) return "spotify_unavailable";
  try {
    const result = await runModuleAlarm(
      SONG_REQUESTS_SKIP_HANDLER,
      SONG_REQUESTS_SKIP_ALARM,
      expectedTrackId === undefined ? {} : { expectedTrackId },
    );
    return isSongSkipOutcome(result) ? result : "spotify_unavailable";
  } catch {
    return "spotify_unavailable";
  }
};

export const handleSongRequestSkipAlarm = async (
  context: ModuleAlarmContext,
  _alarmKey: string,
  _deadline: number,
  _ownerRevision?: number,
  invocation?: unknown,
): Promise<SongSkipOutcome> => {
  const request = typeof invocation === "object" && invocation !== null && !Array.isArray(invocation)
    ? invocation as Record<string, unknown>
    : {};
  const expectedTrackId = typeof request.expectedTrackId === "string" ? request.expectedTrackId : undefined;
  return await skipSongTrack(
    { DB: context.DB, channelId: context.channelId, environment: context.environment },
    async () => await spotifyAccessToken(context),
    expectedTrackId,
  );
};

const skipOutcomeChatReply = (language: "de" | "en", result: SongSkipOutcome): string => {
  const text = songRequestChatTexts[language].skipVote;
  if (result === "skipped") return text.skipped;
  if (result === "nothing_playing") return text.nothingPlaying;
  if (result === "track_changed") return text.changed;
  if (result === "no_active_device") return text.device;
  if (result === "not_connected") return text.notConnected;
  return text.unavailable;
};

/** chat_voting ballots count choices from 1: "Yes" is the first of the two skip vote options. */
const SKIP_VOTE_YES_CHOICE = 1;

const safeTwitchAvatarUrl =(value: string | null | undefined): string | undefined => {
  if (typeof value !== "string" || value.length > 256) return undefined;
  try {
    const url = new URL(value);
    return value.startsWith("https://static-cdn.jtvnw.net/") && url.protocol === "https:" && url.origin === "https://static-cdn.jtvnw.net" &&
      url.username.length === 0 && url.password.length === 0 ? value : undefined;
  } catch { return undefined; }
};

const renderSongRequestTemplate = (template: string, values: Readonly<Record<string, string | number>>): string =>
  renderTemplate(template, values, {}, SONG_REQUEST_TEMPLATE_VARIABLES);

export const enqueueSongRequestAlert = async (
  context: {
    DB: D1Database;
    channelId: string;
    overlayAlertQueue?: Pick<ModuleOverlayAlertQueueAccess, "enqueue"> | undefined;
    resolveTwitchUserById?: ModuleExecutionContext["resolveTwitchUserById"];
  },
  requestId: string,
): Promise<void> => {
  const queue = context.overlayAlertQueue;
  if (queue === undefined) return;
  try {
    const [module, request, channel] = await Promise.all([
      context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
        .bind(context.channelId).first<{ settings: string }>(),
      context.DB.prepare(
        `SELECT request_type, track_id, title, artists_json, album_name, requester_user_id, requester_login, requester_display_name,
                round_id, created_at, state,
                (SELECT chapter_name_snapshot FROM song_requests_votes
                  WHERE channel_id = song_requests.channel_id AND request_id = song_requests.id AND vote_kind = 'song'
                  ORDER BY created_at DESC LIMIT 1) AS chapter_name
           FROM song_requests WHERE channel_id = ? AND id = ?`,
      ).bind(context.channelId, requestId).first<{
        request_type: "vote" | "bot_points" | "free" | "channel_points";
        track_id: string;
        title: string;
        artists_json: string;
        album_name: string | null;
        requester_user_id: string | null;
        requester_login: string | null;
        requester_display_name: string | null;
        round_id: string | null;
        created_at: string;
        state: string;
        chapter_name: string | null;
      }>(),
      context.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
        .bind(context.channelId).first<{ language: string }>(),
    ]);
    if (request?.state !== "approved") return;
    const language = channel?.language === "en" ? "en" : "de";
    let settings = songRequestsSettingsForLanguage(language);
    try {
      const rawSettings: unknown = JSON.parse(module?.settings ?? "{}");
      settings = songRequestsSettingsSchema.parse({
        ...songRequestsSettingsForLanguage(language),
        ...(typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings) ? rawSettings : {}),
      });
    }
    catch { /* Invalid settings fall back to the module defaults. */ }
    if (!settings.requestAlert.enabled || !settings.requestAlertTextEnabled) return;
    let artists: unknown = [];
    try { artists = JSON.parse(request.artists_json) as unknown; } catch { /* Use the empty artist label. */ }
    const artistNames = Array.isArray(artists) ? artists.filter((item): item is string => typeof item === "string") : [];
    const artist = songRequestArtistDisplay(artistNames);
    const labels = language === "en"
      ? { vote: "Song vote", botPoints: "Bot points", free: "Free request", channelPoints: "Channel points", viewer: "Viewer" }
      : { vote: "Song-Abstimmung", botPoints: "Bot-Punkte", free: "Kostenloser Wunsch", channelPoints: "Kanalpunkte", viewer: "Zuschauer" };
    const requestType = request.request_type === "bot_points" ? labels.botPoints
      : request.request_type === "free" ? labels.free
        : request.request_type === "channel_points" ? labels.channelPoints : labels.vote;
    const requester = request.requester_display_name ?? request.requester_login ?? labels.viewer;
    const formattedTrack = formatSongRequestTrack({ title: request.title, artists: artistNames, albumName: request.album_name });
    const position = await context.DB.prepare(
      `SELECT COUNT(*) AS position FROM song_requests
        WHERE channel_id = ? AND round_id IS ? AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')
          AND (created_at < ? OR (created_at = ? AND id <= ?))`,
    ).bind(context.channelId, request.round_id, request.created_at, request.created_at, requestId)
      .first<{ position: number }>();
    const defaultAlertText = songRequestsSettingsForLanguage(language).requestAlertText;
    const alertTemplate = request.request_type === "vote" && settings.requestAlertText === defaultAlertText
      ? "{song.type}: {song.track}"
      : settings.requestAlertText;
    const renderedTemplate = renderSongRequestTemplate(alertTemplate, {
      user: requester,
      "song.track": formattedTrack,
      "song.artist": artist,
      "song.title": request.title,
      "song.album": request.album_name?.trim() ?? "",
      "song.position": position?.position ?? 1,
      "song.type": request.request_type === "vote" ? labels.vote : requestType,
    });
    const rendered = request.chapter_name === null ? renderedTemplate : `${request.chapter_name}: ${formattedTrack}`;
    let avatarUrl: string | undefined;
    if (request.requester_user_id !== null && request.request_type !== "vote" && context.resolveTwitchUserById !== undefined) {
      try { avatarUrl = safeTwitchAvatarUrl((await context.resolveTwitchUserById(request.requester_user_id))?.profileImageUrl); }
      catch { avatarUrl = undefined; }
    }
    await queue.enqueue(`song-request-alert:${requestId}`, {
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      text: rendered.slice(0, 200),
      durationSeconds: 5,
      volumePercent: 0,
    });
  } catch { /* Alerts are cosmetic and never block an approved request. */ }
};

export const enqueueSongRequestSpotlightAlert = async (
  context: {
    DB: D1Database;
    channelId: string;
    overlayAlertQueue?: Pick<ModuleOverlayAlertQueueAccess, "enqueue">;
  },
  requestId: string,
): Promise<void> => {
  const queue = context.overlayAlertQueue;
  if (queue === undefined) return;
  try {
    const [module, request, channel] = await Promise.all([
      context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1")
        .bind(context.channelId).first<{ settings: string }>(),
      context.DB.prepare(
        `SELECT source, request_type, title, artists_json, album_name, requester_display_name, requester_login, state
           FROM song_requests WHERE channel_id = ? AND id = ?`,
      ).bind(context.channelId, requestId).first<{
        source: string;
        request_type: string;
        title: string;
        artists_json: string;
        album_name: string | null;
        requester_display_name: string | null;
        requester_login: string | null;
        state: string;
      }>(),
      context.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
        .bind(context.channelId).first<{ language: string }>(),
    ]);
    if (request?.state !== "observed_playing" || request.source === "mod_vote" || request.request_type === "vote") return;
    const language = channel?.language === "en" ? "en" : "de";
    let settings: SongRequestsSettings;
    try {
      const raw: unknown = JSON.parse(module?.settings ?? "{}");
      settings = songRequestsSettingsSchema.parse({
        ...songRequestsSettingsForLanguage(language),
        ...(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}),
      });
    } catch { settings = songRequestsSettingsForLanguage(language); }
    if (!settings.spotlight.enabled) return;
    let parsedArtists: unknown = [];
    try { parsedArtists = JSON.parse(request.artists_json) as unknown; } catch { /* Use an empty artist list for a damaged cache. */ }
    const artists = Array.isArray(parsedArtists) ? parsedArtists.filter((artist): artist is string => typeof artist === "string") : [];
    const requester = request.requester_display_name?.trim() || request.requester_login?.trim();
    if (requester === undefined || requester.length === 0) return;
    const prefix = language === "en" ? "Requested by" : "Angefragt von";
    const text = `${prefix} ${requester}: ${formatSongRequestTrack({ title: request.title, artists, albumName: request.album_name })}`;
    await queue.enqueue(`song-request-spotlight:${requestId}`, {
      text: text.slice(0, 200),
      durationSeconds: 5,
      volumePercent: 0,
    });
  } catch { /* Spotlight alerts are cosmetic and never block playback polling. */ }
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

const spotifySubmissionFailureReason = (error: SpotifyRequestError): string =>
  error.status === 403 && error.reason !== "PREMIUM_REQUIRED" ? error.message.slice(0, 200)
    : error.reason ?? `spotify_${String(error.status)}`;

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
          if (!(retryError instanceof SpotifyRequestError)) {
            await transitionAfterSpotifyPost(context, requestId, "outcome_unknown", "retry_response_uncertain", row.roundId);
            return;
          }
          await updateConnectionForError(context, retryError);
          if (retryError.status >= 500) {
            await transitionAfterSpotifyPost(context, requestId, "outcome_unknown", "retry_response_uncertain", row.roundId);
            return;
          }
          if (retryError.status !== 429) {
            await transitionAfterSpotifyPost(context, requestId, "failed", spotifySubmissionFailureReason(retryError), row.roundId);
            return;
          }
        }
      }
      await transitionAfterSpotifyPost(context, requestId, "failed", "rate_limited", row.roundId);
      return;
    }
    await transitionAfterSpotifyPost(context, requestId, "failed",
      spotifySubmissionFailureReason(error), row.roundId);
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
  if (reason === "NO_ACTIVE_DEVICE" || reason === "no_active_device") return {
    de: songRequestChatTexts.de.spotifyDevice,
    en: songRequestChatTexts.en.spotifyDevice,
  };
  if (reason === "PREMIUM_REQUIRED" || reason === "premium_required") return {
    de: "Spotify Premium ist erforderlich, um Songs in die Warteschlange einzureihen.",
    en: "Spotify Premium is required to queue songs.",
  };
  if (reason === "rate_limited") return {
    de: "Spotify verarbeitet gerade zu viele Anfragen. Bitte versuche es später erneut.",
    en: "Spotify is receiving too many requests. Please try again later.",
  };
  if (reason === "stream_offline") return {
    de: "Der Stream ist inzwischen offline. Der Song wurde nicht eingereiht.",
    en: "The stream is now offline. The song was not queued.",
  };
  if (reason === "submit_outcome_uncertain") return {
    de: "Spotify hat den Ausgang nicht bestätigt. Bitte prüfe die Warteschlange vor einem erneuten Versuch.",
    en: "Spotify did not confirm the result. Check the queue before trying again.",
  };
  if (reason === "outcome_unknown" || reason === "network_or_timeout" || reason === "spotify_server_error" || reason === "retry_response_uncertain" || reason === "submit_interrupted" || reason === "submit_state_conflict") return {
    de: "Spotify hat den Ausgang nicht bestätigt. Bitte prüfe die Warteschlange vor einem erneuten Versuch.",
    en: "Spotify did not confirm the result. Check the queue before trying again.",
  };
  return {
    de: "Spotify konnte den Song nicht einreihen. Bitte versuche es später erneut.",
    en: "Spotify could not queue the song. Please try again later.",
  };
};

const requestTypeLabel = (type: SongRequestRow["requestType"], language: "de" | "en"): string => {
  const labels = language === "en"
    ? { vote: "Song vote", bot_points: "Bot points", free: "Free request", channel_points: "Channel Points" }
    : { vote: "Song-Abstimmung", bot_points: "Bot-Punkte", free: "Kostenloser Wunsch", channel_points: "Kanalpunkte" };
  return labels[type];
};

const announceSubmitResult = async (context: ModuleAlarmContext, requestId: string): Promise<boolean> => {
  const row = await readSongRequest(context.DB, context.channelId, requestId);
  if (row === null || row.state === "charging" || row.state === "approved" || row.state === "submitting") return false;
  const language = await context.channelLanguage();
  const locale = language === "en" ? "en" : "de";
  const moduleRow = await context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
    .bind(context.channelId).first<{ settings: string }>();
  let rawSettings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(moduleRow?.settings ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) rawSettings = parsed as Record<string, unknown>;
  } catch { /* Invalid legacy settings use localized defaults. */ }
  const settings = songRequestsSettingsSchema.parse({ ...songRequestsSettingsForLanguage(locale), ...rawSettings });
  if (row.state === "submitted" && !settings.queuedTextEnabled) return false;
  const position = await context.DB.prepare(
    `SELECT COUNT(*) AS position FROM song_requests
      WHERE channel_id = ? AND round_id IS ?
        AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')
        AND (created_at < ? OR (created_at = ? AND id <= ?))`,
  ).bind(context.channelId, row.roundId, row.createdAt, row.createdAt, row.requestId).first<{ position: number }>();
  const artist = songRequestArtistDisplay(row.artists);
  const track = formatSongRequestTrack(row);
  let message: string;
  if (row.state === "submitted") {
    const rendered = renderSongRequestTemplate(settings.queuedText, {
      user: row.requesterDisplayName ?? row.requesterLogin ?? "",
      "song.track": track,
      "song.artist": artist,
      "song.title": row.title,
      "song.album": row.albumName?.trim() ?? "",
      "song.position": position?.position ?? 1,
      "song.type": requestTypeLabel(row.requestType, locale),
    });
    message = rendered;
  } else {
    message = failureMessage(row.state === "outcome_unknown" ? "outcome_unknown" : row.failureReason)[locale];
    if ((row.state === "failed" || row.state === "rejected") && row.requestType === "bot_points" && row.chargedAmount > 0 && !row.refundDue) {
      message += locale === "de" ? " Bot-Punkte wurden erstattet." : " Bot points were refunded.";
    }
    if ((row.state === "failed" || row.state === "rejected") && row.requestType === "channel_points" && row.channelPointsRewardId !== null && row.channelPointsResolutionCompleted === "CANCELED") {
      message += locale === "de" ? " Die Kanalpunkte-Einlösung wurde storniert." : " The Channel Points redemption was canceled.";
    }
  }
  const delivery = await context.sendChat(
    message,
    `song-request-result:${row.operationId}`,
    undefined,
    undefined,
    undefined,
    { automated: true, ...(row.chatMessageId === null ? {} : { replyToMessageId: row.chatMessageId }) },
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

const skipVoteResultText = (
  language: "de" | "en",
  result: "skipped" | "threshold_not_met" | "no_majority" | SongSkipOutcome,
): string => {
  const text = songRequestChatTexts[language].skipVote;
  if (result === "skipped") return text.skipped;
  if (result === "threshold_not_met") return text.threshold;
  if (result === "no_majority") return text.majority;
  if (result === "nothing_playing") return text.resultNothingPlaying;
  if (result === "not_connected") return text.resultNotConnected;
  if (result === "spotify_unavailable") return text.resultUnavailable;
  if (result === "no_active_device") return text.resultDevice;
  return skipOutcomeChatReply(language, result);
};

const handleSkipVoteResult = async (
  context: ModuleAlarmContext,
  action: Extract<ModuleDurableAction, { kind: "chat_vote.result" }>,
  vote: NonNullable<Awaited<ReturnType<typeof voteRecord>>>,
): Promise<void> => {
  if (!await claimSkipVoteResult(context.DB, context.channelId, action.ballotId, action.closedAt)) return;
  const yesVotes = action.counts[0] ?? 0;
  const noVotes = action.counts[1] ?? 0;
  const decision = decideSkipVote(yesVotes, noVotes, vote.skipThreshold ?? 5);
  let result: "skipped" | "threshold_not_met" | "no_majority" | SongSkipOutcome;
  let state: "queued" | "tie" | "no_votes" | "failed";
  if (decision === "threshold_not_met") {
    result = "threshold_not_met";
    state = yesVotes === 0 && noVotes === 0 ? "no_votes" : "tie";
  } else if (decision === "no_majority") {
    result = "no_majority";
    state = "tie";
  } else {
    result = vote.startTrackId === null ? "track_changed" : await skipSongTrackThroughChannelObject(
      context.runModuleAlarm === undefined ? undefined : (handlerKey, alarmKey, invocation) =>
        context.runModuleAlarm?.(handlerKey, alarmKey, invocation) ?? Promise.resolve(undefined),
      vote.startTrackId,
    );
    state = result === "skipped" ? "queued" : "failed";
    if (result === "skipped") await scheduleAlarmIfEarlier(context, SONG_REQUESTS_ALARM, Date.now() + 1_000, undefined, null);
  }
  await finishSkipVoteResult(context.DB, context.channelId, action.ballotId, state, result);
  const language = await context.channelLanguage();
  try { await context.sendChat(skipVoteResultText(language === "en" ? "en" : "de", result), `skip-vote-result:${action.ballotId}`); }
  catch { /* The Spotify operation and cooldown are already committed. */ }
};

export const handleSongRequestDurableAction = async (context: ModuleAlarmContext, action: ModuleDurableAction): Promise<void> => {
  let vote = await voteRecord(context.DB, context.channelId, action.ballotId);
  if (vote === null) return;
  if (vote.voteKind === "skip") {
    await handleSkipVoteResult(context, action, vote);
    return;
  }
  if (vote.state === "open") {
    const winner = await voteWinner(action.counts, action.ballotId);
    if (winner === null) {
      const zero = action.counts.every((count) => count === 0);
      await finishVoteWithoutRequest(context.DB, context.channelId, action.ballotId, zero ? "no_votes" : "tie", action.closedAt);
    } else {
      const track = vote.candidates[winner.index];
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
        drawnByLot: winner.drawnByLot,
        ...(active ? { activeRoundId: roundId } : {}),
        initialState: active ? "approved" : "rejected",
        failureReason: active ? null : "stream_offline",
      });
      if (!claimed) {
        const current = await voteRecord(context.DB, context.channelId, action.ballotId);
        if (current?.state === "open") await finishVoteWithoutRequest(context.DB, context.channelId, action.ballotId, "failed", action.closedAt);
      }
    }
    vote = await voteRecord(context.DB, context.channelId, action.ballotId);
  }
  if (vote?.state === "no_votes" && action.counts.every((count) => count === 0)) {
    const language = await context.channelLanguage();
    const delivery = await context.sendChat(language === "en" ? "Nobody voted – no song queued." : "Niemand hat abgestimmt – kein Song eingereiht.",
      `song-vote-no-votes:${action.ballotId}`, undefined, undefined, undefined, { automated: true });
    if (delivery.retryable) throw new Error("The song vote no-votes announcement is waiting for the automated output limit.");
  }
  if (vote?.state === "queued" && vote.drawnByLot && vote.requestId !== null) {
    const request = await readSongRequest(context.DB, context.channelId, vote.requestId);
    if (request !== null) {
      const language = await context.channelLanguage();
      const title = formatSongRequestTrack(request);
      const delivery = await context.sendChat(language === "en" ? `Tie – drawn by lot: ${title}` : `Gleichstand – das Los entscheidet: ${title}`,
        `song-vote-drawn:${action.ballotId}`, undefined, undefined, undefined, { automated: true });
      if (delivery.retryable) throw new Error("The song vote draw announcement is waiting for the automated output limit.");
    } else return;
  }
  if (vote?.state === "queued" && vote.requestId !== null) await scheduleSubmitAlarm(context, vote.requestId);
  if (vote?.state === "queued" && vote.requestId !== null) {
    await enqueueSongRequestAlert(context, vote.requestId);
  }
};

export const sendSongRequestStreamRecap = async (
  context: ModuleExecutionContext,
  channelId: string,
  streamId: string,
  settings: SongRequestsSettings,
): Promise<void> => {
  if (!settings.recap.chatEnabled || context.sendChat === undefined) return;
  const count = await context.DB.prepare(
    "SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND stream_id = ? AND state = 'observed_playing'",
  ).bind(channelId, streamId).first<{ count: number }>();
  const playedCount = count?.count ?? 0;
  if (playedCount === 0) return;
  const requesters = await context.DB.prepare(
    `SELECT requester_user_id, COALESCE(MAX(NULLIF(requester_display_name, '')), MAX(NULLIF(requester_login, ''))) AS display_name
       FROM song_requests
      WHERE channel_id = ? AND stream_id = ? AND state = 'observed_playing'
        AND source != 'mod_vote' AND requester_user_id IS NOT NULL
      GROUP BY requester_user_id
      ORDER BY MIN(observed_at), requester_user_id LIMIT 3`,
  ).bind(channelId, streamId).all<{ requester_user_id: string; display_name: string | null }>();
  const language = await context.channelLanguage();
  const names = requesters.results.flatMap(({ display_name }) => display_name === null ? [] : [display_name]);
  await context.sendChat(
    songRequestRecapMessage(songRequestChatTexts[language === "en" ? "en" : "de"], playedCount, names),
    `song-request-recap:${channelId}:${streamId}`,
  );
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

const nextSongRequestMaintenanceDeadline = async (db: D1Database, channelId: string, now: number): Promise<number | null> => {
  const cutoff = new Date(now - IN_FLIGHT_MAX_AGE_MS).toISOString();
  const [charging, submitting] = await Promise.all([
    db.prepare(
      `SELECT MIN(charging_since) AS started_at FROM song_requests
        WHERE channel_id = ? AND state = 'charging' AND charging_since >= ?`,
    ).bind(channelId, cutoff).first<{ started_at: string | null }>(),
    db.prepare(
      `SELECT MIN(updated_at) AS started_at FROM song_requests
        WHERE channel_id = ? AND state = 'submitting' AND updated_at >= ?`,
    ).bind(channelId, cutoff).first<{ started_at: string | null }>(),
  ]);
  const deadlines = [charging?.started_at, submitting?.started_at]
    .flatMap((startedAt) => {
      if (startedAt === null || startedAt === undefined) return [];
      const startedAtMs = Date.parse(startedAt);
      return Number.isFinite(startedAtMs) ? [startedAtMs + IN_FLIGHT_MAX_AGE_MS + 1] : [];
    });
  return deadlines.length === 0 ? null : Math.min(...deadlines);
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
    `INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at, poll_failures, poll_backoff_until)
     VALUES (?, 'not_connected', NULL, ?, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET
       poll_failures = excluded.poll_failures,
       updated_at = excluded.updated_at,
       poll_backoff_until = excluded.poll_backoff_until`,
  ).bind(context.channelId, new Date(now).toISOString(), failures, now + delay).run();
  // A failure backoff is a "not before" deadline, so it replaces an earlier alarm.
  await context.schedule(SONG_REQUESTS_ALARM, now + delay, undefined, streamGeneration);
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
  const connection = await context.DB.prepare(
    "SELECT state, poll_failures, poll_backoff_until FROM song_requests_connections WHERE channel_id = ?",
  ).bind(context.channelId).first<{ state: string; poll_failures: number; poll_backoff_until: number | null }>();
  await reconcileApprovedSubmissionAlarms(context);
  if (connection?.poll_backoff_until !== null && connection?.poll_backoff_until !== undefined && connection.poll_backoff_until > now) {
    let nextDeadline = connection.poll_backoff_until;
    if (pendingRefunds > 0) nextDeadline = Math.min(nextDeadline, now + BASE_BACKOFF_MS);
    const maintenanceDeadline = await nextSongRequestMaintenanceDeadline(context.DB, context.channelId, now);
    if (maintenanceDeadline !== null) nextDeadline = Math.min(nextDeadline, maintenanceDeadline);
    await context.schedule(SONG_REQUESTS_ALARM, nextDeadline, undefined, streamGeneration);
    return;
  }
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
    let isPlaying = true;
    if (response.status !== 204) {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const row = payload as Record<string, unknown>;
        const item = row.item;
        isPlaying = row.is_playing !== false;
        if (isSpotifyTrack(item)) track = item;
        progressMs = Number.isSafeInteger(row.progress_ms) && (row.progress_ms as number) >= 0 ? row.progress_ms as number : undefined;
      }
    } else {
      progressMs = null;
      isPlaying = false;
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
      isPlaying,
    );
    if (!snapshot.committed || !await playbackCycleIsCurrent(context, roundId)) return;
    if (snapshot.observedRequestId !== undefined) {
      await enqueueSongRequestSpotlightAlert(context, snapshot.observedRequestId);
    }
    await setConnectionState(context, "connected", new Date(now).toISOString());
    await context.DB.prepare(
      `UPDATE song_requests_connections SET poll_failures = 0, poll_backoff_until = NULL
        WHERE channel_id = ? AND (poll_failures > 0 OR poll_backoff_until IS NOT NULL)`,
    )
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
  alarmKey: string,
  _deadline: number,
  _ownerRevision: number | undefined,
  invocation?: unknown,
): Promise<void> => {
  if (typeof invocation === "object" && invocation !== null && (invocation as Record<string, unknown>).kind === "queue-overlay") {
    await notifyQueueOverlay(context);
    return;
  }
  if (alarmKey === "channel-point-resolutions") {
    await flushChannelPointResolutions(context);
    return;
  }
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
  const [module, channel] = await Promise.all([
    db.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(channelId).first<{ enabled: number; settings: string }>(),
    db.prepare("SELECT language FROM channels WHERE channel_id = ?").bind(channelId).first<{ language: string }>(),
  ]);
  if (module?.enabled !== 1) return { error: "module_disabled" };
  let settings: SongRequestsSettings;
  try {
    const rawSettings: unknown = JSON.parse(module.settings);
    settings = songRequestsSettingsSchema.parse({
      ...songRequestsSettingsForLanguage(channel?.language === "en" ? "en" : "de"),
      ...(typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings) ? rawSettings : {}),
    });
  }
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

const skipCommand = async (
  event: ModuleEvent<SongRequestsSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult | null> => {
  const message = typeof event.payload.message === "object" && event.payload.message !== null
    ? event.payload.message as Record<string, unknown> : null;
  if (typeof message?.text !== "string" || !/^!skip$/iu.test(message.text.trim())) return null;
  const language = await context.channelLanguage();
  const text = songRequestChatTexts[language === "en" ? "en" : "de"].skipVote;
  const userId = event.payload.chatter_user_id;
  const login = event.payload.chatter_user_login;
  if (typeof userId !== "string" || userId.length === 0 || typeof login !== "string" || login.length === 0 ||
      await context.botUserId?.() === userId ||
      typeof event.payload.source_broadcaster_user_id === "string" && event.payload.source_broadcaster_user_id !== event.channelId) return { actions: [], diagnostics: [] };

  const reply = (value: string): ModuleResult => ({ actions: [chatReply(event, value)], diagnostics: [] });
  const isModerator = event.chatStatus?.some((status) => status === "moderator" || status === "broadcaster") === true;
  if (isModerator) {
    const result = await skipSongTrackThroughChannelObject(context.runModuleAlarm === undefined
      ? undefined
      : (handlerKey, alarmKey, invocation) => context.runModuleAlarm?.(handlerKey, alarmKey, invocation) ?? Promise.resolve(undefined));
    if (result === "skipped") {
      await scheduleEventAlarmIfEarlier(context, SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + 1_000, undefined, null);
    }
    return reply(skipOutcomeChatReply(language, result));
  }

  const openBallotId = await openSkipVoteMapping(context.DB, event.channelId);
  if (openBallotId !== null) {
    const cast = context.castChatVote === undefined
      ? null
      : await context.castChatVote(openBallotId, userId, SKIP_VOTE_YES_CHOICE);
    return cast === null || cast.status === "not_open"
      ? reply(text.busy)
      : reply(text.cast);
  }

  const settings = songRequestsSettingsSchema.parse(event.settings);
  if (!settings.skipVote.enabled) return reply(text.disabled);
  const trackId = await nowPlayingTrackId(context.DB, event.channelId);
  if (trackId === null) return reply(text.nothingPlaying);
  const [connection, slotHeld] = await Promise.all([
    context.DB.prepare("SELECT state FROM song_requests_connections WHERE channel_id = ?")
      .bind(event.channelId).first<{ state: string }>(),
    spotifySlotHeld(context.DB, event.channelId),
  ]);
  if (!slotHeld || connection?.state === undefined || connection.state === "not_connected" || connection.state === "reconnect_required") {
    return reply(text.notConnected);
  }
  if (connection.state === "no_active_device") return reply(text.device);
  if (connection.state !== "connected") return reply(text.notConnected);

  const lastVote = await context.DB.prepare(
    `SELECT completed_at, skip_cooldown_seconds FROM song_requests_votes
      WHERE channel_id = ? AND vote_kind = 'skip' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, ballot_id DESC LIMIT 1`,
  ).bind(event.channelId).first<{ completed_at: string; skip_cooldown_seconds: number | null }>();
  if (lastVote !== null) {
    const cooldownSeconds = lastVote.skip_cooldown_seconds ?? settings.skipVote.cooldownSeconds;
    const remaining = Math.ceil((Date.parse(lastVote.completed_at) + cooldownSeconds * 1_000 - Date.now()) / 1_000);
    if (remaining > 0) return reply(text.cooldown(remaining));
  }
  if (await context.ballots.hasOpenBallot?.()) return reply(text.busy);
  if (context.startChatVote === undefined || context.castChatVote === undefined) return reply(text.busy);

  const stream = await context.DB.prepare("SELECT stream_id FROM channel_stream_state WHERE channel_id = ? AND state = 'online'")
    .bind(event.channelId).first<{ stream_id: string | null }>();
  const ballotId = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await createSkipVoteMapping(context.DB, {
    ballotId,
    channelId: event.channelId,
    streamId: stream?.stream_id ?? null,
    userId,
    startTrackId: trackId,
    threshold: settings.skipVote.threshold,
    cooldownSeconds: settings.skipVote.cooldownSeconds,
    now,
  });
  if (!inserted) return reply(text.busy);
  try {
    const started = await context.startChatVote({
      ballotId,
      kind: "yes_no",
      title: text.title,
      labels: [text.yesLabel, text.noLabel],
      durationSeconds: 30,
    });
    if (started.status !== "started" || started.ballotId !== ballotId) {
      await removeUnstartedSkipVoteMapping(context.DB, event.channelId, ballotId);
      return reply(text.busy);
    }
    const cast = await context.castChatVote(ballotId, userId, SKIP_VOTE_YES_CHOICE);
    return cast.status === "not_open" ? reply(text.busy) : reply(text.started);
  } catch {
    await removeUnstartedSkipVoteMapping(context.DB, event.channelId, ballotId);
    return reply(text.busy);
  }
};

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
    chatMessageId: typeof payload.message_id === "string" ? payload.message_id : null,
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
  if (current.state === "approved") await enqueueSongRequestAlert({ ...context, channelId: event.channelId }, requestId);
  if (scope.settings.mode === "automatic") {
    await context.scheduleAlarm(SONG_REQUESTS_SUBMIT_HANDLER, `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`, Date.now(), undefined, null);
    return { actions: [await queueOverlayChange({ DB: context.DB, channelId: event.channelId })], diagnostics: [] };
  }
  const position = admission.position ?? 1;
  const rendered = renderSongRequestTemplate(scope.settings.waitingText, {
    user: current.requesterDisplayName ?? current.requesterLogin ?? login,
    "song.track": formatSongRequestTrack(current),
    "song.artist": songRequestArtistDisplay(current.artists),
    "song.title": current.title,
    "song.album": current.albumName?.trim() ?? "",
    "song.position": position,
    "song.type": requestTypeLabel(current.requestType, language === "en" ? "en" : "de"),
  });
  const actions = scope.settings.waitingTextEnabled ? [chatReply(event, rendered)] : [];
  actions.push(await queueOverlayChange({ DB: context.DB, channelId: event.channelId }));
  return { actions, diagnostics: [] };
};

export const processSongRequestsEvent = async (event: ModuleEvent<SongRequestsSettings>, context: ModuleExecutionContext): Promise<ModuleResult> => {
  if (event.subscriptionType === "channel.chat.message") {
    const skipResult = await skipCommand(event, context);
    return skipResult ?? await processSongRequestCommand(event, context);
  }
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
      await sendSongRequestStreamRecap(context, event.channelId, streamId, settings);
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

