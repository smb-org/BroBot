import type { ModuleLanguage } from "../contract";

export const channelEventsModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
}>> = {
  de: {
    mandatoryReason: "Kanalereignisse werden für den Betrieb der Module benötigt.",
  },
  en: {
    mandatoryReason: "Channel events are required for the modules to work.",
  },
};
