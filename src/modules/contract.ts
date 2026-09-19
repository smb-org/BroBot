import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";

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
  triggerId: string;
  payload: Readonly<Record<string, unknown>>;
  settings: Settings;
  receivedAt: string;
}

export type BotModule<SettingsSchema extends z.ZodType = z.ZodType> = {
  id: string;
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  eventSubTypes?: readonly string[];
  routes?: Hono;
  /**
   * Der fachliche Einstiegspunkt. Eine reine Funktion: Sie beschreibt, was
   * geschehen soll, und führt nichts aus. Der Host führt die Aktionen aus und
   * protokolliert ihren Ausgang; das Modul begründet mit `diagnostics`, warum
   * es gehandelt oder eben nicht gehandelt hat (Entscheidung 0004).
   *
   * Wirft die Funktion, hält das weder den Worker noch die übrigen Module auf
   * — der Fehler landet als Diagnose im Ereignisprotokoll.
   */
  handleEvent?: (event: ModuleEvent<z.output<SettingsSchema>>) => ModuleResult | Promise<ModuleResult>;
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
  panel?: () => Promise<{ default: ComponentType }>;
};
