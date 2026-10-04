import type { ModuleLanguage } from "../../contract";

export const VOTEKICK_DEFAULT_TEXTS: Readonly<Record<ModuleLanguage, {
  startText: string;
  passText: string;
  failText: string;
  expiredText: string;
  protectedText: string;
  busyText: string;
}>> = {
  de: {
    startText: "Votekick gegen {votekick.target} läuft. 1 = Ja, 2 = Nein. Benötigt: {votekick.threshold} Netto-Ja-Stimmen.",
    passText: "Votekick erfolgreich: {votekick.target} erhält einen Timeout von {votekick.duration}.",
    failText: "Der Timeout für {votekick.target} konnte nicht angewendet werden.",
    expiredText: "Votekick gegen {votekick.target} abgelaufen ({votekick.yes} Ja, {votekick.no} Nein).",
    protectedText: "Für {votekick.target} kann kein Votekick gestartet werden.",
    busyText: "Es läuft bereits eine Abstimmung.",
  },
  en: {
    startText: "Votekick for {votekick.target} is open. 1 = yes, 2 = no. Needed: {votekick.threshold} net yes votes.",
    passText: "Votekick passed: {votekick.target} receives a {votekick.duration} timeout.",
    failText: "The timeout for {votekick.target} could not be applied.",
    expiredText: "Votekick for {votekick.target} expired ({votekick.yes} yes, {votekick.no} no).",
    protectedText: "A votekick cannot be started for {votekick.target}.",
    busyText: "Another ballot is already running.",
  },
};

export const votekickDefaultTexts = (language: ModuleLanguage) => VOTEKICK_DEFAULT_TEXTS[language];
