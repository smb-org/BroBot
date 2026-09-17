import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";

export type BotModule<SettingsSchema extends z.ZodType = z.ZodType> = {
  id: string;
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  eventSubTypes?: readonly string[];
  routes?: Hono;
  // Command-Verarbeitung und Modulmigrationen treten dem Contract bei, sobald
  // das erste Modul sie benötigt. Commands werden dann gemäß
  // docs/decisions/0001-stack-und-plattform.md §13 als reine Funktionen gebaut,
  // die gewünschte Aktionen beschreiben, statt sie auszuführen.
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
