import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";

interface ModulNamen {
  textbefehle: string;
}

const modulNamen: LocaleCatalog<ModulNamen> = {
  de: { textbefehle: "Textbefehle" },
  en: { textbefehle: "Text commands" },
};

export const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  if (moduleId === "textbefehle") return modulNamen[language].textbefehle;
  return moduleId;
};

interface ModulStatus {
  laeuft: string;
  aus: string;
}

const modulStatus: LocaleCatalog<ModulStatus> = {
  de: { laeuft: "Läuft", aus: "Aus" },
  en: { laeuft: "Running", aus: "Off" },
};

export const statusWord = (enabled: boolean, language: DashboardLanguage = dashboardLanguage()): string => {
  const texte = modulStatus[language];
  return enabled ? texte.laeuft : texte.aus;
};
