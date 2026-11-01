import type { ModuleLanguage } from "../../contract";

export const tempVipsCockpitActionTexts: Readonly<Record<ModuleLanguage, {
  name: string;
  error: string;
  success: string;
  pending: string;
  login: string;
  duration: string;
  durationHint: string;
  loadFailed: string;
  loading: string;
}>> = {
  de: {
    name: "VIP vergeben",
    error: "Das VIP konnte nicht vergeben werden.",
    success: "VIP vergeben.",
    pending: "Die VIP-Vergabe wartet in der Kanalwarteschlange.",
    login: "Twitch-Name",
    duration: "Dauer",
    durationHint: "Die VIP-Zeit beginnt nach der Bestätigung durch Twitch.",
    loadFailed: "Dauer-Einstellungen konnten nicht geladen werden.",
    loading: "Dauer-Einstellungen werden geladen …",
  },
  en: {
    name: "Grant VIP",
    error: "The VIP could not be granted.",
    success: "VIP granted.",
    pending: "The VIP grant is waiting in the channel queue.",
    login: "Twitch login",
    duration: "Duration",
    durationHint: "VIP time starts after Twitch confirms the grant.",
    loadFailed: "Duration settings could not be loaded.",
    loading: "Loading duration settings …",
  },
};
