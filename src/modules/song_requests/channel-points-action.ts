import { z } from "zod";

import type { ChannelPointsActionDefinition, ModuleChannelPointsTerminalStatus, ModuleExecutionContext } from "../contract";
import {
  admitSongRequest,
  clearSongRequestChannelPointResolutionByOperation,
  ensureOfflineSongRequestRound,
  readSongRequestByOperationId,
  songRequestTrackFromSpotify,
  spotifySlotHeld,
  transitionRequest,
} from "./adapters/d1";
import { isOpenSongRequestState } from "./domain/rules";
import { spotifyTrackIdFromInput, type SpotifyTrack } from "./domain/track";
import { songRequestChannelPointsTexts } from "./channel-points-locale";
import { songRequestsSettingsSchema } from "./contracts";
import { SpotifyRequestError, spotifySearchTracks, spotifyTrackById } from "./adapters/spotify";

const requestSongConfigSchema = z.object({});
const refund = () => ({
  refund: {
    de: songRequestChannelPointsTexts.de.refund,
    en: songRequestChannelPointsTexts.en.refund,
  },
});

const scheduleAutomaticSubmit = async (context: ModuleExecutionContext, requestId: string): Promise<void> => {
  await context.scheduleAlarm("submit", `submit:${requestId}`, Date.now(), undefined, null);
};

const reportExisting = async (context: ModuleExecutionContext, operationId: string) => {
  if (context.channelId === undefined) return null;
  const existing = await readSongRequestByOperationId(context.DB, context.channelId, operationId);
  if (existing === null) return null;
  if (existing.state === "submitted" || existing.state === "observed_playing" || existing.state === "not_observed" ||
      (existing.state === "removed" && existing.submittedAt !== null)) return "fulfilled" as const;
  if (existing.state === "rejected" || existing.state === "failed" ||
      (existing.state === "removed" && existing.submittedAt === null)) return refund();
  return "pending" as const;
};

const actionScope = async (context: ModuleExecutionContext, now: string) => {
  const channelId = context.channelId;
  if (channelId === undefined) return null;
  const module = await context.DB.prepare(
    "SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'",
  ).bind(channelId).first<{ enabled: number; settings: string }>();
  if (module?.enabled !== 1) return null;
  let settings: ReturnType<typeof songRequestsSettingsSchema.parse>;
  try { settings = songRequestsSettingsSchema.parse(JSON.parse(module.settings) as unknown); }
  catch { return null; }
  const stream = await context.DB.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ state: string; stream_id: string | null }>();
  if (stream?.state === "online" && stream.stream_id !== null) {
    return { settings, settingsJson: module.settings, streamId: stream.stream_id, roundId: stream.stream_id };
  }
  if (stream?.state !== "offline" || !settings.alsoOffline) return null;
  const roundId = await ensureOfflineSongRequestRound(context.DB, channelId, now);
  return roundId === null ? null : { settings, settingsJson: module.settings, streamId: null, roundId };
};

const trackForInput = async (context: ModuleExecutionContext, value: string) => {
  const environment = context.environment;
  if (environment === undefined || context.runModuleAlarm === undefined) throw new Error("Spotify access is unavailable.");
  const accessToken: unknown = await context.runModuleAlarm("access_token", "read");
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new Error("Spotify access is unavailable.");
  const id = spotifyTrackIdFromInput(value);
  return id === null
    ? (await spotifySearchTracks(environment, accessToken, value))[0] ?? null
    : await spotifyTrackById(environment, accessToken, id);
};

const terminalCallback = async (
  context: ModuleExecutionContext,
  operationId: string,
  status: ModuleChannelPointsTerminalStatus,
): Promise<void> => {
  if (context.channelId === undefined) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = await readSongRequestByOperationId(context.DB, context.channelId, operationId);
    if (request === null) return;
    if (status === "FULFILLED" &&
        (request.state === "submitted" || request.state === "observed_playing" || request.state === "not_observed")) {
      await clearSongRequestChannelPointResolutionByOperation(context.DB, context.channelId, operationId);
      return;
    }
    const target = status === "CANCELED"
      ? request.state === "submitted" ? "removed"
        : isOpenSongRequestState(request.state) ? "rejected" : null
      : isOpenSongRequestState(request.state) ? "removed" : null;
    if (target === null) {
      await clearSongRequestChannelPointResolutionByOperation(context.DB, context.channelId, operationId);
      return;
    }
    const changed = await transitionRequest(context.DB, {
      channelId: context.channelId,
      requestId: request.requestId,
      fromState: request.state,
      toState: target,
      failureReason: status === "CANCELED" ? "twitch_canceled" : "twitch_fulfilled_externally",
      refundDue: false,
      suppressChannelPointsResolution: true,
      now: new Date().toISOString(),
    });
    if (changed) return;
  }
  throw new Error("The song-request ledger changed during external Twitch resolution.");
};

export const requestSongChannelPointsAction: ChannelPointsActionDefinition<typeof requestSongConfigSchema> = {
  id: "request-song",
  name: {
    de: songRequestChannelPointsTexts.de.name,
    en: songRequestChannelPointsTexts.en.name,
  },
  configSchema: requestSongConfigSchema,
  requiresUserInput: true,
  requiresAutomaticMode: true,
  execute: async (context, { redemption, operationId }) => {
    if (context.channelId === undefined || redemption.rewardId.length === 0) return refund();
    try {
      const existing = await reportExisting(context, operationId);
      if (existing !== null) return existing;
    } catch {
      return "pending";
    }

    const channelId = context.channelId;
    if (redemption.userId.length === 0 || redemption.userLogin.length === 0 || redemption.userInput.trim().length === 0) return refund();
    const now = Number.isFinite(Date.parse(redemption.redeemedAt)) ? redemption.redeemedAt : new Date().toISOString();
    let scope: Awaited<ReturnType<typeof actionScope>>;
    let rewardLimits = redemption.rewardLimits;
    try {
      scope = await actionScope(context, now);
      if (rewardLimits === undefined) {
        // Rows without a reward-limit snapshot use current values for backward compatibility.
        const reward = await context.DB.prepare(
          `SELECT max_per_user_per_stream, global_cooldown_seconds FROM channel_points_rewards
            WHERE channel_id = ? AND twitch_reward_id = ? AND enabled = 1 AND twitch_state = 'active'`,
        ).bind(channelId, redemption.rewardId).first<{
          max_per_user_per_stream: number | null;
          global_cooldown_seconds: number | null;
        }>();
        rewardLimits = reward === null ? undefined : {
          maxPerUserPerStream: reward.max_per_user_per_stream,
          globalCooldownSeconds: reward.global_cooldown_seconds,
        };
      }
    } catch {
      return "pending";
    }
    if (scope === null || rewardLimits === undefined || !await spotifySlotHeld(context.DB, channelId)) return refund();

    let track: SpotifyTrack | null;
    try {
      track = await trackForInput(context, redemption.userInput.trim().slice(0, 500));
    } catch (error) {
      if (error instanceof SpotifyRequestError && error.status === 404) return refund();
      return "pending";
    }
    if (track === null) return refund();

    const requestId = operationId;
    const admissionInput = {
      channelId,
      requestId,
      operationId,
      track: songRequestTrackFromSpotify(track),
      requestType: "channel_points" as const,
      channelPointsRewardId: redemption.rewardId,
      rewardMaxPerUserPerStream: rewardLimits.maxPerUserPerStream,
      rewardGlobalCooldownSeconds: rewardLimits.globalCooldownSeconds,
      streamId: scope.streamId,
      roundId: scope.roundId,
      settingsJson: scope.settingsJson,
      settings: scope.settings,
      requesterUserId: redemption.userId,
      requesterLogin: redemption.userLogin,
      requesterDisplayName: redemption.userName.length > 0 ? redemption.userName : redemption.userLogin,
      initialState: scope.settings.mode === "moderated" ? "pending_review" as const : "approved" as const,
      now,
    };
    if (scope.settings.mode === "automatic") {
      try { await scheduleAutomaticSubmit(context, requestId); }
      catch { return "pending"; }
    }
    let admission: Awaited<ReturnType<typeof admitSongRequest>>;
    try { admission = await admitSongRequest(context.DB, admissionInput); }
    catch { return "pending"; }
    if (!admission.accepted) {
      try {
        const existing = await reportExisting(context, operationId);
        if (existing !== null) return existing;
      } catch {
        return "pending";
      }
      return refund();
    }
    return "pending";
  },
  onRedemptionResolved: terminalCallback,
};
