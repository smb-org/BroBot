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

/** Der Host protokolliert Handeln und dessen Ausgang; Module begründen Nicht-Handeln. */
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
  // Mehrere Badges sind gleichzeitig möglich. VIP und Abonnent bleiben daher
  // getrennte Status; `founder` zählt weiterhin als Abonnent. Ohne besondere
  // Badges bleibt die Liste für jedes Chatereignis mit `viewer` nicht leer.
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
 * Ermittelt die Module, die dieses Ereignis in diesem Kanal sehen dürfen:
 * aktiviert in `channel_modules`, bekannt in der Registry, zuständig laut
 * `eventSubTypes`.
 *
 * Eine `module_id`, die die Registry nicht kennt, ist ein sichtbarer
 * Fehlerzustand und kein Absturz — sie entsteht, wenn ein Modul entfernt
 * wurde, die Aktivierungszeile aber blieb.
 */
export const selectModulesForEvent = (
  activations: readonly { moduleId: string; enabled: boolean; settings: string }[],
  subscriptionType: string,
  registry: readonly BotModule[] = MODULES,
): { treffer: { module: BotModule; settings: string }[]; unbekannt: string[] } => {
  const bekannt = new Map(registry.map((module) => [module.id, module]));
  const treffer: { module: BotModule; settings: string }[] = [];
  const unbekannt: string[] = [];
  for (const activation of activations) {
    if (!activation.enabled) continue;
    const module = bekannt.get(activation.moduleId);
    if (module === undefined) {
      unbekannt.push(activation.moduleId);
      continue;
    }
    if (!(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    treffer.push({ module, settings: activation.settings });
  }
  return { treffer, unbekannt };
};

const ausfuehren = async (
  environment: DispatchEnvironment,
  channelId: string,
  actions: readonly ModuleAction[],
  fetcher: typeof fetch,
): Promise<ModuleDiagnostic[]> => {
  const diagnostics: ModuleDiagnostic[] = [];
  // Reihenfolge bleibt erhalten: Eine Antwort nach einer Ansage ergibt eine
  // andere Unterhaltung als umgekehrt.
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
      // Die Realtime-Strecke ist #7. Bis dahin verschwindet eine
      // Overlay-Aktion nicht stillschweigend, sondern wird als unausgeführt
      // protokolliert.
      diagnostics.push({
        code: "host.overlay.nicht_ausgefuehrt",
        detail: { typ: action.type },
      });
    } catch (error: unknown) {
      // Eine fehlgeschlagene Aktion darf die nachfolgenden geordneten
      // Aktionen nicht unterdrücken, etwa den Chat nach einem Shoutout.
      diagnostics.push({ code: "host.aktion.fehler", detail: { meldung: errorMessage(error) } });
    }
  }
  return diagnostics;
};

/**
 * Verteilt ein geprüftes EventSub-Ereignis an die zuständigen Module und führt
 * deren Aktionen aus.
 *
 * Der Zielkanal stammt aus dem Ereignis, nicht aus dem Modul — ein Modul kann
 * dadurch nicht in einen fremden Kanal wirken.
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
  const { treffer, unbekannt } = selectModulesForEvent(activations, event.subscriptionType, registry);
  const actor = await actorForEvent(environment.DB, event.channelId, event.payload);
  const newEntries: WrittenModuleDiagnostic[] = [];

  for (const moduleId of unbekannt) {
    newEntries.push(...await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      HOST_MODULE_ID,
      event.triggerId,
      null,
      [{ code: "host.modul.unbekannt", detail: { modulId: moduleId } }],
      event.receivedAt,
    ));
  }

  for (const { module, settings } of treffer) {
    const diagnostics: ModuleDiagnostic[] = [];
    let result: ModuleResult | null = null;

    try {
      const gepruefteEinstellungen: unknown = module.settingsSchema.parse(JSON.parse(settings));
      const moduleEvent: ModuleEvent = {
        channelId: event.channelId,
        subscriptionType: event.subscriptionType,
        ...(event.subscriptionVariant === undefined ? {} : { subscriptionVariant: event.subscriptionVariant }),
        triggerId: event.triggerId,
        payload: event.payload,
        settings: gepruefteEinstellungen,
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
      // Ein geworfenes Modul reißt weder den Worker noch die übrigen Module
      // mit. Der Fehler wird sichtbar, nicht verschluckt.
      diagnostics.push({ code: "host.modul.fehler", detail: { meldung: errorMessage(error) } });
    }

    if (result !== null) {
      diagnostics.push(...result.diagnostics);
      try {
        diagnostics.push(...await ausfuehren(environment, event.channelId, result.actions, fetcher));
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
    // Der Feed ist ein Hinweis; D1 bleibt der verbindliche Stand und die
    // Ereignisverarbeitung darf nicht an einem geschlossenen Socket scheitern.
    console.warn("Realtime-Hinweis konnte nicht gesendet werden.", error);
  }
};
