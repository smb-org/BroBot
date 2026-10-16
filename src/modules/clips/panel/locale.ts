import type { ModuleChatStatus } from "../../contract";
import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";

interface ClipRoleOption {
  value: ModuleChatStatus;
  label: string;
  inclusion: string;
}

export interface ClipsPanelTexts {
  settingsTitle: string;
  sessionClips: string;
  refreshClips: string;
  openClip: string;
  emptySession: string;
  emptyOffline: string;
  commandSection: string;
  commandRole: string;
  roleOptions: readonly ClipRoleOption[];
  commandCooldown: string;
  commandCooldownHint: string;
  chatLink: string;
  chatLinkEnabled: string;
  chatLinkHint: string;
  chatMessage: string;
  chatMessageHint: string;
  chatMessageDisabledHint: string;
  preview: string;
  previewSpeaker: string;
  previewCharacters: (count: number) => string;
  previewClipTitle: string;
  previewClipUrl: string;
  automatic: string;
  automaticSection: string;
  automaticHint: string;
  automaticDisabledHint: string;
  threshold: string;
  thresholdUnit: string;
  thresholdHint: string;
  automaticCooldown: string;
  automaticCooldownHint: string;
  enabledValue: string;
  disabledValue: string;
  thresholdRule: string;
  helixRule: string;
  clipsLoading: string;
  settingsLoading: string;
  settingsLoadError: string;
  clipsLoadError: string;
  saveError: string;
  conflictMessage: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  invalid: string;
  readOnlyReason: string;
  reloadSettings: string;
  actions: string;
  restoreDefaults: string;
  restoreTitle: string;
  restoreDescription: string;
  restoreConfirm: string;
  cancel: string;
  guardTitle: string;
  guardDescription: string;
  continueEditing: string;
  discardAndLeave: string;
  saveAndLeave: string;
}

const catalog: LocaleCatalog<ClipsPanelTexts> = {
  de: {
    settingsTitle: "Clip-Einstellungen",
    sessionClips: "Clips dieser Stream-Sitzung",
    refreshClips: "Clips aktualisieren",
    openClip: "Clip öffnen",
    emptySession: "In dieser Stream-Sitzung wurden noch keine Clips erstellt.",
    emptyOffline: "Die Liste zeigt Clips, sobald der Stream live ist.",
    commandSection: "Chatbefehl !clip",
    commandRole: "Mindestrolle",
    roleOptions: [
      { value: "viewer", label: "Alle", inclusion: "Alle im Chat dürfen !clip auslösen." },
      { value: "subscriber", label: "Abonnent", inclusion: "Abonnenten sowie Moderator:innen und Broadcaster dürfen !clip auslösen." },
      { value: "vip", label: "VIP", inclusion: "VIPs, Moderator:innen und Broadcaster dürfen !clip auslösen." },
      { value: "moderator", label: "Moderator:in", inclusion: "Moderator:innen und Broadcaster dürfen !clip auslösen." },
      { value: "broadcaster", label: "Broadcaster", inclusion: "Nur Broadcaster dürfen !clip auslösen." },
    ],
    commandCooldown: "Abklingzeit",
    commandCooldownHint: "Für den ganzen Kanal. 0 schaltet die Abklingzeit aus.",
    chatLink: "Clip-Link im Chat posten",
    chatLinkEnabled: "Aktiviert",
    chatLinkHint: "Postet nach der Erstellung die Nachricht im Chat und führt den Clip in der Sitzungsliste.",
    chatMessage: "Chatnachricht",
    chatMessageHint: "Verfügbare Werte: {clip.title} und {clip.url}.",
    chatMessageDisabledHint: "Aktiviere den Chat-Link, um die Nachricht zu bearbeiten.",
    preview: "Vorschau",
    previewSpeaker: "Bot",
    previewCharacters: (count) => `${String(count)} Zeichen`,
    previewClipTitle: "Der perfekte letzte Treffer",
    previewClipUrl: "https://clips.twitch.tv/Beispielclip",
    automatic: "Automatische Clips",
    automaticSection: "Automatische Clip-Einstellungen",
    automaticHint: "Speichert die Automatik-Einstellung; die Auslösung ist in dieser Version noch nicht implementiert.",
    automaticDisabledHint: "Aktiviere automatische Clips, um diese Werte zu bearbeiten.",
    threshold: "Schwelle gegenüber Streamdurchschnitt",
    thresholdUnit: "fach",
    thresholdHint: "Dieser Wert wird derzeit von keiner automatischen Erkennung ausgewertet.",
    automaticCooldown: "Abklingzeit",
    automaticCooldownHint: "Mindestabstand zwischen automatischen Clips.",
    enabledValue: "Aktiviert",
    disabledValue: "Deaktiviert",
    thresholdRule: "Die automatische Auslösung ist in dieser Codeversion nicht implementiert. Deshalb wertet derzeit kein Signal diesen Schwellenwert aus.",
    helixRule: "Twitch nimmt die Clip-Anfrage zuerst an und stellt den Clip asynchron bereit. Wir prüfen bis zu 15 Sekunden auf Verfügbarkeit; ohne bestätigtes Ergebnis wird kein Clip-Link angezeigt. Das globale Helix-Limit gilt kanalübergreifend.",
    clipsLoading: "Clips dieser Stream-Sitzung werden geladen.",
    settingsLoading: "Clip-Einstellungen werden geladen.",
    settingsLoadError: "Die Clip-Einstellungen konnten nicht geladen werden.",
    clipsLoadError: "Die Clips dieser Sitzung konnten nicht geladen werden.",
    saveError: "Die Clip-Einstellungen konnten nicht gespeichert werden.",
    conflictMessage: "Die Clip-Einstellungen wurden zwischenzeitlich geändert.",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Clip-Einstellungen gespeichert.",
    saving: "Wird gespeichert …",
    invalid: "Bitte korrigiere die markierten Felder.",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen Clip-Einstellungen ändern.",
    reloadSettings: "Einstellungen neu laden",
    actions: "Weitere Aktionen",
    restoreDefaults: "Standardwerte wiederherstellen",
    restoreTitle: "Clip-Einstellungen zurücksetzen?",
    restoreDescription: "Die aktuellen Entwurfswerte werden durch die Standardwerte ersetzt. Speichern übernimmt die Änderung für den Kanal.",
    restoreConfirm: "Standardwerte laden",
    cancel: "Abbrechen",
    guardTitle: "Ungespeicherte Änderungen",
    guardDescription: "Die Clip-Einstellungen wurden geändert. Möchtest du sie vor dem Verlassen speichern?",
    continueEditing: "Weiter bearbeiten",
    discardAndLeave: "Verwerfen und verlassen",
    saveAndLeave: "Speichern und verlassen",
  },
  en: {
    settingsTitle: "Clip settings",
    sessionClips: "Clips from this stream session",
    refreshClips: "Refresh clips",
    openClip: "Open clip",
    emptySession: "No clips have been created in this stream session yet.",
    emptyOffline: "The list will show clips while the stream is live.",
    commandSection: "Chat command !clip",
    commandRole: "Minimum role",
    roleOptions: [
      { value: "viewer", label: "Everyone", inclusion: "Everyone in chat can use !clip." },
      { value: "subscriber", label: "Subscriber", inclusion: "Subscribers, moderators and the broadcaster can use !clip." },
      { value: "vip", label: "VIP", inclusion: "VIPs, moderators and the broadcaster can use !clip." },
      { value: "moderator", label: "Moderator", inclusion: "Moderators and the broadcaster can use !clip." },
      { value: "broadcaster", label: "Broadcaster", inclusion: "Only the broadcaster can use !clip." },
    ],
    commandCooldown: "Cooldown",
    commandCooldownHint: "Applies to the whole channel. 0 disables the cooldown.",
    chatLink: "Post the clip link in chat",
    chatLinkEnabled: "Enabled",
    chatLinkHint: "Posts a chat message after creation and adds the clip to the session list.",
    chatMessage: "Chat message",
    chatMessageHint: "Available values: {clip.title} and {clip.url}.",
    chatMessageDisabledHint: "Enable the chat link to edit the message.",
    preview: "Preview",
    previewSpeaker: "Bot",
    previewCharacters: (count) => `${String(count)} characters`,
    previewClipTitle: "The perfect final hit",
    previewClipUrl: "https://clips.twitch.tv/Exampleclip",
    automatic: "Automatic clips",
    automaticSection: "Automatic clip settings",
    automaticHint: "Stores the automatic setting; triggering is not implemented in this version.",
    automaticDisabledHint: "Enable automatic clips to edit these values.",
    threshold: "Threshold relative to stream average",
    thresholdUnit: "times",
    thresholdHint: "No automatic detection currently evaluates this value.",
    automaticCooldown: "Cooldown",
    automaticCooldownHint: "Minimum time between automatic clips.",
    enabledValue: "Enabled",
    disabledValue: "Disabled",
    thresholdRule: "Automatic triggering is not implemented in this code version, so no signal currently evaluates this threshold.",
    helixRule: "Twitch accepts the clip request first and makes the clip available asynchronously. We check for availability for up to 15 seconds; no clip link is shown without a confirmed result. The global Helix limit applies across channels.",
    clipsLoading: "Loading clips from this stream session.",
    settingsLoading: "Loading clip settings.",
    settingsLoadError: "Clip settings could not be loaded.",
    clipsLoadError: "Clips for this session could not be loaded.",
    saveError: "Clip settings could not be saved.",
    conflictMessage: "Clip settings have changed since they were loaded.",
    save: "Save",
    discard: "Discard",
    saved: "Clip settings saved.",
    saving: "Saving …",
    invalid: "Correct the marked fields.",
    readOnlyReason: "Only broadcasters and managers can change clip settings.",
    reloadSettings: "Reload settings",
    actions: "More actions",
    restoreDefaults: "Restore defaults",
    restoreTitle: "Restore clip defaults?",
    restoreDescription: "Current draft values will be replaced by the defaults. Save to apply the change to this channel.",
    restoreConfirm: "Restore defaults",
    cancel: "Cancel",
    guardTitle: "Unsaved changes",
    guardDescription: "Clip settings have changed. Would you like to save before leaving?",
    continueEditing: "Continue editing",
    discardAndLeave: "Discard and leave",
    saveAndLeave: "Save and leave",
  },
};

export const clipsPanelTexts = (language: DashboardLanguage): ClipsPanelTexts => catalog[language];
