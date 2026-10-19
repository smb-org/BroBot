import type { ModuleChatStatus } from "../../contract";
import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";

interface ClipRoleOption {
  value: ModuleChatStatus;
  label: string;
}

export interface ClipsPanelTexts {
  settingsTitle: string;
  sessionClips: string;
  refreshClips: string;
  retryClips: string;
  openClip: string;
  emptySession: string;
  emptyOffline: string;
  commandSection: string;
  commandRole: string;
  roleOptions: readonly ClipRoleOption[];
  commandCooldown: string;
  commandCooldownError: string;
  chatLink: string;
  chatLinkEnabled: string;
  chatMessage: string;
  chatMessageHint: string;
  lockedLaterVersion: string;
  automatic: string;
  automaticSection: string;
  threshold: string;
  thresholdUnit: string;
  automaticCooldown: string;
  clipsLoading: string;
  settingsLoading: string;
  settingsLoadError: string;
  settingsSaveError: string;
  settingsConflict: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  clipsLoadError: string;
}

const catalog: LocaleCatalog<ClipsPanelTexts> = {
  de: {
    settingsTitle: "Clip-Einstellungen",
    sessionClips: "Clips dieser Stream-Sitzung",
    refreshClips: "Clips aktualisieren",
    retryClips: "Erneut versuchen",
    openClip: "Clip öffnen",
    emptySession: "In dieser Stream-Sitzung wurden noch keine Clips erstellt.",
    emptyOffline: "Die Liste zeigt Clips, sobald der Stream live ist.",
    commandSection: "Chatbefehl !clip",
    commandRole: "Mindestrolle",
    roleOptions: [
      { value: "viewer", label: "Alle" },
      { value: "subscriber", label: "Abonnent" },
      { value: "vip", label: "VIP" },
      { value: "moderator", label: "Moderator:in" },
      { value: "broadcaster", label: "Broadcaster" },
    ],
    commandCooldown: "Abklingzeit",
    commandCooldownError: "Eine ganze Zahl zwischen 0 und 86.400 eingeben.",
    chatLink: "Clip-Link im Chat posten",
    chatLinkEnabled: "Aktiviert",
    chatMessage: "Chatnachricht",
    chatMessageHint: "Verfügbare Werte: {clip.title} und {clip.url}.",
    lockedLaterVersion: "Kommt in einer späteren Version.",
    automatic: "Automatische Clips",
    automaticSection: "Automatische Clip-Einstellungen",
    threshold: "Schwelle gegenüber Streamdurchschnitt",
    thresholdUnit: "fach",
    automaticCooldown: "Abklingzeit zwischen automatischen Clips",
    clipsLoading: "Clips dieser Stream-Sitzung werden geladen.",
    settingsLoading: "Clip-Einstellungen werden geladen.",
    settingsLoadError: "Die Clip-Einstellungen konnten nicht geladen werden.",
    settingsSaveError: "Die Clip-Einstellungen konnten nicht gespeichert werden.",
    settingsConflict: "Die Clip-Einstellungen wurden zwischenzeitlich geändert. Lade die Seite neu.",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Einstellungen gespeichert.",
    saving: "Wird gespeichert …",
    clipsLoadError: "Die Clips dieser Sitzung konnten nicht geladen werden.",
  },
  en: {
    settingsTitle: "Clip settings",
    sessionClips: "Clips from this stream session",
    refreshClips: "Refresh clips",
    retryClips: "Try again",
    openClip: "Open clip",
    emptySession: "No clips have been created in this stream session yet.",
    emptyOffline: "The list will show clips while the stream is live.",
    commandSection: "Chat command !clip",
    commandRole: "Minimum role",
    roleOptions: [
      { value: "viewer", label: "Everyone" },
      { value: "subscriber", label: "Subscriber" },
      { value: "vip", label: "VIP" },
      { value: "moderator", label: "Moderator" },
      { value: "broadcaster", label: "Broadcaster" },
    ],
    commandCooldown: "Cooldown",
    commandCooldownError: "Enter a whole number from 0 to 86,400.",
    chatLink: "Post the clip link in chat",
    chatLinkEnabled: "Enabled",
    chatMessage: "Chat message",
    chatMessageHint: "Available values: {clip.title} and {clip.url}.",
    lockedLaterVersion: "Coming in a later version.",
    automatic: "Automatic clips",
    automaticSection: "Automatic clip settings",
    threshold: "Threshold relative to stream average",
    thresholdUnit: "times",
    automaticCooldown: "Cooldown between automatic clips",
    clipsLoading: "Loading clips from this stream session.",
    settingsLoading: "Loading clip settings.",
    settingsLoadError: "Clip settings could not be loaded.",
    settingsSaveError: "Clip settings could not be saved.",
    settingsConflict: "Clip settings changed while you were editing. Reload the page.",
    save: "Save",
    discard: "Discard",
    saved: "Clip settings saved.",
    saving: "Saving …",
    clipsLoadError: "Clips for this session could not be loaded.",
  },
};

export const clipsPanelTexts = (language: DashboardLanguage): ClipsPanelTexts => catalog[language];
