import type { ModuleLanguage } from "../contract";

export const clipsImmediateActionTexts = {
  name: { de: "Clip erstellen", en: "Create clip" },
  error: { de: "Der Clip konnte nicht erstellt werden.", en: "The clip could not be created." },
} as const satisfies Readonly<Record<"name" | "error", Readonly<Record<ModuleLanguage, string>>>>;
