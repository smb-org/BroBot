import type { ModuleLanguage } from "../contract";

export const adsImmediateActionTexts = {
  name: { de: "Werbung starten", en: "Start ad break" },
  error: { de: "Die Werbung konnte nicht gestartet werden.", en: "The ad break could not be started." },
} as const satisfies Readonly<Record<"name" | "error", Readonly<Record<ModuleLanguage, string>>>>;
