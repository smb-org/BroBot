import type { ModuleLanguage } from "../contract";

export const statisticsModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  streamsLabel: string;
  streamsDescription: string;
}>> = {
  de: {
    mandatoryReason: "Dieses Modul ist immer aktiv, damit für jeden Live-Kanal aggregierte Statistiken und eine kanalweite Wortfrequenz-Baseline ohne personenbezogene Daten erfasst werden.",
    streamsLabel: "Streams",
    streamsDescription: "Verlauf und Kennzahlen früherer Streams.",
  },
  en: {
    mandatoryReason: "This module is always active so every live channel collects aggregate statistics and a channel-wide word-frequency baseline without personal data.",
    streamsLabel: "Streams",
    streamsDescription: "History and metrics from previous streams.",
  },
};
