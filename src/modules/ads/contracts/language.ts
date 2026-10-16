import type { ModuleLanguage } from "../contract";

export const adsChatLanguage = {
  de: { second: "Sekunde", seconds: "Sekunden" },
  en: { second: "second", seconds: "seconds" },
} as const satisfies Readonly<Record<ModuleLanguage, { second: string; seconds: string }>>;

export const adsEventTimeLabel = {
  de: "Nächster Werbeblock",
  en: "Next ad break",
} as const satisfies Readonly<Record<ModuleLanguage, string>>;
