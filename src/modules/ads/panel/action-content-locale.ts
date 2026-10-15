import type { ModuleLanguage } from "../../contract";

export const adsActionContentTexts = {
  length: { de: "Werbedauer", en: "Ad length" },
  lengthHint: { de: "Startet sofort.", en: "Starts immediately." },
} as const satisfies Readonly<Record<"length" | "lengthHint", Readonly<Record<ModuleLanguage, string>>>>;
