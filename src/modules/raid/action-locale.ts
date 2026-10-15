import type { ModuleLanguage } from "../contract";

export const raidImmediateActionTexts = {
  name: { de: "Shoutout senden", en: "Send shoutout" },
  error: { de: "Der Shoutout konnte nicht gesendet werden.", en: "The shoutout could not be sent." },
} as const satisfies Readonly<Record<"name" | "error", Readonly<Record<ModuleLanguage, string>>>>;
