import type { EventCode } from "../contracts/values";
import type { BotModule, ModuleAction, ModuleActor, ModuleChannelInfo, ModuleChatStatus, ModuleDiagnostic, ModuleEvent, ModuleFollowedAt, ModuleLanguage, ModuleResult, ModuleStreamState } from "../modules/contract";
import type { RealtimeEnvelope } from "../realtime-contract";
import { MODULES } from "../modules/registry";
import {
  getChannelMemberForChannel,
} from "./db/channel-members";
import { sendChatMessage } from "./chat";
import { sendChatAnnouncement } from "./announcement";
import { fetchTwitchUserByLogin, sendShoutout } from "./shoutout";
import { publishRealtimeMessage } from "./realtime";
import { writeModuleDiagnostics, type WrittenModuleDiagnostic } from "./event-log";
import { authorizeModuleMutation } from "./module-authorization";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import { writeEventSubStreamState } from "./db/stream-state";
import { lookupAndRefreshStreamState } from "./stream-state-lookup";
import { clearStreamEndChannelControls, readDispatchChannelState } from "./db/channel-controls";
import { getBotIdentity } from "./db/bot-identity";
import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "./auth/crypto";

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

const channelInfoFor = async (
  environment: DispatchEnvironment,
  channelId: string,
  fetcher: typeof fetch,
): Promise<ModuleChannelInfo | null> => {
  try {
    const accessToken = await getAppAccessToken(environment as unknown as Env, new Date().toISOString(), fetcher);
    const [channelResult, streamResult] = await Promise.all([
      helixRequest<{ data?: unknown }>({
        url: "https://api.twitch.tv/helix/channels",
        query: { broadcaster_id: channelId },
        accessToken,
        clientId: environment.TWITCH_CLIENT_ID,
        fetcher,
      }),
      helixRequest<{ data?: unknown }>({
        url: "https://api.twitch.tv/helix/streams",
        query: { user_id: channelId, type: "live" },
        accessToken,
        clientId: environment.TWITCH_CLIENT_ID,
        fetcher,
      }),
    ]);
    if (!channelResult.ok || !streamResult.ok) return null;
    const channel = firstDataRecord(channelResult.data);
    if (channel === null || typeof channel.title !== "string" || typeof channel.game_name !== "string") return null;
    const streams = recordValue(streamResult.data) && arrayValue(streamResult.data.data) ? streamResult.data.data : null;
    if (streams === null) return null;
    const stream = streams[0];
    if (stream === undefined) return { title: channel.title, gameName: channel.game_name, startedAt: null };
    if (!recordValue(stream) || typeof stream.started_at !== "string") return null;
    return { title: channel.title, gameName: channel.game_name, startedAt: stream.started_at };
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
  for (const activation of activations) {
    if (!activation.enabled) continue;
    const module = known.get(activation.moduleId);
    if (module === undefined) {
      unknownModules.push(activation.moduleId);
      continue;
    }
    if (paused && module.mandatory !== true) continue;
    if (!(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    matches.push({ module, settings: activation.settings });
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
      // The realtime path is #7. Until then, an overlay action doesn't
      // silently vanish — it's logged as not executed.
      diagnostics.push({
        code: "host.overlay.not_executed" satisfies EventCode,
        detail: { type: action.type },
      });
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
  },
  fetcher: typeof fetch = fetch,
  registry: readonly BotModule[] = MODULES,
): Promise<void> => {
  let streamStateUpdated = false;
  if (event.subscriptionType === "stream.online" || event.subscriptionType === "stream.offline") {
    // The `started_at` Twitch sends on `stream.online` is the actual stream
    // start, distinct from `event.receivedAt` (used only for write ordering).
    const startedAt = event.subscriptionType === "stream.online" ? textValue(event.payload.started_at) : null;
    streamStateUpdated = await writeEventSubStreamState(
      environment.DB,
      event.channelId,
      event.subscriptionType === "stream.online" ? "online" : "offline",
      event.receivedAt,
      startedAt,
    );
  }
  const dispatchState = await readDispatchChannelState(environment.DB, event.channelId, event.receivedAt);
  const { matches, unknownModules } = selectModulesForEvent(dispatchState.activations, event.subscriptionType, registry, dispatchState.controls.pause.active);
  const actor = await actorForEvent(environment.DB, event.channelId, event.payload);
  const newEntries: WrittenModuleDiagnostic[] = [];
  let streamStatePromise: Promise<ModuleStreamState> | undefined;
  let channelInfoPromise: Promise<ModuleChannelInfo | null> | undefined;
  let channelLanguagePromise: Promise<ModuleLanguage> | undefined;
  const followedAtPromises = new Map<string, Promise<ModuleFollowedAt>>();
  const streamState = (): Promise<ModuleStreamState> => {
    streamStatePromise ??= streamStateForEvent(environment, event.channelId, fetcher);
    return streamStatePromise;
  };
  const channelInfo = (): Promise<ModuleChannelInfo | null> => {
    channelInfoPromise ??= channelInfoFor(environment, event.channelId, fetcher);
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
        result = module.handleEvent === undefined
          ? null
          : await module.handleEvent(moduleEvent, {
            DB: environment.DB,
            authorizeMutation: authorizeModuleMutation,
            streamState,
            channelInfo,
            followedAt,
            channelLanguage,
          });
    } catch (error: unknown) {
      // A module that throws doesn't take down the worker or the other
      // modules with it. The error becomes visible, not swallowed.
      diagnostics.push({ code: "host.module.error" satisfies EventCode, detail: { message: errorMessage(error) } });
    }

    if (result !== null) {
      diagnostics.push(...result.diagnostics);
      try {
        diagnostics.push(...await runActions(environment, event.channelId, result.actions, dispatchState.controls.mute.active, fetcher));
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

  // Keep a stream-scoped pause active through this offline notification, so
  // only the mandatory channel_events module observes the ending. The next
  // dispatch and panel reload see it cleared.
  if (event.subscriptionType === "stream.offline" && streamStateUpdated) {
    await clearStreamEndChannelControls(environment.DB, event.channelId, event.receivedAt);
  }
  if (newEntries.length === 0) return;
  const realtimeMessage: RealtimeEnvelope<"event_log.new"> = {
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
  };
  try {
    await publishRealtimeMessage(environment.CHANNEL, realtimeMessage);
  } catch (error: unknown) {
    // The feed is a hint; D1 stays the authoritative state, and event
    // processing must not fail because a socket happens to be closed.
    console.warn("Realtime hint could not be sent.", error);
  }
};
