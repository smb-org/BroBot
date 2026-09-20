import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";

export { kuerzeAuf200Zeichen } from "../text";

/**
 * Eine Begründung für etwas, das ein Modul getan oder bewusst nicht getan hat.
 *
 * `code` ist maschinenlesbar und stabil (`shoutout.unterdrueckt`), `detail`
 * trägt die Zahlen, die den Fall erklären. Zusammen beantworten sie die Frage,
 * die heute nirgends beantwortet wird: „Raid erkannt, warum kam kein
 * Shoutout?"
 */
export interface ModuleDiagnostic {
  code: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Eine vom Host auszuführende, semantisch klar benannte Modulaktion. */
export type ModuleAction =
  | { kind: "chat"; text: string; replyToMessageId?: string }
  | { kind: "overlay"; type: string; payload: Readonly<Record<string, unknown>> };

/**
 * Was ein Modul als Ergebnis einer Verarbeitung beschreibt. Es führt nichts
 * aus — gemäß Entscheidung 0001 §13 beschreibt es nur gewünschte Aktionen,
 * und erst der Worker führt sie über Twitch, D1 oder Durable Objects aus.
 *
 * Die Aktionen stehen in einer gemeinsamen Liste, damit ihre Reihenfolge
 * erhalten bleibt. Neue semantische Aktionsarten können später additiv
 * ergänzt werden, ohne bestehende Module durch neue Pflichtfelder zu brechen.
 * `diagnostics` beschreibt fachliche Gründe für Handeln oder Nicht-Handeln;
 * ausgeführte Aktionen und deren Ausgang protokolliert der Host.
 */
export interface ModuleResult {
  actions: readonly ModuleAction[];
  diagnostics: readonly ModuleDiagnostic[];
}

export type ModuleActor = {
  userId: string;
  login: string;
  role: "broadcaster" | "verwalter" | "bediener" | null;
};

export interface ModuleMutationActor {
  userId: string;
  sessionId?: string;
}

export interface ModuleMutationAuthorization {
  sql: string;
  values: readonly (string | number | null)[];
}

export type ModuleAuditValue = string | number | boolean | null;

/** Fachliche, von einem Modul ausdrücklich für das Audit freigegebene Werte. */
export type ModuleAuditSnapshot = Readonly<Record<string, ModuleAuditValue>>;

export interface ModuleAuditEntry {
  channelId: string;
  moduleId: string;
  action: string;
  before: ModuleAuditSnapshot | null;
  after: ModuleAuditSnapshot | null;
}

/** Der Host bereitet den Audit-Teil derselben D1-Mutation vor. */
export type PrepareModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => D1PreparedStatement;

export type AuthorizeModuleMutation = (
  channelId: string,
  actor: ModuleMutationActor,
  now: string,
) => ModuleMutationAuthorization;

/** Infrastruktur, die der Host einem Modul für seinen eigenen Adapter gibt. */
export interface ModuleExecutionContext {
  DB: D1Database;
  authorizeMutation: AuthorizeModuleMutation;
}

/** Gemeinsame Props für lazy geladene Panel-Ansichten. */
export interface ModulePanelProperties {
  channelId: string;
  /** Die vom Host aufgelöste Panel-Sprache; optional für alte Module. */
  language?: ModuleLanguage;
}

export type ModuleLanguage = "de" | "en";

export const browserModuleLanguage = (): ModuleLanguage => {
  const language = typeof navigator === "undefined" ? "de" : navigator.language;
  return language.toLowerCase().startsWith("de") ? "de" : "en";
};

export interface ModuleRouteVariables {
  session: { userId: string; sessionId: string };
  channelRole: "broadcaster" | "verwalter" | "bediener";
  actor: { userId: string; sessionId: string };
  authorizeMutation: AuthorizeModuleMutation;
  prepareModuleAudit: PrepareModuleAudit;
}

export interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ModuleRouteVariables;
}

/**
 * Was ein Modul über das auslösende Ereignis erfährt. Bewusst schmal: Der
 * Kanal kommt aus dem geprüften Ereignis und nicht vom Modul, damit ein Modul
 * nicht in einen fremden Kanal wirken kann. `triggerId` ist die Message-ID von
 * Twitch und verbindet alle Zeilen im Ereignisprotokoll, die zu demselben
 * Auslöser gehören.
 */
export interface ModuleEvent<Settings = unknown> {
  channelId: string;
  subscriptionType: string;
  /** Die Variante stammt wie der Kanal aus der EventSub-Abo-Bedingung. */
  subscriptionVariant?: string;
  triggerId: string;
  payload: Readonly<Record<string, unknown>>;
  settings: Settings;
  receivedAt: string;
  /** Die Rolle stammt aus channel_members; `null` bedeutet kein Mitglied. */
  actor: ModuleActor | null;
}

export type BotModule<SettingsSchema extends z.ZodType = z.ZodType> = {
  id: string;
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  /** Broadcaster-Zustimmung, die der Host vor dem EventSub-Abo nachweist. */
  broadcasterScopes?: readonly string[];
  eventSubTypes?: readonly string[];
  routes?: Hono<ModuleRouteEnvironment>;
  /**
   * Der fachliche Einstiegspunkt. Eine reine Funktion: Sie beschreibt, was
   * geschehen soll, und führt nichts aus. Der Host führt die Aktionen aus und
   * protokolliert ihren Ausgang; das Modul begründet mit `diagnostics`, warum
   * es gehandelt oder eben nicht gehandelt hat (Entscheidung 0004).
   *
   * Wirft die Funktion, hält das weder den Worker noch die übrigen Module auf
   * — der Fehler landet als Diagnose im Ereignisprotokoll.
   */
  handleEvent?: (
    event: ModuleEvent<z.output<SettingsSchema>>,
    context: ModuleExecutionContext,
  ) => ModuleResult | Promise<ModuleResult>;
  // Modulmigrationen und weitere Aktionsarten treten dem Contract bei, sobald
  // das erste Modul sie benötigt. Die Command-Verarbeitung ist mit
  // ModuleResult angetreten.
  /**
   * Absichtlich nur ein Lazy-Import: Vite kann eigene Chunks schneiden und
   * ein deaktiviertes Modul kostet dadurch null Overlay-Bytes. Nicht in einen
   * direkten Import umwandeln.
   */
  overlay?: () => Promise<{ default: ComponentType }>;
  /**
   * Auch diese Ansicht bleibt bewusst lazy: Ein deaktiviertes Modul soll
   * ebenso im Panel-Bundle null Bytes kosten. Nicht in einen direkten Import
   * umwandeln.
   */
  panel?: () => Promise<{ default: ComponentType<ModulePanelProperties> }>;
};
