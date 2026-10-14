import type { ModuleLanguage } from "../contract";

interface ChatVotingImmediateActionTexts {
  name: Readonly<Record<ModuleLanguage, string>>;
  error: Readonly<Record<ModuleLanguage, string>>;
  running: Readonly<Record<ModuleLanguage, string>>;
  votekickRunning: Readonly<Record<ModuleLanguage, string>>;
  liveDataUnavailable: Readonly<Record<ModuleLanguage, string>>;
}

export const chatVotingImmediateActionTexts = {
  name: { de: "Abstimmung starten", en: "Start vote" },
  error: { de: "Die Abstimmung konnte nicht gestartet werden.", en: "The vote could not be started." },
  running: { de: "Abstimmung läuft noch {time}", en: "Voting is running for {time}" },
  votekickRunning: { de: "Votekick läuft gerade.", en: "A Votekick is running." },
  liveDataUnavailable: { de: "Live-Daten konnten nicht geladen werden.", en: "Live data could not be loaded." },
} as const satisfies ChatVotingImmediateActionTexts;
