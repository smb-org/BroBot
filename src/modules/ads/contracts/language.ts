import type { ModuleLanguage } from "../contract";

export const adsChatLanguage = {
  de: { seconds: "Sekunden" },
  en: { seconds: "seconds" },
} as const satisfies Readonly<Record<ModuleLanguage, { seconds: string }>>;
