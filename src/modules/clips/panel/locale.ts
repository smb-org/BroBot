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
  chatLink: string;
  chatLinkEnabled: string;
  chatMessage: string;
  lockedLaterVersion: string;
  automatic: string;
  automaticSection: string;
  automaticLaterVersion: string;
  threshold: string;
  thresholdUnit: string;
  automaticCooldown: string;
  clipsLoading: string;
  settingsLoading: string;
  settingsLoadError: string;
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
    chatLink: "Clip-Link im Chat posten",
    chatLinkEnabled: "Aktiviert",
    chatMessage: "Chatnachricht",
    lockedLaterVersion: "Kommt in einer späteren Version.",
    automatic: "Automatische Clips",
    automaticSection: "Automatische Clip-Einstellungen",
    automaticLaterVersion: "Automatische Clips kommen in einer späteren Version.",
    threshold: "Schwelle gegenüber Streamdurchschnitt",
    thresholdUnit: "fach",
    automaticCooldown: "Abklingzeit zwischen automatischen Clips",
    clipsLoading: "Clips dieser Stream-Sitzung werden geladen.",
    settingsLoading: "Clip-Einstellungen werden geladen.",
    settingsLoadError: "Die Clip-Einstellungen konnten nicht geladen werden.",
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
    chatLink: "Post the clip link in chat",
    chatLinkEnabled: "Enabled",
    chatMessage: "Chat message",
    lockedLaterVersion: "Coming in a later version.",
    automatic: "Automatic clips",
    automaticSection: "Automatic clip settings",
    automaticLaterVersion: "Automatic clips are coming in a later version.",
    threshold: "Threshold relative to stream average",
    thresholdUnit: "times",
    automaticCooldown: "Cooldown between automatic clips",
    clipsLoading: "Loading clips from this stream session.",
    settingsLoading: "Loading clip settings.",
    settingsLoadError: "Clip settings could not be loaded.",
    clipsLoadError: "Clips for this session could not be loaded.",
  },
};

export const clipsPanelTexts = (language: DashboardLanguage): ClipsPanelTexts => catalog[language];
