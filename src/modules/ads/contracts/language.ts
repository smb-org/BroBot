import type { ModuleLanguage } from "../contract";

export const adsChatLanguage = {
  de: { seconds: "Sekunden" },
  en: { seconds: "seconds" },
} as const satisfies Readonly<Record<ModuleLanguage, { seconds: string }>>;

export const adsEventTimeLabel = {
  de: "Nächster Werbeblock",
  en: "Next ad break",
} as const satisfies Readonly<Record<ModuleLanguage, string>>;
