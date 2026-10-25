import type { ModuleLanguage } from "../contract";

export const statisticsModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
}>> = {
  de: {
    mandatoryReason: "Dieses Modul ist immer aktiv, damit für jeden Live-Kanal dieselben aggregierten Statistiken erfasst werden.",
  },
  en: {
    mandatoryReason: "This module is always active so every live channel collects the same aggregate statistics.",
  },
};
