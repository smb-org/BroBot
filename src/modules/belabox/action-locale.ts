import type { ModuleLanguage } from "../contract";

export const belaboxImmediateActionTexts = {
  name: { de: "BELABOX prüfen", en: "Check BELABOX" },
  error: { de: "Die BELABOX-Verbindung konnte nicht geprüft werden.", en: "The BELABOX connection could not be checked." },
  checked: (connected: boolean, bitrate: string) => ({
    de: `${connected ? "Verbunden" : "Getrennt"} · ${bitrate} kbit/s`,
    en: `${connected ? "Connected" : "Disconnected"} · ${bitrate} kbps`,
  }),
} as const satisfies {
  name: Readonly<Record<ModuleLanguage, string>>;
  error: Readonly<Record<ModuleLanguage, string>>;
  checked: (connected: boolean, bitrate: string) => Readonly<Record<ModuleLanguage, string>>;
};
