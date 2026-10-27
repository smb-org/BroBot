import type { EventCode } from "../contracts/values";
import type { BotModule, ChatOutputTarget, ModuleAction, ModuleActor, ModuleChannelInfo, ModuleChatDelivery, ModuleChatStatus, ModuleDiagnostic, ModuleEvent, ModuleFollowedAt, ModuleLanguage, ModuleResult, ModuleStreamState, ModuleTextBlockConditionDefinition, StoredPointWelcome } from "../modules/contract";
import type { RealtimeMessage } from "../realtime-contract";
import { MODULES, validateModuleTemplateVariable, variablesForModuleTemplateContext } from "../modules/registry";
import {
  getChannelMemberForChannel,
} from "./db/channel-members";
import { sendChatMessage } from "./chat";
import { sendChatAnnouncement } from "./announcement";
import { fetchTwitchUserByLogin, sendShoutout } from "./shoutout";
import { isTwitchChannelModerator, sendModerationBan } from "./moderation";
import { publishRealtimeMessages, publishVariablesChanged } from "./realtime";
import { prepareModuleOverlayHostEventMessages, prepareModuleOverlayRealtimeMessage } from "./module-overlay-realtime";
import { writeModuleDiagnostics, type WrittenModuleDiagnostic } from "./event-log";
import { authorizeModuleMutation } from "./module-authorization";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import { readChannelBlockedTerms } from "./twitch/blocked-terms";
import {
  isOlderOnlineEventThanHelixOfflineObservation,
  readChannelStreamState,
  writeEventSubStreamStateWithGeneration,
} from "./db/stream-state";
import { lookupAndRefreshStreamState } from "./stream-state-lookup";
import { moduleEnabledForChannel, readChannelControls, readDispatchChannelState } from "./db/channel-controls";
import { readChannelDefaultChatTarget, readChannelLocation } from "./db/channel-settings";
import { getBotIdentity, getCachedBotUserId } from "./db/bot-identity";
import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import { readChannelVariables, prepareChannelVariableChange, prepareResetChannelVariablesForStream } from "./db/channel-variables";
import { createTemplateRenderer, secureRandomInteger, type TemplateChannelDetails, type TemplateStreamDetails, type TemplateValueProvider } from "./template-resolver";
import type { ChannelVariableOperation } from "../contracts/values";
import type { TemplateVariable } from "../template";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../modules/contract";
import { chatOutputSuppressionReason } from "./chat-output-gate";
import { createModuleExternalFetchBudget } from "./external-fetch-budget";
import { countStatisticsEmotes, statisticsTextFragments, statisticsWindowStart } from "../modules/statistics/domain";
import { botAccessTokenFor } from "./twitch/bot-access";
import { moduleBallots } from "./module-ballots";
import { modulePoints } from "./module-points";
import { createModuleSecretReadAccess } from "./module-secrets";
import { recordChannelGameHistory } from "./db/game-search-cache";
import { broadcasterHasScope } from "./broadcaster-scope";
import { writeChannelTimelineEvent } from "./db/timeline-events";
import { notifyModuleScheduleInputsChanged } from "./module-schedules";
import { pointsCatalog } from "../modules/points/locale";
import { pointsSettingsReadSchema } from "../modules/points/contracts";
import { appendPointWelcome, type PendingPointWelcome } from "./point-welcome";

export interface DispatchEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  PUBLIC_ORIGIN?: string;
  CHANNEL?: Env["CHANNEL"];
}

/** The host logs actions and their outcome; modules justify inaction. */
const HOST_MODULE_ID = "host";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const arrayValue = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const streamStateForEvent = async (
  environment: DispatchEnvironment,
  channelId: string,
  fetcher: typeof fetch,
): Promise<ModuleStreamState> =>
  (await lookupAndRefreshStreamState(environment as unknown as Env, channelId, new Date().toISOString(), fetcher)).state ?? "unknown";

const firstDataRecord = (result: unknown): Readonly<Record<string, unknown>> | null => {
  if (!recordValue(result) || !arrayValue(result.data)) return null;
  const first = result.data[0];
  return recordValue(first) ? first : null;
};

const channelDetailsFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  accessTokenFor: () => Promise<string>,
  fetcher: typeof fetch,
): Promise<TemplateChannelDetails | null> => {
  try {
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/channels",
      query: { broadcaster_id: channelId },
      accessToken: await accessTokenFor(),
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok) return null;
    const channel = firstDataRecord(result.data);
    if (channel === null || typeof channel.title !== "string" || typeof channel.game_name !== "string") return null;
    return {
      title: channel.title,
      gameName: channel.game_name,
      gameId: typeof channel.game_id === "string" ? channel.game_id : "",
    };
  } catch {
    return null;
  }
};

const streamDetailsFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  accessTokenFor: () => Promise<string>,
  fetcher: typeof fetch,
): Promise<TemplateStreamDetails | null> => {
  try {
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: channelId, type: "live" },
      accessToken: await accessTokenFor(),
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok || !recordValue(result.data) || !arrayValue(result.data.data)) return null;
    const stream = result.data.data[0];
    if (stream === undefined) return { startedAt: null, viewerCount: 0 };
    if (!recordValue(stream) || typeof stream.started_at !== "string") return null;
    const viewerCount = typeof stream.viewer_count === "number" && Number.isSafeInteger(stream.viewer_count)
      ? stream.viewer_count
      : 0;
    return { startedAt: stream.started_at, viewerCount };
  } catch {
    return null;
  }
};

const channelInfoFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  accessTokenFor: () => Promise<string>,
  fetcher: typeof fetch,
): Promise<ModuleChannelInfo | null> => {
  const [channel, stream] = await Promise.all([
    channelDetailsFor(environment, channelId, accessTokenFor, fetcher),
    streamDetailsFor(environment, channelId, accessTokenFor, fetcher),
  ]);
  return channel === null || stream === null ? null : { ...channel, ...stream };
};

const totalFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  endpoint: "followers" | "chatters",
  fetcher: typeof fetch,
): Promise<number | null> => {
  try {
    const bot = await botAccessTokenFor(environment);
    if (bot === null) return null;
    const url = endpoint === "followers"
      ? "https://api.twitch.tv/helix/channels/followers"
      : "https://api.twitch.tv/helix/chat/chatters";
    const result = await helixRequest<{ data?: unknown; total?: unknown }>({
      url,
      query: { broadcaster_id: channelId, moderator_id: bot.userId },
      accessToken: bot.accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok || !recordValue(result.data) || !Number.isSafeInteger(result.data.total)) return null;
    const total: unknown = result.data.total;
    return typeof total === "number" && total >= 0 ? total : null;
  } catch {
    return null;
  }
};

const userCreatedAtFor = async (
  environment: DispatchEnvironment,
  userId: string,
  fetcher: typeof fetch,
): Promise<string | null> => {
  try {
    const accessToken = await getAppAccessToken(environment as unknown as Env, new Date().toISOString(), fetcher);
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/users",
      query: { id: userId },
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    const user = result.ok ? firstDataRecord(result.data) : null;
    return user !== null && typeof user.created_at === "string" ? user.created_at : null;
  } catch {
    return null;
  }
};

const followedAtFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  userId: string,
  fetcher: typeof fetch,
): Promise<ModuleFollowedAt> => {
  try {
    const identity = await getBotIdentity(environment.DB);
    if (identity === null) return "unavailable";
    const value = await decryptJson<{ token?: unknown }>(
      identity.accessTokenCiphertext,
      parseKeyRing(getTokenEncryptionKeys(environment)),
    );
    if (value === null || typeof value.token !== "string" || value.token.length === 0) return "unavailable";
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/channels/followers",
      query: { broadcaster_id: channelId, user_id: userId, moderator_id: identity.userId },
      accessToken: value.token,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok || !recordValue(result.data) || !arrayValue(result.data.data)) return "unavailable";
    if (result.data.data.length === 0) return null;
    const first = result.data.data[0];
    return recordValue(first) && typeof first.followed_at === "string" ? first.followed_at : "unavailable";
  } catch {
    return "unavailable";
  }
};

const channelTimeZoneFor = async (db: D1Database, channelId: string): Promise<string> => {
  const row = await db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId)
    .first<{ time_zone: string }>();
  return row?.time_zone ?? DEFAULT_CHANNEL_TIME_ZONE;
};

const recordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enabledPointsGameMinimumStake = (
  activations: readonly { moduleId: string; enabled: boolean; settings: string }[],
  registry: readonly BotModule[],
): number | null => {
  const modules = new Map(registry.map((module) => [module.id, module]));
  let minimum: number | null = null;
  for (const activation of activations) {
    if (!activation.enabled) continue;
    const module = modules.get(activation.moduleId);
    if (module?.requiresModules?.includes("points") !== true) continue;
    try {
      const settings = (module.settingsReadSchema ?? module.settingsSchema).parse(JSON.parse(activation.settings));
      const minStake = recordValue(settings) ? settings.minStake : undefined;
      if (typeof minStake === "number" && Number.isSafeInteger(minStake) && minStake > 0) {
        minimum = minimum === null ? minStake : Math.min(minimum, minStake);
      }
    } catch {
      // An invalid game setting cannot define a safe threshold.
    }
  }
  return minimum;
};

export const chatStatusFor = (
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
): readonly ModuleChatStatus[] | null => {
  if (subscriptionType !== "channel.chat.message") return null;
  const badges = payload.badges;
  const badgeIds = Array.isArray(badges)
    ? badges.flatMap((badge) => {
      if (!recordValue(badge)) return [];
      const setId = badge.set_id;
      return typeof setId === "string" ? [setId] : [];
    })
    : [];
  // Multiple badges can apply at once. VIP and subscriber therefore stay
  // separate statuses; `founder` still counts as subscriber. Without any
  // special badges, the list is never empty for a chat event — it gets `viewer`.
  const statuses: ModuleChatStatus[] = [];
  if (badgeIds.includes("broadcaster")) statuses.push("broadcaster");
  if (badgeIds.includes("moderator")) statuses.push("moderator");
  if (badgeIds.includes("vip")) statuses.push("vip");
  if (badgeIds.includes("subscriber") || badgeIds.includes("founder")) statuses.push("subscriber");
  return statuses.length === 0 ? ["viewer"] : statuses;
};

export const actorForEvent = async (
  db: D1Database,
  channelId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<ModuleActor | null> => {
  const userId = textValue(payload.chatter_user_id);
  if (userId === null) return null;
  const login = textValue(payload.chatter_user_login) ?? textValue(payload.chatter_user_name) ?? userId;
  const member = await getChannelMemberForChannel(db, channelId, userId);
  return { userId, login, role: member?.role ?? null };
};

/**
 * Determines the modules allowed to see this event in this channel: enabled
 * in `channel_modules`, known in the registry, responsible per
 * `eventSubTypes`.
 *
 * A `module_id` the registry doesn't know is a visible error state, not a
 * crash — it happens when a module is removed but its activation row stays.
 */
export const selectModulesForEvent = (
  activations: readonly { moduleId: string; enabled: boolean; settings: string }[],
  subscriptionType: string,
  registry: readonly BotModule[] = MODULES,
  paused = false,
): { matches: { module: BotModule; settings: string }[]; unknownModules: string[] } => {
  const known = new Map(registry.map((module) => [module.id, module]));
  const matches: { module: BotModule; settings: string }[] = [];
  const unknownModules: string[] = [];
  const matchedModules = new Set<string>();
  for (const activation of activations) {
    const module = known.get(activation.moduleId);
    if (module === undefined) {
      if (activation.enabled) unknownModules.push(activation.moduleId);
      continue;
    }
    const mandatory = module.mandatory === true;
    if (!activation.enabled && !mandatory) continue;
    if (paused && !mandatory && !(module.pauseSafeEventSubTypes ?? []).includes(subscriptionType)) continue;
    if (!(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    matches.push({ module, settings: activation.settings });
    matchedModules.add(module.id);
  }
  for (const module of registry) {
    if (module.mandatory !== true || matchedModules.has(module.id) ||
        !(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    matches.push({ module, settings: JSON.stringify(module.defaultSettings) });
  }
  const registrationOrder = new Map(registry.map((module, index) => [module.id, index]));
  matches.sort((left, right) => (registrationOrder.get(left.module.id) ?? 0) - (registrationOrder.get(right.module.id) ?? 0));
  return { matches, unknownModules };
};

export const needsActiveChatterTracking = (
  activations: readonly { moduleId: string; enabled: boolean }[],
  registry: readonly BotModule[] = MODULES,
): boolean => {
  const enabledModuleIds = new Set(activations.filter((activation) => activation.enabled).map((activation) => activation.moduleId));
  return registry.some((module) => module.needsActiveChatters === true &&
    (module.mandatory === true || enabledModuleIds.has(module.id)));
};

const commandRouteMatchesModule = (
  module: BotModule,
  event: Pick<ModuleEvent, "payload" | "subscriptionType">,
  settings?: unknown,
): boolean => {
  if (event.subscriptionType !== "channel.chat.message") return false;
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const text: unknown = Reflect.get(message, "text");
  if (typeof text !== "string") return false;
  const commandName = text.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  if (commandName === undefined || !commandName.startsWith("!")) return false;
  if (module.id === "text_commands") return true;
  const configured = module.chatCommandNames?.(settings) ?? [];
  return module.chatCommands?.some((command) => command.name.toLowerCase() === commandName) === true ||
    configured.some((name) => name.toLowerCase() === commandName);
};

// The `ursache`/`typ`/`meldung` detail keys below stay: they land in
// event_log.detail_json (a wire/stored shape), and this file lives outside
// `src/modules`, so the frozen detailKeys() test in
// tests/unit/detail-keys.test.ts never sees them either way.
const runActions = async (
  environment: DispatchEnvironment,
  channelId: string,
  module: BotModule,
  actions: readonly ModuleAction[],
  muted: boolean,
  fetcher: typeof fetch,
  attributions: readonly string[] = [],
  sourceBroadcasterUserId?: string | null,
  pendingWelcome?: PendingPointWelcome,
  handledMessageId?: string,
  commandResponseActions: WeakSet<ModuleAction> = new WeakSet(),
  actorUserId?: string | null,
  triggerId?: string,
): Promise<ModuleDiagnostic[]> => {
  const diagnostics: ModuleDiagnostic[] = [];
  const pendingActions = [...actions];
  const moderationFollowUps = new WeakSet<ModuleAction>();
  const targetFor = async (target: ChatOutputTarget | undefined): Promise<ChatOutputTarget> =>
    target ?? await readChannelDefaultChatTarget(environment.DB, channelId);
  // Order is preserved: a reply after an announcement reads as a different
  // conversation than the reverse.
  for (let index = 0; index < pendingActions.length; index += 1) {
    let action = pendingActions[index];
    if (action === undefined) continue;
    const isModerationFollowUp = moderationFollowUps.has(action);
    const commandResponseMessageId = commandResponseActions.has(action) ? handledMessageId : undefined;
    // Moderation follow-ups never carry or acknowledge the welcome, threaded or not.
    if (!isModerationFollowUp) {
      const claimId = `dispatch:${triggerId ?? handledMessageId ?? "event"}:${module.id}:${String(index)}`;
      const candidate = pendingWelcome === undefined ? undefined : {
        ...pendingWelcome,
        deliveryClaimId: claimId,
      };
      const preview = appendPointWelcome(action, module, candidate, attributions, commandResponseMessageId);
      if (preview !== action && pendingWelcome?.access.claimWelcome !== undefined) {
        let claimed: StoredPointWelcome | null = null;
        try {
          claimed = await pendingWelcome.access.claimWelcome(pendingWelcome.accountId, pendingWelcome.operationId, claimId);
        } catch {
          // If the account claim is unavailable, leave the welcome pending for a later reply.
        }
        if (claimed !== null) {
          const authoritative = appendPointWelcome(action, module, {
            ...claimed,
            access: pendingWelcome.access,
            deliveryClaimId: claimId,
            used: false,
          }, attributions, commandResponseMessageId);
          if (authoritative !== action) action = authoritative;
          else await pendingWelcome.access.releaseWelcome?.(pendingWelcome.accountId, pendingWelcome.operationId, claimId);
        }
      } else action = preview;
    }
    const reportDelivery = async (
      delivery: ModuleChatDelivery,
      postedWelcomeClaimId?: string,
      postedWelcomeOperationId?: string,
    ): Promise<void> => {
      if (action.kind !== "chat" || action.onDelivery === undefined) return;
      try {
        await action.onDelivery(delivery, postedWelcomeClaimId, postedWelcomeOperationId);
      } catch (error: unknown) {
        diagnostics.push({ code: "host.action.failed" satisfies EventCode, detail: { message: errorMessage(error) } });
      }
    };
    const moderationAction = action.kind === "timeout" || action.kind === "ban";
    let mutedForAction = muted;
    let pausedForAction = false;
    if ((action.kind === "chat" || action.kind === "announcement") && isModerationFollowUp) {
      const controls = await readChannelControls(environment.DB, channelId, new Date().toISOString());
      mutedForAction = controls.mute.active;
      pausedForAction = controls.pause.active;
    }
    const suppressionReason = moderationAction
      ? null
      : chatOutputSuppressionReason({
        moduleEnabled: true,
        mandatory: isModerationFollowUp ? module.mandatory === true : true,
        paused: pausedForAction,
        muted: mutedForAction,
      });
    if (suppressionReason !== null &&
        (action.kind === "chat" || action.kind === "announcement" || action.kind === "shoutout" || moderationAction)) {
      await reportDelivery("not_attempted");
      diagnostics.push({
        code: "host.action.suppressed" satisfies EventCode,
        detail: { action: action.kind, reason: suppressionReason },
      });
      continue;
    }
    try {
      if (action.kind === "chat") {
        let outputClaimed = false;
        const claimBeforePost = action.automated === false ? undefined : async (): Promise<boolean | "rate_limited"> => {
          if (outputClaimed) return true;
          if (environment.CHANNEL === undefined) {
            outputClaimed = true;
            return true;
          }
          try {
            outputClaimed = await environment.CHANNEL
              .get(environment.CHANNEL.idFromName(channelId))
              .claimAutomatedChatOutput();
            return outputClaimed ? true : "rate_limited";
          } catch {
            return "rate_limited";
          }
        };
        const result = await sendChatMessage(
          environment,
          channelId,
          action.text,
          action.replyToMessageId,
          fetcher,
          undefined,
          claimBeforePost,
          attributions,
          undefined,
          await targetFor(action.target),
          sourceBroadcasterUserId,
          undefined,
          action.pointWelcome,
        );
        await reportDelivery(result.delivery, result.postedWelcomeClaimId, result.postedWelcomeOperationId);
        if (result.truncated) {
          diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: action.text.length } });
        }
        diagnostics.push(result.sent
          ? { code: "host.chat.sent" satisfies EventCode, detail: result.detail }
          : result.reason === "rate_limited"
            ? { code: "host.chat.skipped" satisfies EventCode, detail: { reason: "automated_output_rate_limited", ...result.detail } }
            : { code: "host.chat.failed" satisfies EventCode, detail: { reason: result.reason, ...result.detail } });
        continue;
      }
      if (action.kind === "announcement") {
        const target = await targetFor(action.target);
        let outputClaimed = false;
        const claimBeforePost = action.automated === false ? undefined : async (): Promise<boolean> => {
          if (outputClaimed) return true;
          if (environment.CHANNEL === undefined) {
            outputClaimed = true;
            return true;
          }
          try {
            outputClaimed = await environment.CHANNEL
              .get(environment.CHANNEL.idFromName(channelId))
              .claimAutomatedChatOutput();
            return outputClaimed;
          } catch {
            return false;
          }
        };
        const result = await sendChatAnnouncement(
          environment, channelId, action.text, fetcher, attributions, target, sourceBroadcasterUserId, claimBeforePost,
        );
        if (result.truncated) {
          diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: action.text.length } });
        }
        if (result.sent) {
          diagnostics.push({ code: "host.announcement.sent" satisfies EventCode, detail: result.detail });
          continue;
        }

        if (result.reason === "rate_limited") {
          diagnostics.push({
            code: "host.chat.skipped" satisfies EventCode,
            detail: { reason: "automated_output_rate_limited", ...result.detail },
          });
          continue;
        }

        try {
          const fallback = await sendChatMessage(
            environment,
            channelId,
            action.text,
            undefined,
            fetcher,
            undefined,
            claimBeforePost === undefined ? undefined : async () => outputClaimed || await claimBeforePost(),
            attributions,
            undefined,
            target,
            sourceBroadcasterUserId,
          );
          if (fallback.truncated && !result.truncated) {
            diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: action.text.length } });
          }
          diagnostics.push({
            code: "host.announcement.failed" satisfies EventCode,
            detail: {
              reason: result.reason ?? "unknown_error",
              outcome: fallback.sent ? "sent_as_message" : "not_sent",
              ...(typeof result.detail.status === "number" ? { status: result.detail.status } : {}),
              ...(typeof result.detail.twitchMessage === "string" ? { twitchMessage: result.detail.twitchMessage } : {}),
            },
          });
          diagnostics.push(fallback.sent
            ? { code: "host.chat.sent" satisfies EventCode, detail: fallback.detail }
            : { code: "host.chat.failed" satisfies EventCode, detail: { reason: fallback.reason, ...fallback.detail } });
        } catch (error: unknown) {
          diagnostics.push({
            code: "host.announcement.failed" satisfies EventCode,
            detail: {
              reason: result.reason ?? "unknown_error",
              outcome: "not_sent",
              ...(typeof result.detail.status === "number" ? { status: result.detail.status } : {}),
              ...(typeof result.detail.twitchMessage === "string" ? { twitchMessage: result.detail.twitchMessage } : {}),
            },
          });
          diagnostics.push({ code: "host.action.failed" satisfies EventCode, detail: { message: errorMessage(error) } });
        }
        continue;
      }
      if (action.kind === "shoutout") {
        let targetChannelId: string;
        let targetLogin: string | undefined;
        if ("targetChannelId" in action) {
          targetChannelId = action.targetChannelId;
          targetLogin = "targetLogin" in action ? action.targetLogin : undefined;
        } else {
          targetLogin = action.targetLogin;
          try {
            const user = await fetchTwitchUserByLogin(fetcher, environment as unknown as Env, action.targetLogin, "app");
            if (user === null) {
              diagnostics.push({
                code: "host.shoutout.failed" satisfies EventCode,
                detail: { cause: "twitch_user_not_found", target: action.targetLogin },
              });
              continue;
            }
            targetChannelId = user.userId;
          } catch {
            diagnostics.push({
              code: "host.shoutout.failed" satisfies EventCode,
              detail: { cause: "twitch_user_search_failed", target: action.targetLogin },
            });
            continue;
          }
        }
        const result = await sendShoutout(environment, channelId, targetChannelId, fetcher);
        const successDetail = targetLogin === undefined ? result.detail : { ...result.detail, toLogin: targetLogin };
        diagnostics.push(result.sent
          ? { code: "host.shoutout.sent" satisfies EventCode, detail: successDetail }
          : { code: "host.shoutout.failed" satisfies EventCode, detail: { cause: result.reason, ...result.detail } });
        continue;
      }
      if (action.kind === "clip") {
        if (environment.CHANNEL === undefined || triggerId === undefined) {
          diagnostics.push({
            code: "host.clip.failed" satisfies EventCode,
            detail: { reason: environment.CHANNEL === undefined ? "channel_object_unavailable" : "trigger_id_missing" },
          });
          continue;
        }
        const channelNamespace = environment.CHANNEL;
        const channelObjectId = channelNamespace.idFromName(channelId);
        const enqueue = (): Promise<"enqueued" | "duplicate" | "cooldown"> => channelNamespace.get(channelObjectId).enqueueClipJob(
          triggerId,
          actorUserId ?? null,
          { postClipLinkInChat: action.postClipLinkInChat, chatLinkTemplate: action.chatLinkTemplate },
          action.cooldownSeconds,
        );
        try {
          const outcome = await enqueue();
          if (outcome === "cooldown") {
            diagnostics.push({ code: "text_commands.cooldown" satisfies EventCode, detail: { name: "clip" } });
          }
        } catch {
          try {
            // The same trigger key makes an uncertain first response safe to retry.
            const outcome = await enqueue();
            if (outcome === "cooldown") {
              diagnostics.push({ code: "text_commands.cooldown" satisfies EventCode, detail: { name: "clip" } });
            }
          } catch (error: unknown) {
            diagnostics.push({
              code: "host.clip.failed" satisfies EventCode,
              detail: { reason: "job_enqueue_failed", message: errorMessage(error) },
            });
          }
        }
        continue;
      }
      if (action.kind === "timeout" || action.kind === "ban") {
        if (!await moduleEnabledForChannel(environment.DB, channelId, module.id, module.mandatory === true)) {
          diagnostics.push({
            code: "host.action.suppressed" satisfies EventCode,
            detail: { action: action.kind, reason: "module_disabled" },
          });
          continue;
        }
        const result = await sendModerationBan(environment, channelId, {
          userId: action.userId,
          durationSeconds: action.kind === "timeout" ? action.durationSeconds : null,
          reason: action.reason,
        }, fetcher);
        if (result.outcome === "suppressed") {
          diagnostics.push({
            code: "host.action.suppressed" satisfies EventCode,
            detail: { action: action.kind, reason: result.reason },
          });
          continue;
        }
        const detail = result.reason === null ? result.detail : { ...result.detail, cause: result.reason };
        const code: EventCode = action.kind === "timeout"
          ? result.outcome === "applied" ? "host.timeout.applied"
            : result.outcome === "ambiguous" ? "host.timeout.ambiguous" : "host.timeout.failed"
          : result.outcome === "applied" ? "host.ban.applied"
            : result.outcome === "ambiguous" ? "host.ban.ambiguous" : "host.ban.failed";
        diagnostics.push({ code, detail });
        if (result.outcome !== "ambiguous") {
          const followUp = result.outcome === "applied" ? action.onSuccess : action.onFailure;
          if (followUp !== undefined) {
            moderationFollowUps.add(followUp);
            pendingActions.splice(index + 1, 0, followUp);
          }
        }
        continue;
      }
      const prepared = await prepareModuleOverlayRealtimeMessage(
        environment.DB,
        channelId,
        module.id,
        action,
        module.mandatory === true,
      );
      if (prepared.outcome === "rejected") {
        diagnostics.push({
          code: "host.overlay.not_executed" satisfies EventCode,
          detail: { type: action.type },
        });
      } else if (prepared.outcome === "ready") {
        await publishRealtimeMessages(environment.CHANNEL, [prepared.message]);
      }
    } catch (error: unknown) {
      await reportDelivery("ambiguous");
      // A failed action must not suppress the subsequent ordered actions,
      // e.g. the chat message after a shoutout.
      diagnostics.push({ code: "host.action.failed" satisfies EventCode, detail: { message: errorMessage(error) } });
    }
  }
  return diagnostics;
};

/**
 * Dispatches a verified EventSub event to the responsible modules and runs
 * their actions.
 *
 * The target channel comes from the event, not from the module — this
 * means a module can't act on a channel other than its own.
 */
export const dispatchEventSubNotification = async (
  environment: DispatchEnvironment,
  event: {
    channelId: string;
    subscriptionType: string;
    subscriptionVariant?: string;
    triggerId: string;
    payload: Readonly<Record<string, unknown>>;
    receivedAt: string;
    eventSubTimestamp?: string;
  },
  fetcher: typeof fetch = fetch,
  registry: readonly BotModule[] = MODULES,
): Promise<void> => {
  const externalFetchBudget = createModuleExternalFetchBudget();
  if (event.subscriptionType === "stream.online" || event.subscriptionType === "stream.offline") {
    const online = event.subscriptionType === "stream.online";
    if (online) {
      await writeChannelTimelineEvent(environment.DB, event.channelId, {
        kind: "stream_online",
        identity: event.triggerId,
        occurredAt: event.eventSubTimestamp ?? event.receivedAt,
        streamId: textValue(event.payload.id),
        detail: { startedAt: textValue(event.payload.started_at) },
      });
    } else {
      await writeChannelTimelineEvent(environment.DB, event.channelId, {
        kind: "stream_offline",
        identity: event.triggerId,
        occurredAt: event.eventSubTimestamp ?? event.receivedAt,
        detail: {},
      });
    }
  }
  if (event.subscriptionType === "channel.raid") {
    const sourceId = textValue(event.payload.from_broadcaster_user_id);
    const targetId = textValue(event.payload.to_broadcaster_user_id);
    const viewers = event.payload.viewers;
    const incoming = targetId === event.channelId && sourceId !== null && sourceId !== event.channelId;
    const outgoing = sourceId === event.channelId && targetId !== null && targetId !== event.channelId;
    if ((incoming || outgoing) && typeof viewers === "number" && Number.isSafeInteger(viewers) && viewers >= 0) {
      const partnerId = incoming ? sourceId : targetId;
      const partnerLogin = textValue(event.payload[incoming ? "from_broadcaster_user_login" : "to_broadcaster_user_login"]) ?? partnerId;
      const partnerDisplayName = textValue(event.payload[incoming ? "from_broadcaster_user_name" : "to_broadcaster_user_name"]) ?? partnerLogin;
      await writeChannelTimelineEvent(environment.DB, event.channelId, {
        kind: incoming ? "raid_incoming" : "raid_outgoing",
        identity: event.triggerId,
        occurredAt: event.eventSubTimestamp ?? event.receivedAt,
        detail: { viewers, partner: { id: partnerId, login: partnerLogin, displayName: partnerDisplayName } },
      });
    }
  }
  if (event.subscriptionType === "channel.ad_break.begin") {
    const startedAt = textValue(event.payload.started_at);
    const durationSeconds = event.payload.duration_seconds;
    if (startedAt !== null && Number.isSafeInteger(durationSeconds) && (durationSeconds as number) >= 0) {
      try {
        if (await broadcasterHasScope(environment.DB, event.channelId, "channel:read:ads")) {
          await writeChannelTimelineEvent(environment.DB, event.channelId, {
            kind: "ad_break",
            identity: event.triggerId,
            occurredAt: startedAt,
            detail: { durationSeconds: durationSeconds as number, startedAt },
          });
        }
      } catch (error: unknown) {
        console.warn("Ad-break timeline eligibility could not be checked.", error);
      }
    }
  }
  // `channel.update` already carries the new category, so the shared game-id
  // cache (FAQ and text-command game filters) can be corrected immediately
  // instead of serving the old game until its TTL expires.
  if (event.subscriptionType === "channel.update") {
    const occurredAt = event.eventSubTimestamp ?? event.receivedAt;
    const title = typeof event.payload.title === "string" ? event.payload.title : null;
    const categoryId = textValue(event.payload.category_id);
    const categoryName = textValue(event.payload.category_name);
    const category = categoryId === null ? null : { id: categoryId, name: categoryName };
    await writeChannelTimelineEvent(environment.DB, event.channelId, {
      kind: "channel_metadata",
      identity: event.triggerId,
      occurredAt,
      detail: { title, category },
    });
    if (environment.CHANNEL !== undefined) {
      try {
        const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
        await object.updateCachedChannelGameId(textValue(event.payload.category_id), Date.now());
      } catch (error: unknown) {
        console.warn("Channel game cache could not be updated.", error);
      }
    }
    const gameId = categoryId;
    const gameName = categoryName;
    if (gameId !== null && gameName !== null) {
      try {
        await recordChannelGameHistory(environment.DB, event.channelId, gameId, gameName, occurredAt);
      } catch (error: unknown) {
        console.warn("Channel game history could not be recorded.", error);
      }
    }
  }
  // The ending stream remains current while its offline event is dispatched.
  // Capture that session's controls before the stored state moves to offline.
  const changedVariables = new Map<string, number>();
  const overlayIdsByVariable = new Map<string, readonly string[]>();
  let streamStateChanged: RealtimeMessage | null = null;
  let streamStateTransitionGeneration: number | undefined;
  const endingStreamDispatchState = event.subscriptionType === "stream.offline"
    ? await readDispatchChannelState(environment.DB, event.channelId, event.receivedAt)
    : null;
  if (event.subscriptionType === "stream.online" || event.subscriptionType === "stream.offline") {
    // The `started_at` Twitch sends on `stream.online` is the actual stream
    // start, distinct from `event.receivedAt` (used only for write ordering).
    const isOnline = event.subscriptionType === "stream.online";
    const startedAt = isOnline ? textValue(event.payload.started_at) : null;
    const streamId = isOnline ? textValue(event.payload.id) : null;
    const currentStream = isOnline ? await readChannelStreamState(environment.DB, event.channelId) : null;
    const streamBefore = currentStream ?? (endingStreamDispatchState === null ? null : {
      state: endingStreamDispatchState.streamState,
      startedAt: endingStreamDispatchState.streamStartedAt,
      streamId: endingStreamDispatchState.streamId,
    });
    if (isOnline && isOlderOnlineEventThanHelixOfflineObservation(currentStream, startedAt)) {
      // A stream's start can predate a more recent offline poll even though
      // its notification arrived later. Reconcile Twitch's current state
      // before considering that old online event for the state write.
      await lookupAndRefreshStreamState(
        environment as unknown as Env,
        event.channelId,
        event.receivedAt,
        fetcher,
        { forceRefresh: true },
      );
    }
    const stateWrite = await writeEventSubStreamStateWithGeneration(
      environment.DB,
      event.channelId,
      event.subscriptionType === "stream.online" ? "online" : "offline",
      event.eventSubTimestamp ?? event.receivedAt,
      startedAt,
      streamId,
    );
    streamStateTransitionGeneration = stateWrite.transitionGeneration ?? undefined;
    if (stateWrite.result === "written" && stateWrite.transitionGeneration !== null) {
      const channelNamespace = environment.CHANNEL as NonNullable<typeof environment.CHANNEL>;
      const endedAt = event.eventSubTimestamp ?? event.receivedAt;
      const endedSession = streamBefore?.state === "online" && streamBefore.streamId !== null &&
          (!isOnline || streamBefore.streamId !== streamId)
        ? { streamId: streamBefore.streamId, startedAt: streamBefore.startedAt, endedAt }
        : undefined;
      try {
        await channelNamespace.get(channelNamespace.idFromName(event.channelId)).transitionTimerStream({
          state: isOnline ? "online" : "offline",
          streamId,
          startedAt,
          generation: stateWrite.transitionGeneration,
          ...(endedSession === undefined ? {} : { endedSession }),
        });
      } catch (error: unknown) {
        console.warn("Timer stream state could not be updated.", error);
        try {
          await notifyModuleScheduleInputsChanged(environment.CHANNEL, event.channelId, "stream_state");
        } catch (retryError: unknown) {
          console.warn("Timer stream state repair could not be queued.", retryError);
        }
      }
    }
    if (stateWrite.result === "written" &&
        (streamBefore?.state !== (isOnline ? "online" : "offline") ||
          streamBefore.startedAt !== startedAt || streamBefore.streamId !== streamId)) {
      const controls = await readChannelControls(environment.DB, event.channelId, event.receivedAt);
      streamStateChanged = {
        version: 1,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        channelId: event.channelId,
        type: "stream.state.changed",
        payload: {
          state: isOnline ? "online" : "offline",
          startedAt,
          changedAt: event.eventSubTimestamp ?? event.receivedAt,
          controls,
        },
      };
    }
    if (event.subscriptionType === "stream.offline" && stateWrite.result === "ambiguous_offline") {
      // A start-less live row or an event exactly on the session boundary
      // cannot safely determine whether this session ended. Ask Helix even
      // when the cached state is otherwise fresh.
      await lookupAndRefreshStreamState(
        environment as unknown as Env,
        event.channelId,
        event.receivedAt,
        fetcher,
        { forceRefresh: true },
      );
    }
    if (isOnline && stateWrite.result === "written" && startedAt !== null) {
      const reset = await prepareResetChannelVariablesForStream(
        environment.DB,
        event.channelId,
        startedAt,
        event.eventSubTimestamp ?? event.receivedAt,
        streamId,
      );
      for (const name of reset.names) {
        changedVariables.set(name, 0);
        overlayIdsByVariable.set(name, reset.overlayIdsByVariable[name] ?? []);
      }
    }
  }
  const dispatchState = endingStreamDispatchState ??
    await readDispatchChannelState(environment.DB, event.channelId, event.receivedAt);
  const trackActiveChatters = needsActiveChatterTracking(dispatchState.activations, registry);
  if (environment.CHANNEL !== undefined) {
    const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
    if (event.subscriptionType === "channel.chat.message") {
      try {
        const sourceBroadcasterId = event.payload.source_broadcaster_user_id;
        const belongsToChannel = sourceBroadcasterId === undefined || sourceBroadcasterId === null ||
          sourceBroadcasterId === event.channelId;
        const chatterUserId = textValue(event.payload.chatter_user_id);
        const isBotMessage = chatterUserId !== null && chatterUserId === await getCachedBotUserId(environment.DB);
        if (belongsToChannel && !isBotMessage) {
          const windowStart = dispatchState.streamState === "online"
            ? statisticsWindowStart(event.receivedAt)
            : null;
          if (windowStart === null) {
            await object.recordChatActivity(chatterUserId, trackActiveChatters);
          } else {
            await object.recordChatActivity(chatterUserId, trackActiveChatters, {
              windowStart: new Date(windowStart).toISOString(),
              receivedAt: event.receivedAt,
              emotes: countStatisticsEmotes(event.payload),
              streamId: dispatchState.streamId,
              textFragments: statisticsTextFragments(event.payload),
            });
          }
        }
      } catch (error: unknown) {
        console.warn("Channel chat activity could not be counted.", error);
      }
    }
  }
  const { matches, unknownModules } = selectModulesForEvent(dispatchState.activations, event.subscriptionType, registry, dispatchState.controls.pause.active);
  const actor = await actorForEvent(environment.DB, event.channelId, event.payload);
  const newEntries: WrittenModuleDiagnostic[] = [];
  let streamStatePromise: Promise<ModuleStreamState> | undefined;
  let channelInfoPromise: Promise<ModuleChannelInfo | null> | undefined;
  let channelDetailsPromise: Promise<TemplateChannelDetails | null> | undefined;
  let streamDetailsPromise: Promise<TemplateStreamDetails | null> | undefined;
  let botUserIdPromise: Promise<string | null> | undefined;
  let appAccessTokenPromise: Promise<string> | undefined;
  let channelTimeZonePromise: Promise<string> | undefined;
  let channelLocationPromise: ReturnType<typeof readChannelLocation> | undefined;
  let followerTotalPromise: Promise<number | null> | undefined;
  let chattersTotalPromise: Promise<number | null> | undefined;
  let blockedTermsPromise: Promise<readonly string[] | null> | undefined;
  const followedAtPromises = new Map<string, Promise<ModuleFollowedAt>>();
  const userCreatedAtPromises = new Map<string, Promise<string | null>>();
  const streamState = (): Promise<ModuleStreamState> => {
    streamStatePromise ??= streamStateForEvent(environment, event.channelId, fetcher);
    return streamStatePromise;
  };
  const appAccessToken = (): Promise<string> => {
    appAccessTokenPromise ??= getAppAccessToken(environment as unknown as Env, new Date().toISOString(), fetcher);
    return appAccessTokenPromise;
  };
  const botUserId = (): Promise<string | null> => {
    botUserIdPromise ??= getCachedBotUserId(environment.DB);
    return botUserIdPromise;
  };
  const channelBlockedTerms = (): Promise<readonly string[] | null> => {
    blockedTermsPromise ??= readChannelBlockedTerms(environment, event.channelId, fetcher);
    return blockedTermsPromise;
  };
  const isRecentBotMessage = async (senderId: string | null, text: string): Promise<boolean> => {
    if (environment.CHANNEL === undefined) return false;
    const channelObject = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
    return await channelObject.isRecentBotChatMessage(senderId, text);
  };
  const channelDetails = (): Promise<TemplateChannelDetails | null> => {
    channelDetailsPromise ??= channelDetailsFor(environment, event.channelId, appAccessToken, fetcher);
    return channelDetailsPromise;
  };
  const streamDetails = (): Promise<TemplateStreamDetails | null> => {
    streamDetailsPromise ??= streamDetailsFor(environment, event.channelId, appAccessToken, fetcher);
    return streamDetailsPromise;
  };
  const channelInfo = (): Promise<ModuleChannelInfo | null> => {
    channelInfoPromise ??= channelInfoFor(environment, event.channelId, appAccessToken, fetcher);
    return channelInfoPromise;
  };
  const channelGameId = async (): Promise<string | null> => {
    if (environment.CHANNEL !== undefined) {
      try {
        const channelObject = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
        return await channelObject.getCachedChannelGameId(Date.now());
      } catch (error: unknown) {
        // The cached lookup lives in the Durable Object; if that call itself
        // fails (not just the Helix request inside it), fall back to the
        // direct Helix path rather than letting the error reach every module.
        console.warn("Channel game lookup via Durable Object failed; falling back to Helix.", error);
      }
    }
    const details = await channelDetails();
    return details === null || details.gameId.length === 0 ? null : details.gameId;
  };
  const followedAt = (userId: string): Promise<ModuleFollowedAt> => {
    let pending = followedAtPromises.get(userId);
    if (pending === undefined) {
      pending = followedAtFor(environment, event.channelId, userId, fetcher);
      followedAtPromises.set(userId, pending);
    }
    return pending;
  };
  const channelLanguage = (): Promise<ModuleLanguage> => Promise.resolve(dispatchState.language);
  const channelTimeZone = (): Promise<string> => {
    channelTimeZonePromise ??= channelTimeZoneFor(environment.DB, event.channelId);
    return channelTimeZonePromise;
  };
  const channelLocation = () => {
    channelLocationPromise ??= readChannelLocation(environment.DB, event.channelId);
    return channelLocationPromise;
  };
  const followerTotal = (): Promise<number | null> => {
    followerTotalPromise ??= totalFor(environment, event.channelId, "followers", fetcher);
    return followerTotalPromise;
  };
  const chattersTotal = (): Promise<number | null> => {
    chattersTotalPromise ??= totalFor(environment, event.channelId, "chatters", fetcher);
    return chattersTotalPromise;
  };
  const userCreatedAt = (userId: string): Promise<string | null> => {
    let pending = userCreatedAtPromises.get(userId);
    if (pending === undefined) {
      pending = userCreatedAtFor(environment, userId, fetcher);
      userCreatedAtPromises.set(userId, pending);
    }
    return pending;
  };
  const channelVariables = (names: readonly string[]) => readChannelVariables(environment.DB, event.channelId, names);
  const prepareVariableChange = (
    channelId: string,
    change: { name: string; operation: ChannelVariableOperation; amount: number | null },
    now: string,
    claim: { commandName: string; revision: number; userId: string | null },
  ): D1PreparedStatement => {
    if (channelId !== event.channelId) throw new Error("Variable changes must use the event channel.");
    return prepareChannelVariableChange(environment.DB, channelId, change, now, claim);
  };

  const registeredModuleVariables = new Map<string, readonly TemplateVariable[]>();
  const registeredModuleConditions = new Map<string, readonly ModuleTextBlockConditionDefinition[]>();
  await Promise.all(registry.map(async (module) => {
    let dynamicVariables: readonly TemplateVariable[];
    let dynamicConditions: readonly ModuleTextBlockConditionDefinition[];
    try {
      [dynamicVariables, dynamicConditions] = await Promise.all([
        module.templateVariableNamespace === "text_blocks"
          ? Promise.resolve([] as readonly TemplateVariable[])
          : module.templateVariables?.(environment.DB, event.channelId) ?? Promise.resolve([]),
        module.textBlockConditionsForChannel?.(environment.DB, event.channelId) ?? Promise.resolve([]),
      ]);
    } catch {
      dynamicVariables = [];
      dynamicConditions = [];
    }
    const staticVariables = [
      ...(module.templateVariableCatalog ?? []),
      ...Object.values(module.templateFields ?? {}).flatMap((variables) => variables ?? []),
    ] as TemplateVariable[];
    const variables = variablesForModuleTemplateContext(module, [...staticVariables, ...dynamicVariables]);
    for (const variable of variables) validateModuleTemplateVariable(module, variable.name);
    registeredModuleVariables.set(module.id, variables);
    registeredModuleConditions.set(module.id, [...(module.textBlockConditions ?? []), ...dynamicConditions]);
  }));
  const registeredTemplateVariables = registry
    .filter((module) => module.templateVariableNamespace !== "text_blocks")
    .flatMap((module) => registeredModuleVariables.get(module.id) ?? []);
  const templateValueProviders: TemplateValueProvider[] = registry.flatMap((provider) => {
    const resolveTemplateValues = provider.resolveTemplateValues;
    if (resolveTemplateValues === undefined && provider.resolveTemplateParameter === undefined) return [];
    return [{
      moduleId: provider.id,
      ...(provider.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: provider.templateVariableNamespace }),
      variables: registeredModuleVariables.get(provider.id) ?? [],
      textBlockConditions: registeredModuleConditions.get(provider.id) ?? [],
      ...(provider.templateUnavailableText === undefined ? {} : { templateUnavailableText: provider.templateUnavailableText }),
      ...(provider.resolveTemplateConditions === undefined ? {} : { resolveTemplateConditions: provider.resolveTemplateConditions }),
      ...(provider.dynamicTemplateVariableNames === undefined ? {} : { dynamicTemplateVariableNames: provider.dynamicTemplateVariableNames }),
      ...(provider.resolveOverlayTemplateValues === undefined ? {} : { resolveOverlayTemplateValues: provider.resolveOverlayTemplateValues }),
      ...(provider.resolveTemplateConditionTransitions === undefined ? {} : { resolveTemplateConditionTransitions: provider.resolveTemplateConditionTransitions }),
      ...(resolveTemplateValues === undefined ? {} : { resolveTemplateValues }),
      ...(provider.resolveTemplateParameter === undefined ? {} : { resolveTemplateParameter: provider.resolveTemplateParameter }),
    }];
  });

  for (const moduleId of unknownModules) {
    newEntries.push(...await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      HOST_MODULE_ID,
      event.triggerId,
      null,
      [{ code: "host.module.unknown" satisfies EventCode, detail: { moduleId: moduleId } }],
      event.receivedAt,
    ));
  }

  const streamStateTransitionAccepted = streamStateChanged !== null;
  let pendingWelcome: PendingPointWelcome | undefined;
  let pointChatPrepared: { welcomePending: boolean; pendingWelcome: StoredPointWelcome | null } | undefined;
  const pointsMatch = matches.find(({ module }) => module.id === "points");
  const chatterUserId = textValue(event.payload.chatter_user_id);
  const chatterLogin = textValue(event.payload.chatter_user_login);
  const messageId = textValue(event.payload.message_id);
  const sourceBroadcasterUserId = textValue(event.payload.source_broadcaster_user_id);
  if (pointsMatch !== undefined && event.subscriptionType === "channel.chat.message" && chatterUserId !== null &&
      chatterLogin !== null && messageId !== null && (sourceBroadcasterUserId === null || sourceBroadcasterUserId === event.channelId)) {
    try {
      const botUserId = await getCachedBotUserId(environment.DB);
      if (chatterUserId !== botUserId) {
        const settings = pointsSettingsReadSchema.parse(JSON.parse(pointsMatch.settings));
        const access = modulePoints(environment.CHANNEL, event.channelId, "points");
        const threshold = !settings.safetyNetEnabled ? null : settings.safetyNetThreshold === "min_stake"
          ? enabledPointsGameMinimumStake(dispatchState.activations, registry)
          : settings.safetyNetThreshold;
        const parsedTimestamp = Date.parse(event.eventSubTimestamp ?? event.receivedAt);
        const messageAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
        const prepared = await access.prepareChatActivity(
          chatterUserId,
          chatterLogin,
          settings.startBonus,
          messageAt,
          await streamState() === "online",
          { amount: settings.activityAmount, windowMinutes: settings.windowMinutes, dailyCap: settings.dailyCap },
          threshold === null ? null : { amount: settings.safetyNetAmount, threshold },
          {
            messageId,
            language: dispatchState.language,
            currencyName: settings.currencyName,
            safetyNetText: pointsCatalog[dispatchState.language].chat.safetyNet(settings.safetyNetAmount, settings.currencyName),
          },
        );
        pointChatPrepared = { welcomePending: prepared.welcomePending, pendingWelcome: prepared.pendingWelcome };
        if (prepared.pendingWelcome !== null) {
          pendingWelcome = { ...prepared.pendingWelcome, access, used: false };
        }
      }
    } catch {
      // The module handler retries the account touch and reports any failure through its normal diagnostics.
    }
  }

  for (const { module, settings } of matches) {
    const diagnostics: ModuleDiagnostic[] = [];
    let result: ModuleResult | null = null;
    let isCommandResponseHandler = false;

    try {
      const activation = dispatchState.activations.find((candidate) => candidate.moduleId === module.id);
      const points = modulePoints(
        environment.CHANNEL,
        event.channelId,
        module.id,
        module.requiresModules?.includes("points") === true && pendingWelcome !== undefined && !pendingWelcome.used
          ? {
            accountId: pendingWelcome.accountId,
            operationId: pendingWelcome.operationId,
            messageId: pendingWelcome.messageId,
            text: pendingWelcome.text,
            kind: pendingWelcome.kind,
          }
          : undefined,
      );
      if (module.requiresModules?.includes("points") === true && activation !== undefined) {
        await points.rounds.setGate(!activation.enabled, activation.revision, activation.lastDisabledRevision);
      }
      const validatedSettings: unknown = (module.settingsReadSchema ?? module.settingsSchema).parse(JSON.parse(settings));
      isCommandResponseHandler = commandRouteMatchesModule(module, event, validatedSettings);
      const channelNamespace = environment.CHANNEL;
      const statisticsChat = module.id === "statistics" && channelNamespace !== undefined
        ? {
          markWordStreamEnded: (streamId: string, endedAt: string) =>
            channelNamespace.get(channelNamespace.idFromName(event.channelId))
              .markStatisticsWordStreamEnded(streamId, endedAt),
        }
        : undefined;
      const moduleEvent: ModuleEvent = {
        channelId: event.channelId,
        subscriptionType: event.subscriptionType,
        ...(event.subscriptionVariant === undefined ? {} : { subscriptionVariant: event.subscriptionVariant }),
        triggerId: event.triggerId,
        payload: event.payload,
        settings: validatedSettings,
        receivedAt: event.receivedAt,
        ...(event.eventSubTimestamp === undefined ? {} : { eventSubTimestamp: event.eventSubTimestamp }),
        ...(module.id === "points" && pointChatPrepared !== undefined ? { pointChatPrepared } : {}),
        actor,
        chatStatus: chatStatusFor(event.subscriptionType, event.payload),
      };
      const moduleVariables = [
        ...(module.templateVariableCatalog ?? []),
        ...Object.values(module.templateFields ?? {}).flatMap((variables) => variables ?? []),
      ] as TemplateVariable[];
      const templateContext = module.templateContext ?? "event";
      const render = createTemplateRenderer(moduleEvent, templateContext, moduleVariables, {
        DB: environment.DB,
        moduleSecrets: (providerModuleId) => createModuleSecretReadAccess(environment, event.channelId, providerModuleId),
        externalFetchBudget,
        ...(environment.CHANNEL === undefined ? {} : {
          runModuleAlarm: (moduleId: string, handlerKey: string, alarmKey: string, invocation?: unknown) => {
            const object = environment.CHANNEL?.get(environment.CHANNEL.idFromName(event.channelId));
            if (object === undefined) throw new Error("The channel Durable Object is unavailable.");
            return invocation === undefined
              ? object.runModuleAlarm(moduleId, handlerKey, alarmKey)
              : object.runModuleAlarm(moduleId, handlerKey, alarmKey, invocation);
          },
        }),
        ...(environment.PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: environment.PUBLIC_ORIGIN }),
        channelInfo,
        channelGameId,
        channelTimeZone,
        channelLocation,
        templateValueProviders,
        registeredTemplateVariables,
        streamState,
        channelDetails,
        streamDetails,
        followedAt,
        followerTotal,
        chattersTotal,
        userCreatedAt,
        channelLanguage,
        readChannelVariables: channelVariables,
      });
        result = module.handleEvent === undefined
          ? null
          : await module.handleEvent(moduleEvent, {
            DB: environment.DB,
            authorizeMutation: authorizeModuleMutation,
            ballots: moduleBallots(environment.CHANNEL, event.channelId, module.id),
            points,
            readChannelBlockedTerms: channelBlockedTerms,
            botUserId,
            lookupUserByLogin: async (login) => {
              const user = await fetchTwitchUserByLogin(fetcher, environment as unknown as Env, login, "app");
              return user === null ? null : { userId: user.userId, login: user.login, displayName: user.displayName };
            },
            lookupUserByLoginWithBotToken: async (login) => {
              const user = await fetchTwitchUserByLogin(fetcher, environment as unknown as Env, login, "bot");
              return user === null ? null : { userId: user.userId, login: user.login, displayName: user.displayName };
            },
            isChannelModerator: (userId) => isTwitchChannelModerator(environment, event.channelId, userId, fetcher),
            isRecentBotMessage,
            streamState,
            streamStateTransitionAccepted,
            ...(streamStateTransitionAccepted && streamStateTransitionGeneration !== undefined
              ? { streamStateTransitionGeneration }
              : {}),
            ...(statisticsChat === undefined ? {} : { statisticsChat }),
            ...(streamStateTransitionAccepted && event.subscriptionType === "stream.offline" && endingStreamDispatchState !== null
              ? { streamSession: { streamId: endingStreamDispatchState.streamId, startedAt: endingStreamDispatchState.streamStartedAt } }
              : {}),
            chatActivityCount: async () => {
              if (environment.CHANNEL === undefined) return 0;
              return await environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId)).getChatActivityCount();
            },
            activeChatters: {
              count: async (windowMs) => {
                if (module.needsActiveChatters !== true || environment.CHANNEL === undefined) return 0;
                return await environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId)).getActiveChatterCount(windowMs);
              },
              seen: async (userId) => {
                if (module.needsActiveChatters !== true || environment.CHANNEL === undefined) return null;
                return await environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId)).getActiveChatter(userId);
              },
            },
            channelInfo,
            channelGameId,
            followedAt,
            followerTotal,
            chattersTotal,
            userCreatedAt,
            readChannelVariables: channelVariables,
            renderTemplate: render,
            prepareVariableChange,
            secureRandomInteger,
            channelLanguage,
            channelTimeZone,
            scheduleAlarm: async (handlerKey, alarmKey, deadline, ownerRevision, streamGeneration, identity, planSequence) => {
              if (environment.CHANNEL === undefined) return;
              const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
              if (ownerRevision === undefined && streamGeneration === undefined && identity === undefined && planSequence === undefined) {
                await object.scheduleModuleAlarm(module.id, handlerKey, alarmKey, deadline);
              } else {
                await object.scheduleModuleAlarm(module.id, handlerKey, alarmKey, deadline,
                  ownerRevision, streamGeneration, identity, planSequence);
              }
            },
            clearAlarm: async (alarmKey, ownerRevision, streamGeneration, expectedIdentity, planSequence) => {
              if (environment.CHANNEL === undefined) return;
              const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
              if (ownerRevision === undefined && streamGeneration === undefined && expectedIdentity === undefined && planSequence === undefined) {
                await object.clearModuleAlarm(module.id, alarmKey);
              } else {
                await object.clearModuleAlarm(module.id, alarmKey, ownerRevision, streamGeneration,
                  expectedIdentity, planSequence);
              }
            },
            getAlarmDeadline: async (alarmKey) => {
              if (environment.CHANNEL === undefined) return null;
              const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
              return await object.getModuleAlarmDeadline(module.id, alarmKey);
            },
            getAlarmPlan: async (alarmKey) => {
              if (environment.CHANNEL === undefined) return null;
              const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
              return await object.getModuleAlarmPlan(module.id, alarmKey);
            },
            runModuleAlarm: (handlerKey, alarmKey, invocation) => {
              if (environment.CHANNEL === undefined) return Promise.resolve(undefined);
              const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
              return invocation === undefined
                ? object.runModuleAlarm(module.id, handlerKey, alarmKey)
                : object.runModuleAlarm(module.id, handlerKey, alarmKey, invocation);
            },
          });
    } catch (error: unknown) {
      // A module that throws doesn't take down the worker or the other
      // modules with it. The error becomes visible, not swallowed.
      diagnostics.push({ code: "host.module.error" satisfies EventCode, detail: { message: errorMessage(error) } });
    }

    if (result !== null) {
      diagnostics.push(...result.diagnostics);
      for (const change of result.variableChanges ?? []) {
        changedVariables.set(change.name, change.value);
        overlayIdsByVariable.set(change.name, change.overlayIds);
      }
      try {
        const commandResponseActions = new WeakSet<ModuleAction>();
        if (isCommandResponseHandler) {
          for (const action of result.actions) {
            if (action.kind === "chat") commandResponseActions.add(action);
          }
        }
        diagnostics.push(...await runActions(
          environment,
          event.channelId,
          module,
          result.actions,
          dispatchState.controls.mute.active,
          fetcher,
          result.attributions,
          textValue(event.payload.source_broadcaster_user_id),
          pendingWelcome,
          messageId ?? undefined,
          commandResponseActions,
          textValue(event.payload.chatter_user_id) ?? actor?.userId ?? null,
          event.triggerId,
        ));
      } catch (error: unknown) {
        diagnostics.push({ code: "host.action.failed" satisfies EventCode, detail: { message: errorMessage(error) } });
      }
    }

    newEntries.push(...await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      module.id,
      event.triggerId,
      actor?.userId ?? null,
      diagnostics,
      event.receivedAt,
    ));
  }

  if (event.subscriptionType === "stream.offline" && environment.CHANNEL !== undefined) {
    try {
      await environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId)).clearActiveChatters();
    } catch (error: unknown) {
      console.warn("Active chatter tracking could not be cleared.", error);
    }
  }

  if (newEntries.length === 0 && changedVariables.size === 0 && streamStateChanged === null) return;
  const realtimeMessages: RealtimeMessage[] = newEntries.length === 0 ? [] : [{
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    channelId: event.channelId,
    type: "event_log.new",
    payload: {
      entries: newEntries.map(({ eventId, createdAt, moduleId, code, actorUserId }) => ({
        eventId,
        createdAt,
        moduleId,
        code,
        actorUserId,
      })),
    },
  }];
  if (streamStateChanged !== null) {
    realtimeMessages.push(streamStateChanged);
    try {
      realtimeMessages.push(...await prepareModuleOverlayHostEventMessages(
        environment.DB,
        event.channelId,
        "stream.state.changed",
      ));
    } catch (error: unknown) {
      console.warn("Module overlay stream refresh hint could not be prepared.", error);
    }
  }
  if (changedVariables.size > 0) {
    await publishVariablesChanged(
      environment.CHANNEL,
      environment.DB,
      event.channelId,
      [...changedVariables].map(([name, value]) => ({ name, value })),
      [],
      Object.fromEntries(overlayIdsByVariable),
      realtimeMessages,
    );
  } else {
    try {
      await publishRealtimeMessages(environment.CHANNEL, realtimeMessages);
    } catch (error: unknown) {
      // The feed is a hint; D1 stays the authoritative state, and event
      // processing must not fail because a socket happens to be closed.
      console.warn("Realtime hint could not be sent.", error);
    }
  }
};
