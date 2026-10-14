import type { ModuleLanguage } from "../contract";

export const belaboxImmediateActionTexts = {
  name: { de: "BELABOX prüfen", en: "Check BELABOX" },
  error: { de: "Die BELABOX-Verbindung konnte nicht geprüft werden.", en: "The BELABOX connection could not be checked." },
} as const satisfies Readonly<Record<"name" | "error", Readonly<Record<ModuleLanguage, string>>>>;
