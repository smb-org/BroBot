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

const fehlermeldung = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const textwert = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const recordWert = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const chatStatusFuer = (
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
): readonly ModuleChatStatus[] | null => {
  if (subscriptionType !== "channel.chat.message") return null;
  const badges = payload.badges;
  const badgeIds = Array.isArray(badges)
    ? badges.flatMap((badge) => {
      if (!recordWert(badge)) return [];
      const setId = badge.set_id;
      return typeof setId === "string" ? [setId] : [];
    })
    : [];
  // Mehrere Badges sind gleichzeitig möglich. VIP und Abonnent bleiben daher
  // getrennte Status; `founder` zählt weiterhin als Abonnent. Ohne besondere
  // Badges bleibt die Liste für jedes Chatereignis mit `viewer` nicht leer.
  const statusse: ModuleChatStatus[] = [];
  if (badgeIds.includes("broadcaster")) statusse.push("broadcaster");
  if (badgeIds.includes("moderator")) statusse.push("moderator");
  if (badgeIds.includes("vip")) statusse.push("vip");
  if (badgeIds.includes("subscriber") || badgeIds.includes("founder")) statusse.push("subscriber");
  return statusse.length === 0 ? ["viewer"] : statusse;
};

const akteurFuerEreignis = async (
  db: D1Database,
  channelId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<ModuleActor | null> => {
  const userId = textwert(payload.chatter_user_id);
  if (userId === null) return null;
  const login = textwert(payload.chatter_user_login) ?? textwert(payload.chatter_user_name) ?? userId;
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
  aktivierungen: readonly { moduleId: string; enabled: boolean; settings: string }[],
  subscriptionType: string,
  registry: readonly BotModule[] = MODULES,
): { treffer: { module: BotModule; settings: string }[]; unbekannt: string[] } => {
  const bekannt = new Map(registry.map((module) => [module.id, module]));
  const treffer: { module: BotModule; settings: string }[] = [];
  const unbekannt: string[] = [];
  for (const aktivierung of aktivierungen) {
    if (!aktivierung.enabled) continue;
    const module = bekannt.get(aktivierung.moduleId);
    if (module === undefined) {
      unbekannt.push(aktivierung.moduleId);
      continue;
    }
    if (!(module.eventSubTypes ?? []).includes(subscriptionType)) continue;
    treffer.push({ module, settings: aktivierung.settings });
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
        const ergebnis = await sendChatMessage(
          environment,
          channelId,
          action.text,
          action.replyToMessageId,
          fetcher,
        );
        diagnostics.push(ergebnis.sent
          ? { code: "host.chat.gesendet", detail: ergebnis.detail }
          : { code: "host.chat.fehlgeschlagen", detail: { reason: ergebnis.reason, ...ergebnis.detail } });
        continue;
      }
      if (action.kind === "shoutout") {
        const ergebnis = await sendShoutout(environment, channelId, action.targetChannelId, fetcher);
        diagnostics.push(ergebnis.sent
          ? { code: "host.shoutout.gesendet", detail: ergebnis.detail }
          : { code: "host.shoutout.fehlgeschlagen", detail: { ursache: ergebnis.reason, ...ergebnis.detail } });
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
      diagnostics.push({ code: "host.aktion.fehler", detail: { meldung: fehlermeldung(error) } });
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
  const aktivierungen = await listChannelModulesForChannel(environment.DB, event.channelId);
  const { treffer, unbekannt } = selectModulesForEvent(aktivierungen, event.subscriptionType, registry);
  const actor = await akteurFuerEreignis(environment.DB, event.channelId, event.payload);
  const neueEinträge: WrittenModuleDiagnostic[] = [];

  for (const moduleId of unbekannt) {
    neueEinträge.push(...await writeModuleDiagnostics(
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
    let ergebnis: ModuleResult | null = null;

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
        chatStatus: chatStatusFuer(event.subscriptionType, event.payload),
      };
      ergebnis = module.handleEvent === undefined
        ? null
        : await module.handleEvent(moduleEvent, {
          DB: environment.DB,
          authorizeMutation: authorizeModuleMutation,
        });
    } catch (error: unknown) {
      // Ein geworfenes Modul reißt weder den Worker noch die übrigen Module
      // mit. Der Fehler wird sichtbar, nicht verschluckt.
      diagnostics.push({ code: "host.modul.fehler", detail: { meldung: fehlermeldung(error) } });
    }

    if (ergebnis !== null) {
      diagnostics.push(...ergebnis.diagnostics);
      try {
        diagnostics.push(...await ausfuehren(environment, event.channelId, ergebnis.actions, fetcher));
      } catch (error: unknown) {
        diagnostics.push({ code: "host.aktion.fehler", detail: { meldung: fehlermeldung(error) } });
      }
    }

    neueEinträge.push(...await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      module.id,
      event.triggerId,
      actor?.userId ?? null,
      diagnostics,
      event.receivedAt,
    ));
  }

  if (neueEinträge.length === 0) return;
  const realtimeMessage: RealtimeEnvelope<"event_log.new"> = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    channelId: event.channelId,
    type: "event_log.new",
    payload: {
      entries: neueEinträge.map(({ eventId, createdAt, moduleId, code, actorUserId }) => ({
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
