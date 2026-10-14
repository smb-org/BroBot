import type { ModuleLanguage } from "../contract";

interface ChatVotingImmediateActionTexts {
  name: Readonly<Record<ModuleLanguage, string>>;
  error: Readonly<Record<ModuleLanguage, string>>;
  endName: Readonly<Record<ModuleLanguage, string>>;
  endError: Readonly<Record<ModuleLanguage, string>>;
  endSucceeded: Readonly<Record<ModuleLanguage, string>>;
  notRunning: Readonly<Record<ModuleLanguage, string>>;
  running: Readonly<Record<ModuleLanguage, string>>;
  votekickRunning: Readonly<Record<ModuleLanguage, string>>;
}

export const chatVotingImmediateActionTexts = {
  name: { de: "Abstimmung starten", en: "Start vote" },
  error: { de: "Die Abstimmung konnte nicht gestartet werden.", en: "The vote could not be started." },
  endName: { de: "Abstimmung beenden", en: "End vote" },
  endError: { de: "Die Abstimmung konnte nicht beendet werden.", en: "The vote could not be ended." },
  endSucceeded: { de: "Abstimmung beendet.", en: "Vote ended." },
  notRunning: { de: "Es läuft gerade keine Abstimmung.", en: "No vote is currently running." },
  running: { de: "Abstimmung läuft noch {time}", en: "Voting is running for {time}" },
  votekickRunning: { de: "Votekick läuft gerade.", en: "A Votekick is running." },
} as const satisfies ChatVotingImmediateActionTexts;
