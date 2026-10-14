import type { ModuleLanguage } from "../contract";

export const clipsImmediateActionTexts = {
  name: { de: "Clip erstellen", en: "Create clip" },
  error: { de: "Der Clip konnte nicht erstellt werden.", en: "The clip could not be created." },
  created: { de: "Clip erstellt.", en: "Clip created." },
  open: { de: "Öffnen", en: "Open" },
} as const satisfies Readonly<Record<"name" | "error" | "created" | "open", Readonly<Record<ModuleLanguage, string>>>>;
