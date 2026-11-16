import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { canManage, hasRequiredChannelRole } from "../../contracts/values";
import type { ModuleChatVoteStartResult, ModuleRouteEnvironment } from "../contract";
import { spotifySearchTracks, spotifyTrackById, SpotifyRequestError, type SpotifyEnvironment } from "./adapters/spotify";
import { spotifyTrackIdFromInput } from "./domain/track";
import { songVoteLabels } from "./domain/vote-labels";
import {
  closeOfflineSongRequestRound,
  cleanupSongRequestRound,
  ensureOfflineSongRequestRound,
  latestSongRequestStreamId,
  pendingSongRequestQueue,
  readSongRequest,
  recentSongRequests,
  recentSongVoteOutcomes,
  resolveUnknownRequest,
  songRequestTrackFromSpotify,
  spotifySlotHeld,
  transitionRequest,
} from "./adapters/d1";
import {
  songRequestRefundOperationId,
  retrySongRequestRefunds,
  reconcileStaleSongRequestCharges,
  songRequestQueueOverlayPayload,
  SONG_REQUESTS_CREDENTIAL_SECRET,
  SONG_REQUESTS_HANDLER,
  SONG_REQUESTS_ALARM,
  SONG_REQUESTS_SUBMIT_HANDLER,
  SONG_REQUESTS_SUBMIT_ALARM_PREFIX,
  SONG_REQUESTS_LIFECYCLE_HANDLER,
} from "./service";
import { songRequestsSettingsSchema } from "./contracts";

type RouteContext = Context<ModuleRouteEnvironment>;
type Body = Record<string, unknown>;
const bodyFrom = async (request: Request): Promise<Body | null> => {
  try { const value: unknown = await request.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Body : null; }
  catch { return null; }
};
const channel = (context: RouteContext): string => context.req.param("channelId") ?? "";
const flushChannelPointResolutions = async (context: RouteContext): Promise<void> => {
  await context.get("runModuleAlarm")(
    channel(context), "song_requests", SONG_REQUESTS_LIFECYCLE_HANDLER, "channel-point-resolutions",
  );
};
const scheduleChannelPointResolutionRetry = async (context: RouteContext): Promise<void> => {
  await context.get("scheduleModuleAlarm")(
    channel(context),
    "song_requests",
    SONG_REQUESTS_LIFECYCLE_HANDLER,
    "channel-point-resolutions",
    Date.now() + 15_000,
    null,
  );
};
const upstreamStatus = (error: unknown): ContentfulStatusCode => error instanceof SpotifyRequestError && error.status >= 400 && error.status < 600 ? error.status as ContentfulStatusCode : 502;
const isManager = (context: RouteContext): boolean => canManage(context.get("channelRole"));
const isModerator = (context: RouteContext): boolean => hasRequiredChannelRole(context.get("channelRole"), "operator");
const managerDenied = (context: RouteContext): Response => context.json({ error: "song_requests_manager_required" }, 403);
const moderatorDenied = (context: RouteContext): Response => context.json({ error: "song_requests_moderator_required" }, 403);
const spotifyEnvironment = (context: RouteContext): SpotifyEnvironment => context.env;
const accessEnabled = async (context: RouteContext): Promise<boolean> => await spotifySlotHeld(context.env.DB, channel(context));
const connectionRecord = async (context: RouteContext): Promise<{ state: string; error_message: string | null }> => (await context.env.DB.prepare(
  "SELECT state, error_message FROM song_requests_connections WHERE channel_id = ?",
).bind(channel(context)).first<{ state: string; error_message: string | null }>()) ?? { state: "not_connected", error_message: null };
const token = async (context: RouteContext): Promise<string | null> => await context.env.CHANNEL
  .get(context.env.CHANNEL.idFromName(channel(context))).getSpotifyAccessToken();
const updateConnectionFromRouteError = async (context: RouteContext, error: SpotifyRequestError): Promise<void> => {
  const state = error.reason === "invalid_grant" ? "reconnect_required"
    : error.status === 404 && error.reason === "NO_ACTIVE_DEVICE" ? "no_active_device"
      : error.status === 403 && error.reason === "PREMIUM_REQUIRED" ? "premium_required"
        : error.status === 403 ? "spotify_error" : null;
  if (state !== null) await context.env.DB.prepare("UPDATE song_requests_connections SET state = ?, error_message = ?, updated_at = ? WHERE channel_id = ?")
    .bind(state, state === "spotify_error" ? error.message.slice(0, 200) : null, new Date().toISOString(), channel(context)).run();
};
const streamId = async (context: RouteContext): Promise<string | null> => {
  const row = await context.env.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
    .bind(channel(context)).first<{ state: string; stream_id: string | null }>();
  return row?.state === "online" ? row.stream_id : null;
};

const currentRequestRound = async (context: RouteContext): Promise<{ streamId: string | null; roundId: string } | null> => {
  const channelId = channel(context);
  const [module, stream] = await Promise.all([
    context.env.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(channelId).first<{ enabled: number; settings: string }>(),
    context.env.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null }>(),
  ]);
  if (module?.enabled !== 1) return null;
  if (stream?.state === "online" && stream.stream_id !== null) return { streamId: stream.stream_id, roundId: stream.stream_id };
  if (stream?.state !== "offline") return null;
  try {
    if (!songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown).alsoOffline) return null;
  } catch { return null; }
  const roundId = await ensureOfflineSongRequestRound(context.env.DB, channelId, new Date().toISOString());
  return roundId === null ? null : { streamId: null, roundId };
};

const publishQueueState = async (context: RouteContext): Promise<void> => {
  await context.get("publishModuleOverlayMessage")(
    channel(context),
    "song_requests",
    "queue_changed",
    "song_requests.queue",
    await songRequestQueueOverlayPayload(context.env.DB, channel(context)),
  );
};

const retryRouteRefunds = async (context: RouteContext): Promise<void> => {
  const pending = await retrySongRequestRefunds({
    DB: context.env.DB,
    channelId: channel(context),
    points: context.get("points")(channel(context)),
  });
  const module = await context.env.DB.prepare(
    "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'",
  ).bind(channel(context)).first<{ enabled: number }>();
  if (pending > 0 && module?.enabled === 1) {
    await context.get("scheduleModuleAlarm")(
      channel(context), "song_requests", SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, Date.now() + 60_000, null,
    );
  }
};

const routeRefundExists = async (context: RouteContext, requestId: string): Promise<boolean> => {
  const operation = await context.get("points")(channel(context)).getOperation(songRequestRefundOperationId(requestId));
  return operation?.kind === "refund";
};

export const songRequestsRoutes = new Hono<ModuleRouteEnvironment>();

songRequestsRoutes.get("/connection", async (context) => {
  const channelId = channel(context);
  const access = await context.env.DB.prepare("SELECT slot FROM spotify_channel_access WHERE channel_id = ?").bind(channelId).first<{ slot: number }>();
  const credentialStatus = await context.get("secrets")(channelId).status(SONG_REQUESTS_CREDENTIAL_SECRET);
  if (access !== null) {
    try { await token(context); } catch (error) { console.error("Spotify connection status token lookup failed.", error); }
  }
  const connection = await connectionRecord(context);
  const stream = await streamId(context);
  const settingsRow = await context.env.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'").bind(channelId).first<{ settings: string }>();
  const pointsModule = await context.env.DB.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'points'").bind(channelId).first<{ enabled: number }>();
  let settings = songRequestsSettingsSchema.parse({});
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(settingsRow?.settings ?? "{}") as unknown); } catch { /* Invalid legacy settings use defaults. */ }
  return context.json({ enabled: access !== null, hasCredentials: credentialStatus.configured, slot: access?.slot ?? null, state: access === null ? "not_enabled" : connection.state, errorMessage: connection.error_message, streamId: stream,
    emptyText: settings.emptyText,
    alsoOffline: settings.alsoOffline,
    paymentMode: settings.paymentMode,
    pointsEnabled: pointsModule?.enabled === 1,
  });
});

songRequestsRoutes.post("/oauth/start", async (context) => {
  if (!isManager(context)) return managerDenied(context);
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const session = context.get("session");
  const begin = context.get("beginSpotifyOAuth");
  if (begin === undefined) return context.json({ error: "spotify_oauth_unavailable" }, 503);
  const transaction = await begin(channel(context), session.userId);
  const url = new URL(transaction.authorizationUrl);
  const state = url.searchParams.get("state");
  return context.json({ authorizationUrl: transaction.authorizationUrl }, 200, {
    "Set-Cookie": transaction.stateCookie,
    "Cache-Control": "no-store",
    ...(state === null ? {} : { "X-Spotify-OAuth-State": state }),
  });
});

songRequestsRoutes.post("/disconnect", async (context) => {
  if (!isManager(context)) return managerDenied(context);
  const secrets = context.get("secrets")(channel(context));
  const actor = { userId: context.get("session").userId, login: context.get("session").login ?? context.get("session").userId };
  const deleted = secrets.prepareDelete(SONG_REQUESTS_CREDENTIAL_SECRET, actor, new Date().toISOString());
  await context.env.DB.batch([deleted, context.env.DB.prepare(
    `INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at) VALUES (?, 'not_connected', NULL, ?)
     ON CONFLICT (channel_id) DO UPDATE SET state = 'not_connected', error_message = NULL, updated_at = excluded.updated_at`,
  ).bind(channel(context), new Date().toISOString())]);
  await context.get("runModuleAlarm")(channel(context), "song_requests", SONG_REQUESTS_HANDLER, SONG_REQUESTS_ALARM, { kind: "disconnect" });
  return context.json({ state: "not_connected" });
});

songRequestsRoutes.get("/search", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const query = (context.req.query("q") ?? "").trim();
  if (query.length === 0 || query.length > 200) return context.json({ error: "spotify_query_invalid" }, 400);
  let accessToken: string | null;
  try { accessToken = await token(context); } catch { return context.json({ error: "spotify_unavailable" }, 502); }
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const state = await connectionRecord(context);
  if (state.state !== "connected" && state.state !== "no_active_device") {
    return context.json({ error: `spotify_${state.state}`, message: state.error_message }, 409);
  }
  if (accessToken === null) return context.json({ error: "spotify_reconnect_required" }, 409);
  let tracks;
  try {
    const id = spotifyTrackIdFromInput(query);
    tracks = id === null ? await spotifySearchTracks(spotifyEnvironment(context), accessToken, query) : [await spotifyTrackById(spotifyEnvironment(context), accessToken, id)];
  } catch (error) {
    if (error instanceof SpotifyRequestError) await updateConnectionFromRouteError(context, error);
    const status = error instanceof SpotifyRequestError ? error.status : 502;
    return context.json({ error: error instanceof SpotifyRequestError ? error.reason ?? `spotify_${String(status)}` : "spotify_unavailable" }, upstreamStatus(error));
  }
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  return context.json({ tracks: tracks.map(songRequestTrackFromSpotify) });
});

songRequestsRoutes.post("/vote", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const requestRound = await currentRequestRound(context);
  if (requestRound === null) return context.json({ error: "stream_offline" }, 409);
  const body = await bodyFrom(context.req.raw);
  const ids = body?.trackIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 5 || !ids.every((id) => typeof id === "string" && /^[A-Za-z0-9]{1,64}$/u.test(id)) || new Set(ids).size !== ids.length) {
    return context.json({ error: "song_vote_candidates_invalid" }, 400);
  }
  let accessToken: string | null;
  try { accessToken = await token(context); } catch { return context.json({ error: "spotify_unavailable" }, 502); }
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const connection = await connectionRecord(context);
  if (connection.state !== "connected" && connection.state !== "no_active_device") {
    return context.json({ error: "spotify_not_connected", message: connection.error_message }, 409);
  }
  if (accessToken === null) return context.json({ error: "spotify_reconnect_required" }, 409);
  let tracks;
  try { tracks = await Promise.all(ids.map((id) => spotifyTrackById(spotifyEnvironment(context), accessToken, id as string))); }
  catch (error) {
    if (error instanceof SpotifyRequestError) await updateConnectionFromRouteError(context, error);
    return context.json({ error: error instanceof SpotifyRequestError ? error.reason ?? "spotify_track_unavailable" : "spotify_unavailable" }, upstreamStatus(error));
  }
  if (!await accessEnabled(context)) return context.json({ error: "spotify_not_enabled" }, 403);
  const labels = songVoteLabels(tracks);
  if (labels.length !== tracks.length) return context.json({ error: "song_vote_candidates_invalid" }, 400);
  const startChatVote = context.get("startChatVote");
  if (startChatVote === undefined) return context.json({ error: "chat_vote_unavailable" }, 503);
  const ballotId = crypto.randomUUID();
  const now = new Date().toISOString();
  const mapping = await context.env.DB.prepare(
    `INSERT INTO song_requests_votes
       (ballot_id, channel_id, stream_id, round_id, candidate_tracks_json, moderator_user_id, state, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 'open', ?
      WHERE EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1)
        AND EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
        AND ((? IS NOT NULL AND EXISTS (
          SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?
        )) OR (? IS NULL AND EXISTS (
          SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline'
        ) AND EXISTS (
          SELECT 1 FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ?
        ) AND EXISTS (
          SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
            AND json_extract(settings, '$.alsoOffline') = 1
        )))
     RETURNING ballot_id`,
  ).bind(ballotId, channel(context), requestRound.streamId, requestRound.roundId,
    JSON.stringify(tracks.map(songRequestTrackFromSpotify)), context.get("session").userId, now,
    channel(context), channel(context), requestRound.streamId, channel(context), requestRound.roundId,
    requestRound.streamId, channel(context), channel(context), requestRound.roundId, channel(context))
    .first<{ ballot_id: string }>();
  if (mapping === null) return context.json({ error: "stream_offline" }, 409);
  const removeUnstartedMapping = async (): Promise<void> => {
    await context.env.DB.prepare("DELETE FROM song_requests_votes WHERE channel_id = ? AND ballot_id = ? AND state = 'open'")
      .bind(channel(context), ballotId).run();
  };
  let started: ModuleChatVoteStartResult;
  try { started = await startChatVote(channel(context), { ballotId, title: "Song vote", labels, durationSeconds: 90 }); }
  catch (error) {
    await removeUnstartedMapping();
    if (error instanceof RangeError) return context.json({ error: "song_vote_candidates_invalid" }, 400);
    throw error;
  }
  if (started.status === "busy") {
    await removeUnstartedMapping();
    return context.json({ error: "chat_vote_already_open" }, 409);
  }
  if (started.ballotId !== ballotId) {
    await removeUnstartedMapping();
    return context.json({ error: "chat_vote_unavailable" }, 503);
  }
  return context.json({ ballotId: started.ballotId, tracks: tracks.map(songRequestTrackFromSpotify) }, 201);
});

songRequestsRoutes.get("/requests", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const current = await currentRequestRound(context);
  const requestStreamId = current?.roundId ?? await latestSongRequestStreamId(context.env.DB, channel(context), await streamId(context));
  return context.json({
    requests: await recentSongRequests(context.env.DB, channel(context), requestStreamId),
    voteOutcomes: await recentSongVoteOutcomes(context.env.DB, channel(context), requestStreamId),
  });
});

songRequestsRoutes.get("/queue", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const current = await currentRequestRound(context);
  if (current === null) return context.json({ count: 0, items: [] });
  const queue = await pendingSongRequestQueue(context.env.DB, channel(context), current.roundId);
  return context.json({ count: queue.count, items: queue.requests.map((row) => ({
    requestId: row.requestId,
    title: row.title,
    spotifyUrl: row.spotifyUrl,
    artists: row.artists,
    requester: row.requesterDisplayName ?? row.requesterLogin ?? "",
    requestType: row.requestType,
    state: row.state,
    createdAt: row.createdAt,
  })) });
});

songRequestsRoutes.post("/requests/:requestId/approve", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const current = await currentRequestRound(context);
  if (current === null) return context.json({ error: "stream_offline" }, 409);
  const requestId = context.req.param("requestId");
  const changed = await transitionRequest(context.env.DB, {
    channelId: channel(context), requestId, fromState: "pending_review", toState: "approved",
    activeRoundId: current.roundId, now: new Date().toISOString(),
  });
  if (!changed) return context.json({ error: "song_request_not_pending_review" }, 409);
  await context.get("scheduleModuleAlarm")(
    channel(context), "song_requests", SONG_REQUESTS_SUBMIT_HANDLER,
    `${SONG_REQUESTS_SUBMIT_ALARM_PREFIX}${requestId}`, Date.now(), current.streamId === null ? null : undefined,
  );
  await publishQueueState(context);
  return context.json({ state: "approved" });
});

songRequestsRoutes.post("/requests/:requestId/reject", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const requestId = context.req.param("requestId");
  await retryRouteRefunds(context);
  await scheduleChannelPointResolutionRetry(context);
  const changed = await transitionRequest(context.env.DB, {
    channelId: channel(context), requestId, fromState: "pending_review", toState: "rejected",
    failureReason: "moderator_rejected", refundDue: true, now: new Date().toISOString(),
  });
  if (!changed) {
    await retryRouteRefunds(context);
    return context.json({ error: "song_request_not_pending_review" }, 409);
  }
  await flushChannelPointResolutions(context);
  await retryRouteRefunds(context);
  await publishQueueState(context);
  return context.json({ state: "rejected" });
});

songRequestsRoutes.post("/requests/:requestId/remove", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const body = await bodyFrom(context.req.raw);
  if (typeof body?.refund !== "boolean") return context.json({ error: "song_request_removal_invalid" }, 400);
  const requestId = context.req.param("requestId");
  const row = await readSongRequest(context.env.DB, channel(context), requestId);
  if (row === null) return context.json({ error: "song_request_missing" }, 404);
  if (body.refund && row.requestType === "channel_points" && row.state === "submitted") {
    return context.json({ error: "song_request_channel_points_already_fulfilled" }, 409);
  }
  await retryRouteRefunds(context);
  if (row.state === "pending_review" || row.state === "approved") {
    await scheduleChannelPointResolutionRetry(context);
    const changed = await transitionRequest(context.env.DB, {
      channelId: channel(context), requestId, fromState: row.state, toState: "rejected",
      failureReason: "moderator_removed_before_submission", refundDue: true, now: new Date().toISOString(),
    });
    if (!changed) return context.json({ error: "song_request_state_changed" }, 409);
    await flushChannelPointResolutions(context);
    await retryRouteRefunds(context);
    await publishQueueState(context);
    const refunded = row.requestType === "bot_points" && await routeRefundExists(context, requestId);
    return context.json({ state: "rejected", refunded });
  }
  if (row.state !== "submitted" && row.state !== "outcome_unknown") return context.json({ error: "song_request_not_removable" }, 409);
  await scheduleChannelPointResolutionRetry(context);
  const changed = await transitionRequest(context.env.DB, {
    channelId: channel(context), requestId, fromState: row.state, toState: "removed",
    // An unclear Spotify send may still have queued the song, so the result chat must keep saying so.
    failureReason: row.state === "outcome_unknown" ? "submit_outcome_uncertain"
      : body.refund ? "moderator_removed_with_refund" : "moderator_removed",
    refundDue: body.refund,
    now: new Date().toISOString(),
  });
  if (!changed) return context.json({ error: "song_request_state_changed" }, 409);
  await flushChannelPointResolutions(context);
  if (body.refund) await retryRouteRefunds(context);
  await publishQueueState(context);
  const refunded = body.refund && row.requestType === "bot_points" && await routeRefundExists(context, requestId);
  return context.json({ state: "removed", refunded });
});

songRequestsRoutes.post("/clear", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const current = await currentRequestRound(context);
  if (current === null) return context.json({ error: "stream_offline" }, 409);
  if (current.streamId === null && await closeOfflineSongRequestRound(context.env.DB, channel(context), current.roundId) === null) {
    return context.json({ cleared: false });
  }
  const reconciledCharges = await reconcileStaleSongRequestCharges({
    DB: context.env.DB,
    channelId: channel(context),
    points: context.get("points")(channel(context)),
  }, Date.now(), current.roundId);
  await scheduleChannelPointResolutionRetry(context);
  const result = await cleanupSongRequestRound(context.env.DB, channel(context), current.roundId, new Date().toISOString(), "list_cleared");
  await flushChannelPointResolutions(context);
  await retryRouteRefunds(context);
  await context.get("publishModuleOverlayMessage")(
    channel(context), "song_requests", "state_changed", "song_requests.now_playing", { revision: result.revision },
  );
  await publishQueueState(context);
  return context.json({ cleared: result.changed || reconciledCharges > 0 });
});

songRequestsRoutes.post("/requests/:requestId/resolve", async (context) => {
  if (!isModerator(context)) return moderatorDenied(context);
  const body = await bodyFrom(context.req.raw);
  const state = body?.state;
  if (state !== "submitted" && state !== "failed") return context.json({ error: "song_request_resolution_invalid" }, 400);
  await retryRouteRefunds(context);
  await scheduleChannelPointResolutionRetry(context);
  const changed = await resolveUnknownRequest(context.env.DB, channel(context), context.req.param("requestId"), state, new Date().toISOString());
  if (!changed) {
    await retryRouteRefunds(context);
    return context.json({ error: "song_request_not_outcome_unknown" }, 409);
  }
  await flushChannelPointResolutions(context);
  if (state === "failed") {
    await retryRouteRefunds(context);
  }
  await publishQueueState(context);
  return context.json({ state });
});

