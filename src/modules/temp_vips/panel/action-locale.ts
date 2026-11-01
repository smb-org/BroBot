import type { ModuleLanguage } from "../../contract";

export const tempVipsCockpitActionTexts: Readonly<Record<ModuleLanguage, {
  name: string;
  error: string;
  login: string;
  duration: string;
  durationHint: string;
  loadFailed: string;
  loading: string;
  scopeMissing: string;
  scopeCheckFailed: string;
}>> = {
  de: {
    name: "VIP vergeben",
    error: "Das VIP konnte nicht vergeben werden.",
    login: "Twitch-Name",
    duration: "Dauer",
    durationHint: "Die VIP-Zeit beginnt nach der Bestätigung durch Twitch.",
    loadFailed: "Dauer-Einstellungen konnten nicht geladen werden.",
    loading: "Dauer-Einstellungen werden geladen …",
    scopeMissing: "Verbinde das Broadcaster-Konto und erteile channel:manage:vips.",
    scopeCheckFailed: "Die Broadcaster-Berechtigung konnte nicht geprüft werden. Aktualisiere die Kanalberechtigungen.",
  },
  en: {
    name: "Grant VIP",
    error: "The VIP could not be granted.",
    login: "Twitch login",
    duration: "Duration",
    durationHint: "VIP time starts after Twitch confirms the grant.",
    loadFailed: "Duration settings could not be loaded.",
    loading: "Loading duration settings …",
    scopeMissing: "Connect the broadcaster account and grant channel:manage:vips.",
    scopeCheckFailed: "The broadcaster permission could not be checked. Refresh the channel permissions.",
  },
};
