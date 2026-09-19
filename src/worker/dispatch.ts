import type { BotModule, ModuleAction, ModuleDiagnostic, ModuleEvent, ModuleResult } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { listChannelModulesForChannel } from "./auth/repository";
import { sendChatMessage } from "./chat";
import { writeModuleDiagnostics } from "./event-log";

export interface DispatchEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

/** Der Host protokolliert Handeln und dessen Ausgang; Module begründen Nicht-Handeln. */
const HOST_MODULE_ID = "host";

const fehlermeldung = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
        : { code: "host.chat.fehlgeschlagen", detail: { grund: ergebnis.reason, ...ergebnis.detail } });
      continue;
    }
    // Die Realtime-Strecke ist #7. Bis dahin verschwindet eine
    // Overlay-Aktion nicht stillschweigend, sondern wird als unausgeführt
    // protokolliert.
    diagnostics.push({
      code: "host.overlay.nicht_ausgefuehrt",
      detail: { typ: action.type },
    });
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
    triggerId: string;
    payload: Readonly<Record<string, unknown>>;
    receivedAt: string;
  },
  fetcher: typeof fetch = fetch,
  registry: readonly BotModule[] = MODULES,
): Promise<void> => {
  const aktivierungen = await listChannelModulesForChannel(environment.DB, event.channelId);
  const { treffer, unbekannt } = selectModulesForEvent(aktivierungen, event.subscriptionType, registry);

  for (const moduleId of unbekannt) {
    await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      HOST_MODULE_ID,
      event.triggerId,
      null,
      [{ code: "host.modul.unbekannt", detail: { modulId: moduleId } }],
      event.receivedAt,
    );
  }

  for (const { module, settings } of treffer) {
    const diagnostics: ModuleDiagnostic[] = [];
    let ergebnis: ModuleResult | null = null;

    try {
      const gepruefteEinstellungen: unknown = module.settingsSchema.parse(JSON.parse(settings));
      const moduleEvent: ModuleEvent = {
        channelId: event.channelId,
        subscriptionType: event.subscriptionType,
        triggerId: event.triggerId,
        payload: event.payload,
        settings: gepruefteEinstellungen,
        receivedAt: event.receivedAt,
      };
      ergebnis = module.handleEvent === undefined ? null : await module.handleEvent(moduleEvent);
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

    await writeModuleDiagnostics(
      environment.DB,
      event.channelId,
      module.id,
      event.triggerId,
      null,
      diagnostics,
      event.receivedAt,
    );
  }
};
