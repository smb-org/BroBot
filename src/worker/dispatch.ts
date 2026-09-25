import type { EventCode } from "../contracts/values";
import type { BotModule, ModuleAction, ModuleActor, ModuleChannelInfo, ModuleChatStatus, ModuleDiagnostic, ModuleEvent, ModuleFollowedAt, ModuleLanguage, ModuleResult, ModuleStreamState } from "../modules/contract";
import type { RealtimeMessage } from "../realtime-contract";
import { MODULES } from "../modules/registry";
import {
  getChannelMemberForChannel,
} from "./db/channel-members";
import { sendChatMessage } from "./chat";
import { sendChatAnnouncement } from "./announcement";
import { fetchTwitchUserByLogin, sendShoutout } from "./shoutout";
import { publishRealtimeMessages, publishVariablesChanged } from "./realtime";
import { prepareModuleOverlayRealtimeMessage } from "./module-overlay-realtime";
import { writeModuleDiagnostics, type WrittenModuleDiagnostic } from "./event-log";
import { authorizeModuleMutation } from "./module-authorization";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import {
  isOlderOnlineEventThanHelixOfflineObservation,
  readChannelStreamState,
  writeEventSubStreamState,
} from "./db/stream-state";
import { lookupAndRefreshStreamState } from "./stream-state-lookup";
import { readChannelControls, readDispatchChannelState } from "./db/channel-controls";
import { getBotIdentity } from "./db/bot-identity";
import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";
import { readChannelVariables, prepareChannelVariableChange, prepareResetChannelVariablesForStream } from "./db/channel-variables";
import { createTemplateRenderer, type TemplateChannelDetails, type TemplateStreamDetails } from "./template-resolver";
import type { ChannelVariableOperation } from "../contracts/values";
import type { TemplateVariable } from "../template";

export interface DispatchEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
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
    return { title: channel.title, gameName: channel.game_name };
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

const botAccessTokenFor = async (environment: DispatchEnvironment): Promise<{ userId: string; accessToken: string } | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const value = await decryptJson<{ token?: unknown }>(identity.accessTokenCiphertext, parseKeyRing(getTokenEncryptionKeys(environment)));
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? { userId: identity.userId, accessToken: value.token }
    : null;
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

const channelLanguageFor = async (db: D1Database, channelId: string): Promise<ModuleLanguage> => {
  const row = await db.prepare("SELECT language FROM channels WHERE channel_id = ?").bind(channelId)
    .first<{ language: ModuleLanguage }>();
  return row?.language === "en" ? "en" : "de";
};

const recordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const chatStatusFor = (
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

const actorForEvent = async (
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
    if (paused && !mandatory) continue;
    if (!(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    matches.push({ module, settings: activation.settings });
    matchedModules.add(module.id);
  }
  for (const module of registry) {
    if (module.mandatory !== true || matchedModules.has(module.id) ||
        !(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    matches.push({ module, settings: JSON.stringify(module.defaultSettings) });
  }
  return { matches, unknownModules };
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
): Promise<ModuleDiagnostic[]> => {
  const diagnostics: ModuleDiagnostic[] = [];
  // Order is preserved: a reply after an announcement reads as a different
  // conversation than the reverse.
  for (const action of actions) {
    if (muted && (action.kind === "chat" || action.kind === "announcement" || action.kind === "shoutout")) {
      diagnostics.push({
        code: "host.action.suppressed" satisfies EventCode,
        detail: { action: action.kind, reason: "channel_muted" },
      });
      continue;
    }
    try {
      if (action.kind === "chat") {
        const result = await sendChatMessage(
          environment,
          channelId,
          action.text,
          action.replyToMessageId,
          fetcher,
        );
        if (result.truncated) {
          diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: action.text.length } });
        }
        diagnostics.push(result.sent
          ? { code: "host.chat.sent" satisfies EventCode, detail: result.detail }
          : { code: "host.chat.failed" satisfies EventCode, detail: { reason: result.reason, ...result.detail } });
        continue;
      }
      if (action.kind === "announcement") {
        const result = await sendChatAnnouncement(environment, channelId, action.text, fetcher);
        if (result.truncated) {
          diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: action.text.length } });
        }
        if (result.sent) {
          diagnostics.push({ code: "host.announcement.sent" satisfies EventCode, detail: result.detail });
          continue;
        }

        try {
          const fallback = await sendChatMessage(environment, channelId, action.text, undefined, fetcher);
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
        if ("targetLogin" in action) {
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
        } else {
          targetChannelId = action.targetChannelId;
        }
        const result = await sendShoutout(environment, channelId, targetChannelId, fetcher);
        diagnostics.push(result.sent
          ? { code: "host.shoutout.sent" satisfies EventCode, detail: result.detail }
          : { code: "host.shoutout.failed" satisfies EventCode, detail: { cause: result.reason, ...result.detail } });
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
  // The ending stream remains current while its offline event is dispatched.
  // Capture that session's controls before the stored state moves to offline.
  const changedVariables = new Map<string, number>();
  const overlayIdsByVariable = new Map<string, readonly string[]>();
  let streamStateChanged: RealtimeMessage | null = null;
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
    const stateWrite = await writeEventSubStreamState(
      environment.DB,
      event.channelId,
      event.subscriptionType === "stream.online" ? "online" : "offline",
      event.eventSubTimestamp ?? event.receivedAt,
      startedAt,
      streamId,
    );
    if (stateWrite === "written" &&
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
    if (event.subscriptionType === "stream.offline" && stateWrite === "ambiguous_offline") {
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
    if (isOnline && stateWrite === "written" && startedAt !== null) {
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
  const { matches, unknownModules } = selectModulesForEvent(dispatchState.activations, event.subscriptionType, registry, dispatchState.controls.pause.active);
  const actor = await actorForEvent(environment.DB, event.channelId, event.payload);
  const newEntries: WrittenModuleDiagnostic[] = [];
  let streamStatePromise: Promise<ModuleStreamState> | undefined;
  let channelInfoPromise: Promise<ModuleChannelInfo | null> | undefined;
  let channelDetailsPromise: Promise<TemplateChannelDetails | null> | undefined;
  let streamDetailsPromise: Promise<TemplateStreamDetails | null> | undefined;
  let appAccessTokenPromise: Promise<string> | undefined;
  let channelLanguagePromise: Promise<ModuleLanguage> | undefined;
  let followerTotalPromise: Promise<number | null> | undefined;
  let chattersTotalPromise: Promise<number | null> | undefined;
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
  const followedAt = (userId: string): Promise<ModuleFollowedAt> => {
    let pending = followedAtPromises.get(userId);
    if (pending === undefined) {
      pending = followedAtFor(environment, event.channelId, userId, fetcher);
      followedAtPromises.set(userId, pending);
    }
    return pending;
  };
  const channelLanguage = (): Promise<ModuleLanguage> => {
    channelLanguagePromise ??= channelLanguageFor(environment.DB, event.channelId);
    return channelLanguagePromise;
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

  for (const { module, settings } of matches) {
    const diagnostics: ModuleDiagnostic[] = [];
    let result: ModuleResult | null = null;

    try {
      const validatedSettings: unknown = module.settingsSchema.parse(JSON.parse(settings));
      const moduleEvent: ModuleEvent = {
        channelId: event.channelId,
        subscriptionType: event.subscriptionType,
        ...(event.subscriptionVariant === undefined ? {} : { subscriptionVariant: event.subscriptionVariant }),
        triggerId: event.triggerId,
        payload: event.payload,
        settings: validatedSettings,
        receivedAt: event.receivedAt,
        actor,
        chatStatus: chatStatusFor(event.subscriptionType, event.payload),
      };
      const moduleVariables = Object.values(module.templateFields ?? {}).flatMap((variables) => variables ?? []) as TemplateVariable[];
      const render = createTemplateRenderer(moduleEvent, module.templateContext ?? "event", moduleVariables, {
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
            streamState,
            channelInfo,
            followedAt,
            followerTotal,
            chattersTotal,
            userCreatedAt,
            readChannelVariables: channelVariables,
            renderTemplate: render,
            prepareVariableChange,
            channelLanguage,
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
        diagnostics.push(...await runActions(environment, event.channelId, module, result.actions, dispatchState.controls.mute.active, fetcher));
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
  if (streamStateChanged !== null) realtimeMessages.push(streamStateChanged);
  if (changedVariables.size > 0) {
    await publishVariablesChanged(
      environment.CHANNEL,
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
