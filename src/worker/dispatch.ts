import type { BotModule, ModuleAction, ModuleActor, ModuleChatStatus, ModuleDiagnostic, ModuleEvent, ModuleResult } from "../modules/contract";
import type { RealtimeEnvelope } from "../realtime-contract";
import { MODULES } from "../modules/registry";
import {
  getChannelMemberForChannel,
} from "./db/channel-members";
import {
  listChannelModulesForChannel,
} from "./db/channel-modules";
import { sendChatMessage } from "./chat";
import { sendShoutout } from "./shoutout";
import { publishRealtimeMessage } from "./realtime";
import { writeModuleDiagnostics, type WrittenModuleDiagnostic } from "./event-log";
import { authorizeModuleMutation } from "./module-authorization";

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
  fetcher: typeof fetch,
): Promise<ModuleDiagnostic[]> => {
  const diagnostics: ModuleDiagnostic[] = [];
  // Order is preserved: a reply after an announcement reads as a different
  // conversation than the reverse.
  for (const action of actions) {
    try {
      if (action.kind === "chat") {
        const result = await sendChatMessage(
          environment,
          channelId,
          action.text,
          action.replyToMessageId,
          fetcher,
        );
        diagnostics.push(result.sent
          ? { code: "host.chat.gesendet", detail: result.detail }
          : { code: "host.chat.fehlgeschlagen", detail: { reason: result.reason, ...result.detail } });
        continue;
      }
      if (action.kind === "shoutout") {
        const result = await sendShoutout(environment, channelId, action.targetChannelId, fetcher);
        diagnostics.push(result.sent
          ? { code: "host.shoutout.gesendet", detail: result.detail }
          : { code: "host.shoutout.fehlgeschlagen", detail: { ursache: result.reason, ...result.detail } });
        continue;
      }
      // The realtime path is #7. Until then, an overlay action doesn't
      // silently vanish — it's logged as not executed.
      diagnostics.push({
        code: "host.overlay.nicht_ausgefuehrt",
        detail: { typ: action.type },
      });
    } catch (error: unknown) {
      // A failed action must not suppress the subsequent ordered actions,
      // e.g. the chat message after a shoutout.
      diagnostics.push({ code: "host.aktion.fehler", detail: { meldung: errorMessage(error) } });
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
  const activations = await listChannelModulesForChannel(environment.DB, event.channelId);
  const { matches, unknownModules } = selectModulesForEvent(activations, event.subscriptionType, registry);
  const actor = await actorForEvent(environment.DB, event.channelId, event.payload);
  const newEntries: WrittenModuleDiagnostic[] = [];

  for (const moduleId of unknownModules) {
    newEntries.push(...await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      HOST_MODULE_ID,
      event.triggerId,
      null,
      [{ code: "host.modul.unbekannt", detail: { moduleId: moduleId } }],
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
        });
    } catch (error: unknown) {
      // A module that throws doesn't take down the worker or the other
      // modules with it. The error becomes visible, not swallowed.
      diagnostics.push({ code: "host.modul.fehler", detail: { meldung: errorMessage(error) } });
    }

    if (result !== null) {
      diagnostics.push(...result.diagnostics);
      try {
        diagnostics.push(...await runActions(environment, event.channelId, result.actions, fetcher));
      } catch (error: unknown) {
        diagnostics.push({ code: "host.aktion.fehler", detail: { meldung: errorMessage(error) } });
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
    console.warn("Realtime-Hinweis konnte nicht gesendet werden.", error);
  }
};
