import { ADS_SKIPPED_REASONS, COMMERCIAL_FAILURE_REASONS, EVENTSUB_NEUTRAL_REASON_CODES, RAID_INVALID_REASONS, SHOUTOUT_FAILURE_REASONS, type AdsSkippedReason, type ApiErrorCode, type AuditAction, type AuditArea, type ChannelRole, type CommercialFailureReason, type EventCode, type EventSubNeutralReasonCode, type EventTone, type ImmediateActionUnavailableReason, type RaidInvalidReason, type ShoutoutFailureReason, type ShoutoutSuppressedReason } from "../contracts/values";
import { browserModuleLanguage, type ModuleLanguage } from "../modules/contract";
import type { SystemVariableName } from "../template-variables";

export type DashboardLanguage = ModuleLanguage;
export type LocaleCatalog<T> = Record<DashboardLanguage, T>;

export const catalogString = (catalog: object, key: string): string | undefined => {
  if (!Object.hasOwn(catalog, key)) return undefined;
  const value = (catalog as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

export interface DashboardCommonTexts {
  cancel: string;
  close: string;
  save: string;
  /** `EditorShell.discardLabel` -- reverts an editor draft to its last saved value. */
  discard: string;
  /** `EditorShell.savedLabel` -- the save bar's clean-after-save status text. */
  saved: string;
  /** `EditorShell.pendingLabel` -- the save bar's in-flight status text. */
  saving: string;
  /** `EditorShell.issueLabels` -- appended to a tab's accessible name. */
  error: string;
  warning: string;
  /** `Switch.hint` on an immediate-action switch (2, "Sofort gegen gespeichert"). */
  immediate: string;
  roles: Record<ChannelRole, string>;
  /** What a role is allowed to do, for role `ChoiceCards` (ADR 0006). */
  roleDescriptions: Record<ChannelRole, string>;
}

const commonTexts: LocaleCatalog<DashboardCommonTexts> = {
  de: {
    cancel: "Abbrechen",
    close: "Schließen",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert.",
    saving: "Wird gespeichert …",
    error: "Fehler",
    warning: "Hinweis",
    immediate: "wirkt sofort",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Verwalter",
      operator: "Bediener",
    },
    roleDescriptions: {
      broadcaster: "Vergibt und entzieht auch die Broadcaster-Rolle.",
      manager: "Verwaltet Mitglieder, Module und Moduleinstellungen.",
      operator: "Sieht alles, ändert nichts.",
    },
  },
  en: {
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    discard: "Discard",
    saved: "Saved.",
    saving: "Saving …",
    error: "Error",
    warning: "Notice",
    immediate: "takes effect immediately",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Manager",
      operator: "Operator",
    },
    roleDescriptions: {
      broadcaster: "Also grants and revokes the broadcaster role.",
      manager: "Manages members, modules, and module settings.",
      operator: "Sees everything, changes nothing.",
    },
  },
};

/**
 * The panel's language, derived from the browser (decision 0007).
 * This is the only place that determines it — a later, deliberate
 * per-user language choice only replaces this function.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const dashboardCommonTexts = (): DashboardCommonTexts => commonTexts[dashboardLanguage()];

export interface SystemTemplateVariableLocale {
  description: string;
  sample: string;
}

export type SystemTemplateVariableCatalog = Readonly<Record<SystemVariableName, SystemTemplateVariableLocale>>;

export const systemTemplateVariableLocale: Readonly<Record<DashboardLanguage, SystemTemplateVariableCatalog>> = {
  de: {
    user: { description: "Login der Person im Chat", sample: "zuschauerin" },
    displayname: { description: "Anzeigename der Person im Chat", sample: "Zuschauerin" },
    channel: { description: "Login deines Kanals", sample: "beispielkanal" },
    target: { description: "Erstes Argument oder die auslösende Person", sample: "freund" },
    args: { description: "Alle Argumente des Befehls", sample: "hallo zusammen" },
    game: { description: "Aktuelle Kategorie des Streams", sample: "Minecraft" },
    title: { description: "Aktueller Streamtitel", sample: "Ein gemütlicher Abend" },
    uptime: { description: "Laufzeit des Streams oder offline", sample: "2 Std. 14 Min." },
    viewers: { description: "Aktuelle Zuschauerzahl", sample: "42" },
    live: { description: "Ob der Kanal live oder offline ist", sample: "live" },
    followers: { description: "Gesamtzahl der Follower", sample: "12.345" },
    chatters: { description: "Personen im Chat", sample: "42" },
    followage: { description: "Wie lange die Person dem Kanal folgt", sample: "1 Jahr, 3 Monate" },
    subage: { description: "Monate des aktuellen Abzeichens", sample: "6" },
    accountage: { description: "Alter des Twitch-Kontos", sample: "4 Jahre" },
    uses: { description: "Auslösungen dieses Befehls einschließlich dieser", sample: "12" },
    cooldown: { description: "Abkühlzeit des Befehls in Sekunden", sample: "5" },
    command: { description: "Befehlsname oder verwendeter Alias", sample: "hallo" },
    date: { description: "Heutiges Datum in Europe/Berlin", sample: "23.09.2026" },
    time: { description: "Aktuelle Uhrzeit in Europe/Berlin", sample: "20:15" },
    random: { description: "Zufallszahl; Beispielbereich 1–100", sample: "73" },
    pick: { description: "Zufällige Auswahl aus deinen Optionen", sample: "Kopf" },
  },
  en: {
    user: { description: "Login of the person in chat", sample: "viewer" },
    displayname: { description: "Display name of the person in chat", sample: "Viewer" },
    channel: { description: "Login of your channel", sample: "samplechannel" },
    target: { description: "First argument or the person who triggered the command", sample: "friend" },
    args: { description: "All command arguments", sample: "hello everyone" },
    game: { description: "Current stream category", sample: "Minecraft" },
    title: { description: "Current stream title", sample: "A cozy evening" },
    uptime: { description: "Stream duration or offline", sample: "2 h 14 min" },
    viewers: { description: "Current viewer count", sample: "42" },
    live: { description: "Whether the channel is live or offline", sample: "live" },
    followers: { description: "Total follower count", sample: "12,345" },
    chatters: { description: "People in chat", sample: "42" },
    followage: { description: "How long this person has followed the channel", sample: "1 year, 3 months" },
    subage: { description: "Months on the current subscriber badge", sample: "6" },
    accountage: { description: "Age of the Twitch account", sample: "4 years" },
    uses: { description: "Command triggers including this one", sample: "12" },
    cooldown: { description: "Command cooldown in seconds", sample: "5" },
    command: { description: "Command name or alias used", sample: "hello" },
    date: { description: "Today's date in Europe/Berlin", sample: "23.09.2026" },
    time: { description: "Current time in Europe/Berlin", sample: "20:15" },
    random: { description: "Random number; example range 1–100", sample: "73" },
    pick: { description: "Random choice from your options", sample: "Heads" },
  },
};

export const channelVariableTemplateDescription: Readonly<Record<DashboardLanguage, string>> = {
  de: "Kanalvariable",
  en: "Channel variable",
};

export interface ChannelVariablesTexts {
  title: string;
  list: string;
  create: string;
  count: (count: number, maximum: number) => string;
  empty: string;
  loading: string;
  loadError: string;
  saveError: string;
  deleteError: string;
  name: string;
  nameHint: string;
  nameInvalid: string;
  description: string;
  descriptionHint: string;
  noDescription: string;
  value: string;
  setValue: string;
  valueHint: string;
  resetOnStreamStart: string;
  limitNote: (maximum: number) => string;
  resetHint: string;
  renameHint: string;
  usages: string;
  noUsages: string;
  usageLine: (moduleId: string, itemName: string, kind: "template" | "action" | "display") => string;
  set: string;
  increase: string;
  decrease: string;
  increaseDraftValue: string;
  decreaseDraftValue: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteDescription: (name: string, usages: string, overlayCount?: number) => string;
  deleteConfirm: (name: string) => string;
  deleteCancel: string;
  inUseReason: (usages: string) => string;
  managementLocked: string;
  valueLocked: string;
  limitReached: string;
  newVariable: string;
  save: string;
  discard: string;
  close: string;
  conflict: string;
  created: string;
  updated: string;
  useInOverlay: string;
  useOverlayHint: string;
  chooseOverlay: string;
  createOverlay: string;
  newOverlayName: string;
  defaultOverlayName: (variableName: string) => string;
  openEditor: string;
  reconnect: string;
  variableMissing: string;
  reconnectConflict: string;
  legacyRenameWarning: string;
}

const channelVariablesCatalog: LocaleCatalog<ChannelVariablesTexts> = {
  de: {
    title: "Kanalvariablen", list: "Variablen", create: "Variable anlegen", count: (count, maximum) => `${String(count)} von ${String(maximum)}`,
    empty: "Noch keine Kanalvariablen angelegt.", loading: "Kanalvariablen werden geladen …", loadError: "Kanalvariablen konnten nicht geladen werden.",
    saveError: "Die Kanalvariable konnte nicht gespeichert werden.", deleteError: "Die Kanalvariable konnte nicht gelöscht werden.",
    name: "Name", nameHint: "Kleinbuchstaben, Zahlen und Unterstrich; höchstens 32 Zeichen.", nameInvalid: "Nur Kleinbuchstaben, Zahlen und Unterstrich.",
    description: "Beschreibung", descriptionHint: "Erscheint in der Variablenauswahl. Höchstens 80 Zeichen.", noDescription: "Keine Beschreibung",
    value: "Wert", setValue: "Setzen auf", valueHint: "Ganze Zahl von −999.999.999 bis 999.999.999.",
    resetOnStreamStart: "Bei Streamstart auf null setzen", resetHint: "Wird zurückgesetzt, wenn der nächste Stream startet.",
    limitNote: (maximum) => `Bis zu ${String(maximum)} Variablen pro Kanal.`,
    renameHint: "Vorlagen und gespeicherte Overlay-Elemente werden angepasst.", usages: "Verwendet in", noUsages: "Noch nicht verwendet.",
    usageLine: (moduleId, itemName, kind) => `${moduleId === "text_commands" ? "!" : ""}${itemName} · ${kind === "action" ? "zählt eine Aktion" : kind === "display" ? "Overlay-Anzeige" : "Vorlage"}`,
    set: "Setzen", increase: "+1", decrease: "−1", increaseDraftValue: "Setzwert um eins erhöhen", decreaseDraftValue: "Setzwert um eins verringern", delete: "Variable löschen", deleteTitle: (name) => `Variable ${name} löschen?`,
    deleteDescription: (name, usages, overlayCount = 0) => overlayCount > 0
      ? `„${name}“ wird dauerhaft gelöscht. Wird in ${String(overlayCount)} Overlay-Element${overlayCount === 1 ? "" : "en"} angezeigt; diese zeigen danach nichts.${usages.length === 0 ? "" : ` Weitere Verwendungen: ${usages}`}`
      : usages.length === 0 ? `„${name}“ wird dauerhaft gelöscht.` : `„${name}“ wird dauerhaft gelöscht. Verwendungen: ${usages}`,
    deleteConfirm: (name) => `${name} endgültig löschen`, deleteCancel: "Abbrechen",
    inUseReason: (usages) => `Wird von ${usages} verwendet. Entferne zuerst die Befehlsaktion.`,
    managementLocked: "Nur Broadcaster und Verwalter dürfen Variablen anlegen, umbenennen, beschreiben oder löschen.",
    valueLocked: "Nur Kanalmitglieder dürfen den Wert ändern.", limitReached: "Die maximale Zahl der Kanalvariablen ist erreicht.", newVariable: "Neue Variable", save: "Speichern", discard: "Verwerfen", close: "Schließen",
    conflict: "Die Variable wurde inzwischen geändert.", created: "Variable angelegt.", updated: "Variable gespeichert.",
    useInOverlay: "In Overlay verwenden", useOverlayHint: "Wähle ein Overlay. Die Variable wird im Editor als ungespeicherter Entwurf eingefügt.",
    chooseOverlay: "Overlay auswählen", createOverlay: "Neues Overlay", newOverlayName: "Name des neuen Overlays",
    defaultOverlayName: (variableName) => `Overlay ${variableName}`,
    openEditor: "Editor öffnen", reconnect: "Neu verbinden", variableMissing: "Variable fehlt — neu wählen.",
    reconnectConflict: "Das Overlay-Element wurde inzwischen geändert. Lade die Seite neu, bevor du es verbindest.",
    legacyRenameWarning: "Alte Links mit #var=… zeigen diese Variable nach der Umbenennung nicht mehr an.",
  },
  en: {
    title: "Channel variables", list: "Variables", create: "Create variable", count: (count, maximum) => `${String(count)} of ${String(maximum)}`,
    empty: "No channel variables yet.", loading: "Loading channel variables …", loadError: "Channel variables could not be loaded.",
    saveError: "The channel variable could not be saved.", deleteError: "The channel variable could not be deleted.",
    name: "Name", nameHint: "Lowercase letters, numbers, and underscores; up to 32 characters.", nameInvalid: "Use lowercase letters, numbers, and underscores only.",
    description: "Description", descriptionHint: "Shown in the variable picker. Up to 80 characters.", noDescription: "No description",
    value: "Value", setValue: "Set to", valueHint: "Integer from −999,999,999 to 999,999,999.",
    resetOnStreamStart: "Reset to zero when the stream starts", resetHint: "Resets when the next stream starts.",
    limitNote: (maximum) => `Up to ${String(maximum)} variables per channel.`,
    renameHint: "Templates and saved overlay elements are updated.", usages: "Used in", noUsages: "Not used yet.",
    usageLine: (moduleId, itemName, kind) => `${moduleId === "text_commands" ? "!" : ""}${itemName} · ${kind === "action" ? "changes a variable" : kind === "display" ? "overlay display" : "template"}`,
    set: "Set", increase: "+1", decrease: "−1", increaseDraftValue: "Increase the value to set by one", decreaseDraftValue: "Decrease the value to set by one", delete: "Delete variable", deleteTitle: (name) => `Delete variable ${name}?`,
    deleteDescription: (name, usages, overlayCount = 0) => overlayCount > 0
      ? `“${name}” will be deleted permanently. It appears in ${String(overlayCount)} overlay element${overlayCount === 1 ? "" : "s"}; ${overlayCount === 1 ? "it" : "they"} will show nothing afterward.${usages.length === 0 ? "" : ` Other uses: ${usages}`}`
      : usages.length === 0 ? `“${name}” will be deleted permanently.` : `“${name}” will be deleted permanently. Used in: ${usages}`,
    deleteConfirm: (name) => `Delete ${name} permanently`, deleteCancel: "Cancel",
    inUseReason: (usages) => `Used by ${usages}. Remove the command action first.`,
    managementLocked: "Only broadcasters and managers may create, rename, describe, or delete variables.",
    valueLocked: "Only channel members may change the value.", limitReached: "The channel has reached its variable limit.", newVariable: "New variable", save: "Save", discard: "Discard", close: "Close",
    conflict: "This variable has changed since it was loaded.", created: "Variable created.", updated: "Variable saved.",
    useInOverlay: "Use in overlay", useOverlayHint: "Choose an overlay. The variable is added as an unsaved draft in the editor.",
    chooseOverlay: "Choose an overlay", createOverlay: "New overlay", newOverlayName: "New overlay name",
    defaultOverlayName: (variableName) => `${variableName} overlay`,
    openEditor: "Open editor", reconnect: "Reconnect", variableMissing: "Variable missing — choose it again.",
    reconnectConflict: "This overlay element has changed. Reload the page before reconnecting it.",
    legacyRenameWarning: "Old links using #var=… will stop showing this variable after it is renamed.",
  },
};

export const channelVariablesTexts = (language: DashboardLanguage = dashboardLanguage()): ChannelVariablesTexts => channelVariablesCatalog[language];

export interface OverlaysTexts {
  title: string; list: string; count: (count: number, maximum: number) => string; empty: string; loading: string;
  loadError: string; actionError: string; managementLocked: string; create: string; createTitle: string;
  name: string; width: string; height: string; standardSize: string; compactSize: string; customSize: string;
  createSubmit: string; cancel: string; elements: string; accesses: string; lastUsedAt: string; lastUsedNever: string; never: string; statusLabel: string;
  openAccesses: string; issue: string; issueLabel: string; issueHint: string; copy: string; copied: string;
  editComposition: string; editorBack: string; editorLoading: string; editorLoadError: string;
  editorElements: string; editorPreview: string; editorPreviewCanvas: string; editorProperties: string;
  editorNoElements: string; editorNoSelection: string; editorReadOnly: string; editorChooseVariable: string;
  editorAddVariable: string; editorAdd: string; editorLabel: string; editorDisplayText: string;
  editorVariable: string; editorX: string; editorY: string; editorScale: string; editorZ: string;
  editorMoveForward: string; editorMoveBackward: string; editorRemove: string; editorInComposition: string;
  editorZoom: string; editorReference: (width: number, height: number) => string; editorTextHint: string;
  editorElementLimit: string; editorMissingPrefill: (name: string) => string; editorSave: string;
  editorDiscard: string; editorSaved: string; editorClean: string; editorUnsaved: string; editorSaving: string;
  editorSaveError: string; editorConflictTitle: string; editorConflictDescription: string;
  editorConflictKeep: string; editorConflictReload: string; editorConflictOverwrite: string;
  editorUnsavedTitle: string; editorUnsavedDescription: string; editorContinue: string;
  editorDiscardAndLeave: string; editorSaveAndLeave: string;
  copyError: string; showLink: string; hideLink: string; fullLink: string; reveal: string; replace: string; revoke: string; revoked: string; revokedPending: string;
  accessUnrecoverable: string;
  setup: string; setupAssistant: string; setupAccessSelected: (name: string) => string; setupTarget: string;
  setupObs: string; setupStreamElements: string; setupSoundAlerts: string; setupOutput: string;
  setupWholeOverlay: string; setupSingleElement: string; setupOverlayUrl: string; setupRevealUrl: string; setupCopyRevealedUrl: string; setupCopiedUrl: string;
  setupDimensions: (width: number, height: number) => string; setupElementDimensions: string;
  setupObsAddSource: string; setupObsBrowser: string; setupObsPasteUrl: string; setupObsSetSize: string; setupObsClearCss: string;
  setupObsCssNote: string; setupStreamElementsPath: string; setupStreamElementsPaste: string;
  setupStreamElementsWholePlacement: (width: number, height: number) => string; setupStreamElementsElementPlacement: string;
  setupSoundAlertsPath: string; setupSoundAlertsFallback: string; setupSoundAlertsUnverified: string;
  setupHtml: string; setupJs: string; setupFields: string; setupViewSnippet: string;
  setupCopySnippet: (name: string) => string; setupSnippetCopied: (name: string) => string;
  setupCopyUnavailable: string; setupAccessInactive: string;
  active: string; expired: string; revokedStatus: string; noAccesses: string; delete: string; deleteTitle: (name: string) => string;
  deleteDescription: (name: string) => string; deleteConfirm: (name: string) => string; close: string;
  conflict: string; guide: string; issueReason: string; readOnly: string; elementCount: (count: number) => string;
  missingVariable: (name: string) => string;
  legacyTitle: string; legacyDescription: string; legacyTokenName: string; legacyCreatedByUnknown: string;
  legacyCreatedAt: string; legacyTokenId: string; legacyRevokeTitle: (name: string) => string; legacyRevokeDescription: (name: string) => string;
  legacyRevokeConfirm: (name: string) => string; legacyRevocationReason: string; loadMore: string;
  legacyImport: string; legacyImportTitle: string; legacyImportDescription: string; legacyImportLinkLabel: string;
  legacyImportPlaceholder: string; legacyImportCssWarning: string; legacyImportPositionWarning: string;
  legacyImportTokenWarning: string; legacyImportConfirm: string; legacyImportSuccess: (name: string) => string;
  legacyImportInvalidLink: string; legacyImportTokenNotFound: string; legacyImportAlreadyBound: string; legacyImportClosingPending: string;
}

const overlaysCatalog: LocaleCatalog<OverlaysTexts> = {
  de: {
    title: "Overlays", list: "Overlays", count: (count, maximum) => `${String(count)} von ${String(maximum)}`,
    empty: "Noch keine Overlays angelegt.", loading: "Overlays werden geladen …", loadError: "Overlays konnten nicht geladen werden.",
    actionError: "Die Änderung konnte nicht durchgeführt werden.", managementLocked: "Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.",
    create: "Neues Overlay", createTitle: "Neues Overlay anlegen", name: "Name", width: "Breite", height: "Höhe",
    standardSize: "1920 × 1080", compactSize: "1280 × 720", customSize: "Eigene Fläche", createSubmit: "Overlay anlegen", cancel: "Abbrechen",
    elements: "Elemente", accesses: "Zugänge", lastUsedAt: "Zuletzt benutzt", lastUsedNever: "nie", never: "Nie", statusLabel: "Status", openAccesses: "Zugänge verwalten", editComposition: "Komposition bearbeiten",
    editorBack: "Zurück zu Overlays", editorLoading: "Overlay wird geladen …", editorLoadError: "Das Overlay konnte nicht geladen werden.",
    editorElements: "Elemente", editorPreview: "Live-Vorschau", editorPreviewCanvas: "Overlay-Vorschau", editorProperties: "Eigenschaften",
    editorNoElements: "Noch keine Elemente. Füge eine Kanalvariable hinzu.", editorNoSelection: "Wähle ein Element aus.", editorReadOnly: "Bediener können die Komposition ansehen, aber nicht ändern.",
    editorChooseVariable: "Kanalvariable auswählen", editorAddVariable: "Variable anzeigen", editorAdd: "Hinzufügen", editorLabel: "Elementname", editorDisplayText: "Anzeigetext",
    editorVariable: "Kanalvariable", editorX: "X (px)", editorY: "Y (px)", editorScale: "Skalierung (%)", editorZ: "Ebene (z)",
    editorMoveForward: "Eine Ebene nach vorn", editorMoveBackward: "Eine Ebene nach hinten", editorRemove: "Element entfernen", editorInComposition: "In der Komposition anzeigen",
    editorZoom: "Vorschau-Zoom", editorReference: (width, height) => `${String(width)} × ${String(height)} Referenz`, editorTextHint: "Genau ein {value}-Platzhalter ist erforderlich.",
    editorElementLimit: "Pro Overlay sind höchstens 20 Elemente möglich.", editorMissingPrefill: (name) => `Die Variable ${name} ist nicht mehr verfügbar.`, editorSave: "Speichern",
    editorDiscard: "Entwurf verwerfen", editorSaved: "Gespeichert — verbundene Quellen übernehmen die Änderungen sofort.", editorClean: "Gespeicherte Komposition. Änderungen werden erst nach dem Speichern live.",
    editorUnsaved: "Ungespeicherte Änderungen", editorSaving: "Wird gespeichert …", editorSaveError: "Die Komposition konnte nicht gespeichert werden.",
    editorConflictTitle: "Overlay wurde geändert", editorConflictDescription: "Eine andere Person hat dieses Overlay geändert. Du kannst die aktuelle Fassung laden oder deinen Entwurf überschreiben.",
    editorConflictKeep: "Weiter bearbeiten", editorConflictReload: "Neu laden", editorConflictOverwrite: "Überschreiben",
    editorUnsavedTitle: "Ungespeicherte Änderungen", editorUnsavedDescription: "Beim Verlassen gehen deine ungespeicherten Änderungen verloren.",
    editorContinue: "Weiter bearbeiten", editorDiscardAndLeave: "Verwerfen und verlassen", editorSaveAndLeave: "Speichern und verlassen",
    issue: "Zugang ausstellen", issueLabel: "Name des Zugangs", issueHint: "Zum Beispiel OBS Hauptrechner.", copy: "Link kopieren",
    copied: "Kopiert", copyError: "Der Link konnte nicht kopiert werden.", showLink: "Link anzeigen", hideLink: "Link verbergen", fullLink: "Vollständiger Link", reveal: "Link erneut anzeigen", replace: "Ersetzen", revoke: "Widerrufen",
    accessUnrecoverable: "Dieser alte Zugang kann nicht erneut angezeigt werden. Stelle einen neuen Zugang aus.",
    setup: "Einrichten", setupAssistant: "Einrichtungsassistent", setupAccessSelected: (name) => `Zugang: ${name}`, setupTarget: "Zielsystem",
    setupObs: "OBS", setupStreamElements: "StreamElements", setupSoundAlerts: "Sound Alerts", setupOutput: "Ausgabe",
    setupWholeOverlay: "Ganzes Overlay", setupSingleElement: "Einzelnes Element", setupOverlayUrl: "Maskierter Overlay-Link (Anzeige)",
    setupRevealUrl: "Link zum Kopieren anzeigen", setupCopyRevealedUrl: "Overlay-Link kopieren", setupCopiedUrl: "Overlay-Link kopiert",
    setupDimensions: (width, height) => `Breite und Höhe: ${String(width)} × ${String(height)} px`,
    setupElementDimensions: "Breite ≈ Elementbreite × Skalierung; Höhe nach Inhalt.",
    setupObsAddSource: "Quelle hinzufügen", setupObsBrowser: "Browser auswählen", setupObsPasteUrl: "Die Anzeige ist maskiert; der kopierte Link enthält den Zugangstoken. Den Link kopieren und als URL einfügen.",
    setupObsSetSize: "Breite und Höhe wie oben angegeben einstellen",
    setupObsClearCss: "„Benutzerdefiniertes CSS“ leeren (OBS-Standard-CSS verwenden)",
    setupObsCssNote: "Eigenes CSS gehört in den Stil des Overlays.",
    setupStreamElementsPath: "Overlay → Add Widget → Static/Custom → Custom Widget",
    setupStreamElementsPaste: "In HTML, JS und Fields einfügen. In Fields brobotAddress auf den HTTPS-Ursprung des Overlay-Links und overlayUrl auf den vollständigen Link mit Zugangstoken setzen; den CSS-Reiter leer lassen.",
    setupStreamElementsWholePlacement: (width, height) => `Die Box auf 0/0 setzen und auf ${String(width)} × ${String(height)} skalieren.`,
    setupStreamElementsElementPlacement: "Für andere Positionen empfiehlt sich die Einzelausgabe, damit nur ein Positionierungssystem aktiv ist.",
    setupSoundAlertsPath: "Scenes → Add Widget → Import Widget",
    setupSoundAlertsFallback: "Alternativ ein Custom Widget anlegen und dieselben HTML-, JS- und Fields-Inhalte einsetzen. In Fields brobotAddress auf den HTTPS-Ursprung des Overlay-Links und overlayUrl auf den vollständigen Link mit Zugangstoken setzen; CSS leer lassen.",
    setupSoundAlertsUnverified: "Dieser Klickpfad wurde noch nicht am echten Sound-Alerts-Produkt geprüft.",
    setupHtml: "HTML", setupJs: "JS", setupFields: "Fields", setupViewSnippet: "Inhalt ansehen",
    setupCopySnippet: (name) => `${name} kopieren`, setupSnippetCopied: (name) => `${name} kopiert`,
    setupCopyUnavailable: "Nur Broadcaster und Verwalter dürfen Overlay-Zugänge kopieren.",
    setupAccessInactive: "Dieser Zugang ist abgelaufen oder widerrufen und kann nicht kopiert werden.",
    revoked: "Zugang widerrufen.", revokedPending: "Zugang widerrufen. Verbundene Quellen werden noch geschlossen.", active: "Aktiv",
    expired: "Abgelaufen", revokedStatus: "Widerrufen", noAccesses: "Für dieses Overlay gibt es noch keine Zugänge.", delete: "Overlay löschen",
    deleteTitle: (name) => `Overlay ${name} löschen?`, deleteDescription: (name) => `„${name}“ und seine Elemente werden gelöscht; alle zugehörigen Zugänge werden widerrufen.`,
    deleteConfirm: (name) => `${name} endgültig löschen`, close: "Schließen", conflict: "Das Overlay wurde zwischenzeitlich geändert. Lade es neu und versuche es erneut.",
    guide: "In OBS einrichten", issueReason: "Widerruf über das Dashboard", readOnly: "Bediener können Overlays und deren Verwendung ansehen, aber keine Zugänge verwalten.",
    elementCount: (count) => `${String(count)} Elemente`,
    missingVariable: (name) => `Variable ${name} fehlt`,
    legacyTitle: "Alte Links (Konfiguration im Link)",
    legacyDescription: "Diese ungebundenen Links verwenden noch die alte Konfiguration im Fragment. Hier kannst du sie widerrufen.",
    legacyTokenName: "Unbenannter Alt-Link", legacyCreatedByUnknown: "Ersteller unbekannt", legacyCreatedAt: "Erstellt", legacyTokenId: "Link-ID",
    legacyRevokeTitle: (name) => `Alten Link ${name} widerrufen?`,
    legacyRevokeDescription: (name) => `Der alte Link ${name} wird sofort ungültig. Verbundene Quellen werden geschlossen.`,
    legacyRevokeConfirm: (name) => `${name} widerrufen`, legacyRevocationReason: "Über Alte Links im Dashboard widerrufen", loadMore: "Weitere laden",
    legacyImport: "Importieren", legacyImportTitle: "Alten Link importieren",
    legacyImportDescription: "Füge einen alten Overlay-Link ein. Nur Token, Variable und Anzeigetext werden an den Server gesendet.",
    legacyImportLinkLabel: "Alter Overlay-Link",
    legacyImportPlaceholder: "https://example.invalid/overlay#token=…&var=score&text=Score%3A+%7Bvalue%7D",
    legacyImportCssWarning: "Benutzerdefiniertes OBS-CSS wird nicht importiert.",
    legacyImportPositionWarning: "Positionen in OBS werden nicht importiert.",
    legacyImportTokenWarning: "Ein Token kann mehrere unterschiedliche Fragment-Links bedient haben. Nach dem Import zeigen alle Quellen mit diesem Token dasselbe gespeicherte Overlay.",
    legacyImportConfirm: "Link importieren", legacyImportSuccess: (name) => `Overlay „${name}“ wurde importiert.`,
    legacyImportInvalidLink: "Der Link muss ein Token und eine Variable im Fragment enthalten.",
    legacyImportTokenNotFound: "Der aktive Alt-Link gehört nicht zu diesem Kanal oder wurde widerrufen.",
    legacyImportAlreadyBound: "Dieser Link wurde bereits an ein Overlay gebunden.",
    legacyImportClosingPending: "Overlay importiert. Die verbundene alte Quelle wird noch geschlossen.",
  },
  en: {
    title: "Overlays", list: "Overlays", count: (count, maximum) => `${String(count)} of ${String(maximum)}`,
    empty: "No overlays yet.", loading: "Loading overlays …", loadError: "Overlays could not be loaded.",
    actionError: "The change could not be completed.", managementLocked: "Only broadcasters and managers may change overlays or accesses.",
    create: "New overlay", createTitle: "Create an overlay", name: "Name", width: "Width", height: "Height",
    standardSize: "1920 × 1080", compactSize: "1280 × 720", customSize: "Custom size", createSubmit: "Create overlay", cancel: "Cancel",
    elements: "Elements", accesses: "Accesses", lastUsedAt: "Last used", lastUsedNever: "never", never: "Never", statusLabel: "Status", openAccesses: "Manage accesses", editComposition: "Edit composition",
    editorBack: "Back to overlays", editorLoading: "Loading overlay …", editorLoadError: "The overlay could not be loaded.",
    editorElements: "Elements", editorPreview: "Live preview", editorPreviewCanvas: "Overlay preview", editorProperties: "Properties",
    editorNoElements: "No elements yet. Add a channel variable.", editorNoSelection: "Select an element.", editorReadOnly: "Operators can view the composition, but cannot edit it.",
    editorChooseVariable: "Choose a channel variable", editorAddVariable: "Show variable", editorAdd: "Add", editorLabel: "Element label", editorDisplayText: "Display text",
    editorVariable: "Channel variable", editorX: "X (px)", editorY: "Y (px)", editorScale: "Scale (%)", editorZ: "Layer (z)",
    editorMoveForward: "Move one layer forward", editorMoveBackward: "Move one layer backward", editorRemove: "Remove element", editorInComposition: "Show in composition",
    editorZoom: "Preview zoom", editorReference: (width, height) => `${String(width)} × ${String(height)} reference`, editorTextHint: "Exactly one {value} placeholder is required.",
    editorElementLimit: "An overlay can contain at most 20 elements.", editorMissingPrefill: (name) => `Variable ${name} is no longer available.`, editorSave: "Save",
    editorDiscard: "Discard draft", editorSaved: "Saved — connected sources use the changes immediately.", editorClean: "Saved composition. Changes go live after you save.",
    editorUnsaved: "Unsaved changes", editorSaving: "Saving …", editorSaveError: "The composition could not be saved.",
    editorConflictTitle: "Overlay changed", editorConflictDescription: "Someone else changed this overlay. Reload the latest version or overwrite it with your draft.",
    editorConflictKeep: "Keep editing", editorConflictReload: "Reload", editorConflictOverwrite: "Overwrite",
    editorUnsavedTitle: "Unsaved changes", editorUnsavedDescription: "Your unsaved changes will be lost if you leave.",
    editorContinue: "Keep editing", editorDiscardAndLeave: "Discard and leave", editorSaveAndLeave: "Save and leave",
    issue: "Issue access", issueLabel: "Access name", issueHint: "For example, OBS main PC.", copy: "Copy link",
    copied: "Copied", copyError: "The link could not be copied.", showLink: "Show link", hideLink: "Hide link", fullLink: "Full link", reveal: "Show link again", replace: "Replace", revoke: "Revoke",
    accessUnrecoverable: "This legacy access cannot be shown again. Issue a new access.",
    setup: "Set up", setupAssistant: "Setup assistant", setupAccessSelected: (name) => `Access: ${name}`, setupTarget: "Target platform",
    setupObs: "OBS", setupStreamElements: "StreamElements", setupSoundAlerts: "Sound Alerts", setupOutput: "Output",
    setupWholeOverlay: "Whole overlay", setupSingleElement: "Single element", setupOverlayUrl: "Masked overlay link (display)",
    setupRevealUrl: "Reveal link for copying", setupCopyRevealedUrl: "Copy overlay link", setupCopiedUrl: "Overlay link copied",
    setupDimensions: (width, height) => `Width and height: ${String(width)} × ${String(height)} px`,
    setupElementDimensions: "Width ≈ element width × scale; height follows content.",
    setupObsAddSource: "Add a source", setupObsBrowser: "Choose Browser", setupObsPasteUrl: "The displayed URL is masked; the copied link includes the access token. Copy that link and paste it as the URL.",
    setupObsSetSize: "Set the width and height shown above",
    setupObsClearCss: "Clear “Custom CSS” (use the OBS default CSS)",
    setupObsCssNote: "Put custom CSS in the overlay's style.",
    setupStreamElementsPath: "Overlay → Add Widget → Static/Custom → Custom Widget",
    setupStreamElementsPaste: "Paste into HTML, JS and Fields. In Fields, set brobotAddress to the HTTPS origin of the overlay link and overlayUrl to the full link containing the access token; leave the CSS tab empty.",
    setupStreamElementsWholePlacement: (width, height) => `Place the box at 0/0 and size it to ${String(width)} × ${String(height)}.`,
    setupStreamElementsElementPlacement: "For other positions, single-element output is recommended so only one positioning system is active.",
    setupSoundAlertsPath: "Scenes → Add Widget → Import Widget",
    setupSoundAlertsFallback: "Alternatively add a Custom Widget and paste the same HTML, JS and Fields contents. In Fields, set brobotAddress to the HTTPS origin of the overlay link and overlayUrl to the full link containing the access token; leave CSS empty.",
    setupSoundAlertsUnverified: "This click path has not yet been checked in the real Sound Alerts product.",
    setupHtml: "HTML", setupJs: "JS", setupFields: "Fields", setupViewSnippet: "View contents",
    setupCopySnippet: (name) => `Copy ${name}`, setupSnippetCopied: (name) => `${name} copied`,
    setupCopyUnavailable: "Only broadcasters and managers may copy overlay access links.",
    setupAccessInactive: "This access has expired or been revoked and cannot be copied.",
    revoked: "Access revoked.", revokedPending: "Access revoked. Connected sources are still closing.", active: "Active",
    expired: "Expired", revokedStatus: "Revoked", noAccesses: "This overlay has no accesses yet.", delete: "Delete overlay",
    deleteTitle: (name) => `Delete overlay ${name}?`, deleteDescription: (name) => `“${name}” and its elements will be deleted; all of its accesses will be revoked.`,
    deleteConfirm: (name) => `Delete ${name} permanently`, close: "Close", conflict: "This overlay changed while you were viewing it. Reload it and try again.",
    guide: "Set up in OBS", issueReason: "Revoked from the dashboard", readOnly: "Operators can view overlays and their usage, but cannot manage accesses.",
    elementCount: (count) => `${String(count)} elements`,
    missingVariable: (name) => `Variable ${name} is missing`,
    legacyTitle: "Legacy links (configuration in the link)",
    legacyDescription: "These unbound links still use the old fragment configuration. You can revoke them here.",
    legacyTokenName: "Unnamed legacy link", legacyCreatedByUnknown: "Creator unknown", legacyCreatedAt: "Created", legacyTokenId: "Link ID",
    legacyRevokeTitle: (name) => `Revoke legacy link ${name}?`,
    legacyRevokeDescription: (name) => `The legacy link ${name} will stop working immediately. Connected sources will be closed.`,
    legacyRevokeConfirm: (name) => `Revoke ${name}`, legacyRevocationReason: "Revoked from Legacy links in the dashboard", loadMore: "Load more",
    legacyImport: "Import", legacyImportTitle: "Import a legacy link",
    legacyImportDescription: "Paste an old overlay link. Only its token, variable, and display text are sent to the server.",
    legacyImportLinkLabel: "Legacy overlay link",
    legacyImportPlaceholder: "https://example.invalid/overlay#token=…&var=score&text=Score%3A+%7Bvalue%7D",
    legacyImportCssWarning: "OBS custom CSS is not imported.",
    legacyImportPositionWarning: "OBS positions are not imported.",
    legacyImportTokenWarning: "One token may have served several different fragment links. After import, all sources using this token show the same stored overlay.",
    legacyImportConfirm: "Import link", legacyImportSuccess: (name) => `Overlay “${name}” was imported.`,
    legacyImportInvalidLink: "The link must include a token and a variable in its fragment.",
    legacyImportTokenNotFound: "The active legacy link does not belong to this channel or has been revoked.",
    legacyImportAlreadyBound: "This link is already bound to an overlay.",
    legacyImportClosingPending: "Overlay imported. The connected legacy source is still closing.",
  },
};

export const overlaysTexts = (language: DashboardLanguage = dashboardLanguage()): OverlaysTexts => overlaysCatalog[language];

export interface OverlayObsInstructionsTexts {
  summary: string;
  addBrowserSource: string;
  sourceSize: string;
  refreshWhenActive: string;
  shutdownWhenHidden: string;
  customCss: string;
  secret: string;
  diagnostics: string;
}

const overlayObsInstructionsCatalog: LocaleCatalog<OverlayObsInstructionsTexts> = {
  de: {
    summary: "In OBS einrichten",
    addBrowserSource: "Füge in OBS eine Browserquelle hinzu und setze den vollständigen Overlay-Link als URL ein.",
    sourceSize: "Empfohlener Start: 800 × 120 px. Der Text passt sich dem aktuellen Variablenwert an; plane Platz für den längsten erwarteten Text ein.",
    refreshWhenActive: "„Browser bei Szenenaktivierung aktualisieren“ ausgeschaltet lassen.",
    shutdownWhenHidden: "„Deaktivieren, wenn Quelle nicht sichtbar ist“ ausgeschaltet lassen.",
    customCss: "Zum Anpassen füge dieses CSS in den Einstellungen der Browserquelle in „Benutzerdefiniertes CSS“ ein:",
    secret: "Der Link enthält ein Geheimnis. Du kannst ihn in der Zugangsliste des Overlays widerrufen.",
    diagnostics: "Für Diagnoseinformationen an einen Link ohne Widget &debug=1 im Fragment anhängen (zum Beispiel #token=…&debug=1). Ohne dieses Flag bleibt die Overlay-Seite leer.",
  },
  en: {
    summary: "Set up in OBS",
    addBrowserSource: "Add a Browser Source in OBS and paste the complete overlay link into its URL field.",
    sourceSize: "Suggested starting size: 800 × 120 px. The text follows the current variable value; leave room for the longest text you expect.",
    refreshWhenActive: "Leave “Refresh browser when scene becomes active” off.",
    shutdownWhenHidden: "Leave “Shutdown source when not visible” off.",
    customCss: "To style the widget, paste this CSS into the Browser Source’s Custom CSS field:",
    secret: "The link contains a secret. You can revoke it in the overlay's access list.",
    diagnostics: "To show diagnostics on a link with no widget, append &debug=1 to its fragment (for example, #token=…&debug=1). Without this flag, the overlay page stays empty.",
  },
};

export const overlayObsInstructionsTexts = (
  language: DashboardLanguage = dashboardLanguage(),
): OverlayObsInstructionsTexts => overlayObsInstructionsCatalog[language];

export interface DashboardTexts {
  header: {
    connectionRunning: string;
    connectionWaiting: string;
    connectionInterrupted: string;
    channelIdentity: string;
    noConnection: string;
    switchOn: string;
    switchOff: string;
    streamLive: (duration: string | null) => string;
    streamOffline: string;
    streamUnknown: string;
    streamChecked: (relativeTime: string) => string;
  };
  status: {
    connected: string;
    revoked: string;
    error: string;
    loginIdentityMissing: string;
    notChecked: string;
    expired: string;
    refreshing: string;
    maintenanceOverdue: string;
    renewalOverdue: string;
    valid: string;
    moderatorRoleMissing: string;
    chatSubscriptionError: string;
    chatSubscriptionRevoked: string;
    botError: string;
    botTokenRevoked: string;
    broadcasterConsentMissing: string;
    chatSubscriptionMissing: string;
    chatSubscriptionNotNeeded: string;
    healthy: string;
    stateIncomplete: string;
    notConnected: string;
    notSetUp: string;
    moderator: string;
    missing: string;
    active: string;
    pending: string;
    notRequired: string;
    present: string;
    botPermissionsMissing: (count: string) => string;
  };
  navigation: {
    mainNavigation: string;
    overview: string;
    channel: string;
    system: string;
    members: string;
    variables: string;
    overlays: string;
    module: string;
    events: string;
    audit: string;
    selectChannel: string;
    selectModule: string;
    signInWithTwitch: string;
    twitchAccount: string;
    signingOut: string;
    signOut: string;
    /** Sidebar section heading; the "what you open during an incident" group. */
    operationSection: string;
    collapseSidebar: string;
    expandSidebar: string;
    openSidebar: string;
    closeSidebar: string;
  };
  overview: {
    oneChannelAvailable: string;
    channelsAvailable: (count: string) => string;
    channelsAvailableShort: (count: string) => string;
    noChannelAvailable: string;
    noMembership: string;
    activeModules: string;
    loadState: string;
  };
  moderation: {
    noCheckForChannel: string;
    lastCheck: (timestamp: string) => string;
    checkRunning: string;
    checkModeratorStatus: string;
    nextCheckFrom: (timestamp: string) => string;
    checkLocked: string;
    broadcasterReauthorize: string;
    requestBroadcasterConsent: string;
  };
  bot: {
    noSavedStatus: string;
    lastUpdated: (timestamp: string) => string;
    optionalModules: string;
    normalOperation: string;
    channelBotRequired: string;
    botPermissionsOperator: string;
    botPermissionsComplete: string;
  };
  errors: {
    title: string;
    warning: string;
    sessionInvalid: string;
    dataLoadFailed: string;
    changeFailed: string;
    last: string;
    noCause: string;
  };
  statusCard: {
    yourRole: string;
    broadcasterOauth: string;
    chatConsent: string;
    botAccount: string;
    botPermissions: string;
    moderatorStatus: string;
    chatSubscription: string;
    tokenStatus: string;
    broadcasterConsentMissing: string;
    broadcastExplanation: string;
    noBotStatus: string;
    chatBotRequired: string;
  };
  time: {
    updated: (relativeTime: string) => string;
    secondsAgo: (count: number) => string;
    minutesAgo: (count: number) => string;
    hoursAgo: (count: number) => string;
  };
  system: {
    title: string;
    readOnly: string;
    loadState: string;
    properties: string;
    botReason: string;
    botUpdated: string;
    chatSubscriptionId: string;
    chatSubscriptionReason: string;
    chatSubscriptionUpdated: string;
    loginStatus: string;
    loginReason: string;
    loginValidUntil: string;
    botValidUntil: string;
    subscriptions: string;
    noSubscriptions: string;
    subscription: string;
    state: string;
    reason: string;
    subscriptionDetails: string;
    subscriptionRawType: string;
    subscriptionVersion: string;
    subscriptionId: string;
    subscriptionUpdated: string;
    twitchMessage: string;
    httpStatus: string;
    missingBotPermissions: string;
    missingScopes: string;
  };
  audit: {
    title: string;
    entries: string;
    time: string;
    action: string;
    who: string;
    load: string;
    empty: string;
    changeData: string;
    before: string;
    after: string;
    olderEntries: string;
    loadingOlderEntries: string;
    yes: string;
    no: string;
    newValue: string;
    removedValue: string;
    changedTruncated: string;
    filter: string;
    person: string;
    personHint: string;
    personPlaceholder: string;
    area: string;
    allAreas: string;
    areaLabels: Record<AuditArea, string>;
    activeFilters: string;
    resetFilters: string;
    noMatches: string;
  };
  events: {
    title: string;
    count: (count: string) => string;
    log: string;
    time: string;
    event: string;
    module: string;
    who: string;
    automatic: string;
    info: string;
    error: string;
    notice: string;
    unknown: string;
    code: string;
    timestamp: string;
    operation: string;
    participants: string;
    history: string;
    load: string;
    none: string;
    detail: string;
    loadOlder: string;
    loadingOlder: string;
    filter: string;
    origin: string;
    moduleFilter: string;
    allModules: string;
    tone: string;
    person: string;
    all: string;
    channelEvents: string;
    moduleDiagnostics: string;
    activeFilters: string;
    resetFilters: string;
    noMatches: string;
    loadMoreAtEnd: string;
    feedEnd: string;
    realtimeConnecting: string;
    realtimeConnected: string;
    realtimeReconnecting: string;
    realtimeOffline: string;
    realtimeRenewSession: string;
    realtimeNew: (count: string) => string;
    connectionLost: string;
    retry: string;
    technicalDetails: string;
    copyId: string;
    copied: string;
    trigger: string;
    moderator: string;
    affectedPerson: string;
    /** Accessible name of the hover/focus icon that reveals a warning or
     *  error row's cause without opening the inspector -- takes the row's
     *  own event label so two icons on screen never share one name. */
    showCause: (eventLabel: string) => string;
    /** The popover's second line when Twitch supplied its own diagnostic
     *  message alongside the localized cause (see `eventCause` in
     *  `events/model.ts`) -- labelled so it reads as a quote, not another
     *  translated phrase. */
    causeTwitchMessage: (message: string) => string;
    /** The popover's second line when that extra message is local (a caught
     *  exception's own text, not anything Twitch said) -- a neutral label,
     *  since calling it "Twitch: ..." would misattribute it (see
     *  `eventCause`'s `messageIsFromTwitch`). */
    causeDetailMessage: (message: string) => string;
  };
  signIn: {
    required: string;
    explanation: string;
    signInWithTwitch: string;
    checkChannelAccess: string;
    loadMembers: string;
  };
  module: {
    module: string;
    available: string;
    load: string;
    registered: string;
    active: string;
    inactive: string;
    enable: string;
    disable: string;
    moduleList: string;
    moduleOverview: string;
    managementLocked: string;
    noneActive: string;
    noView: string;
    views: string;
    loadingViews: string;
    settingsLoadError: string;
    unsavedChangesTitle: string;
    unsavedChangesDescription: string;
    continueEditing: string;
    discardAndSwitch: string;
    saveAndSwitch: string;
    notActive: (name: string) => string;
    unknown: (name: string) => string;
    scopesMissing: (name: string) => string;
    requestScopeConsent: string;
    scopeConsentLocked: string;
    scopeList: string;
    scopeMissing: string;
    scopeGranted: string;
  };
  /** Stream Manager: the immediate-action row and the warnings/errors feed
   *  on the channel overview -- each action reports success/failure at
   *  itself, never a global toast (see docs/input/umbau-plan.md Epic 4). */
  streamManager: {
    immediateActions: string;
    availabilityReasons: Record<ImmediateActionUnavailableReason, string>;
    checksHealthy: (count: string) => string;
    checksNeedAttention: (problems: string, checks: string) => string;
    /** Shortcut labels used by Spotlight; action cards use their module catalogue. */
    runAd: (length: string) => string;
    createClip: string;
    sendShoutout: string;
    feedTitle: string;
    feedEmpty: string;
    feedAll: string;
    yesterday: string;
  };
  channelControls: {
    muteName: string;
    pauseName: string;
    muteEnable: string;
    muteDisable: string;
    pauseEnable: string;
    pauseDisable: string;
    muteActive: string;
    pauseActive: string;
    muteRemaining: (minutes: string) => string;
    pauseRemaining: (minutes: string) => string;
    untilStreamEnd: string;
    pendingUntilStreamStart: string;
    unlimited: string;
    durationTitle: (control: string) => string;
    durationDescription: (control: string) => string;
    durationLabel: string;
    durationHint: string;
    duration15m: string;
    duration15mDescription: string;
    duration1h: string;
    duration1hDescription: string;
    durationStream: string;
    durationStreamDescription: string;
    durationUnlimited: string;
    durationUnlimitedDescription: string;
    enable: string;
    cancel: string;
    failure: string;
  };
  /** ⌘K/Ctrl+K (#164): jumps to an entity, explicitly not a navigation
   *  replacement -- "raid" opens the module, "!clip" opens that text
   *  command, "max" opens the member, "ads off"/"clip"/"shoutout &lt;login&gt;"
   *  run a registered action. */
  spotlight: {
    placeholder: string;
    empty: string;
    groupModules: string;
    groupCommands: string;
    groupVariables: string;
    groupActions: string;
    adOff: string;
    adOn: string;
    shoutoutHint: string;
    shoutoutMissingLogin: string;
    openCommand: (name: string) => string;
  };
  /** Full-page states from #159: they replace page content (navigation
   *  stays usable) instead of stacking another red box on a normal page. */
  blocking: {
    botTitle: string;
    botDescriptionAdmin: (botLogin: string) => string;
    botDescriptionBot: string;
    botDescriptionViewer: string;
    botAction: string;
    botSwitchAction: string;
    botSwitching: string;
    botContact: string;
    channelTitle: string;
    channelDescription: string;
    channelAction: string;
    channelContact: string;
  };
}

const dashboardTextsCatalog: LocaleCatalog<DashboardTexts> = {
  de: {
    header: {
      connectionRunning: "Läuft",
      connectionWaiting: "Wartet",
      connectionInterrupted: "Gestört",
      channelIdentity: "Kanal",
      noConnection: "Keine Verbindung",
      switchOn: "An",
      switchOff: "Aus",
      streamLive: (duration) => duration === null ? "Live" : `Live · ${duration} h`,
      streamOffline: "Offline",
      streamUnknown: "Status unbekannt",
      streamChecked: (relativeTime) => `Zustand geprüft ${relativeTime}`,
    },
    status: {
      connected: "Verbunden", revoked: "Widerrufen", error: "Fehler",
      loginIdentityMissing: "Login-Identität fehlt", notChecked: "Nicht geprüft", expired: "Abgelaufen", refreshing: "wird aktualisiert",
      maintenanceOverdue: "Wartung überfällig", renewalOverdue: "Erneuerung überfällig", valid: "Gültig",
      moderatorRoleMissing: "Moderatorrolle fehlt", chatSubscriptionError: "Chat-Abo-Fehler", chatSubscriptionRevoked: "Chat-Abo widerrufen",
      botError: "Bot-Fehler", botTokenRevoked: "Bot-Token widerrufen", broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt",
      chatSubscriptionMissing: "Chat-Abo fehlt", chatSubscriptionNotNeeded: "Nicht benötigt — kein aktives Modul liest den Chat.", healthy: "Gesund", stateIncomplete: "Zustand unvollständig",
      notConnected: "Nicht verbunden", notSetUp: "Nicht eingerichtet", moderator: "Moderator", missing: "Fehlt",
      active: "Aktiv", pending: "Ausstehend", notRequired: "Nicht erforderlich", present: "Vorhanden",
      botPermissionsMissing: (count) => `${count} fehlen`,
    },
    navigation: {
      mainNavigation: "Hauptnavigation", overview: "Übersicht", channel: "Kanal", system: "System",
      members: "Mitglieder", variables: "Variablen", module: "Module", events: "Ereignisse", audit: "Audit-Log", selectChannel: "Kanal auswählen",
      overlays: "Overlays",
      selectModule: "Modul auswählen",
      signInWithTwitch: "Mit Twitch anmelden", twitchAccount: "Twitch-Konto",
      signingOut: "Abmeldung …", signOut: "Abmelden",
      operationSection: "Betrieb",
      collapseSidebar: "Seitenleiste einklappen", expandSidebar: "Seitenleiste ausklappen",
      openSidebar: "Seitenleiste öffnen", closeSidebar: "Seitenleiste schließen",
    },
    overview: {
      oneChannelAvailable: "1 Kanal freigegeben",
      channelsAvailable: (count) => `${count} Kanäle sind für dich freigegeben.`,
      channelsAvailableShort: (count) => `${count} Kanäle freigegeben`,
      noChannelAvailable: "Noch kein Kanal freigegeben",
      noMembership: "Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.",
      activeModules: "Aktive Module", loadState: "Kanalzustand wird geladen …",
    },
    moderation: {
      noCheckForChannel: "Für diesen Kanal liegt noch keine Prüfung vor.",
      lastCheck: (timestamp) => `Letzte Prüfung: ${timestamp}`,
      checkRunning: "Prüfung läuft …", checkModeratorStatus: "Moderatorstatus prüfen",
      nextCheckFrom: (timestamp) => `Nächste Prüfung ab ${timestamp}.`,
      checkLocked: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
      broadcasterReauthorize: "Der Broadcaster muss Twitch erneut autorisieren.",
      requestBroadcasterConsent: "Broadcaster-Zustimmung anfordern",
    },
    bot: {
      noSavedStatus: "Es gibt noch keinen gespeicherten Botstatus.",
      lastUpdated: (timestamp) => `Zuletzt aktualisiert: ${timestamp}`,
      optionalModules: "Für optionale Broadcaster-Module verbunden.",
      normalOperation: "Optional; für den normalen Bot-Betrieb nicht erforderlich.",
      channelBotRequired: "channel:bot wird vom Broadcaster benötigt.",
      botPermissionsOperator: "Der Betreiber muss die Anwendung neu autorisieren.",
      botPermissionsComplete: "Alle angeforderten Bot-Berechtigungen sind vorhanden.",
    },
    errors: {
      title: "Fehler", warning: "Warnung", sessionInvalid: "Deine Sitzung ist nicht mehr gültig.",
      dataLoadFailed: "Die Daten konnten nicht geladen werden.", changeFailed: "Die Änderung ist fehlgeschlagen.", last: "Letzter Fehler",
      noCause: "Keine gespeicherte Ursache",
    },
    statusCard: {
      yourRole: "Deine Rolle", broadcasterOauth: "Broadcaster-OAuth", chatConsent: "Chat-Zustimmung",
      botAccount: "Bot-Account", botPermissions: "Bot-Berechtigungen", moderatorStatus: "Moderatorstatus", chatSubscription: "Chat-Abo", tokenStatus: "Token-Zustand",
      broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt", broadcastExplanation: "Für optionale Broadcaster-Module verbunden.",
      noBotStatus: "Es gibt noch keinen gespeicherten Botstatus.", chatBotRequired: "channel:bot wird vom Broadcaster benötigt.",
    },
    time: {
      updated: (relativeTime) => `aktualisiert ${relativeTime}`, secondsAgo: (count) => `vor ${String(count)} s`,
      minutesAgo: (count) => `vor ${String(count)} Min.`, hoursAgo: (count) => `vor ${String(count)} Std.`,
    },
    system: {
      title: "System", readOnly: "nur lesend", loadState: "Systemzustand wird geladen …", properties: "Eigenschaften",
      botReason: "Bot-Grund", botUpdated: "Bot zuletzt aktualisiert", chatSubscriptionId: "Chat-Abo-ID", chatSubscriptionReason: "Chat-Abo-Grund",
      chatSubscriptionUpdated: "Chat-Abo zuletzt aktualisiert", loginStatus: "Login-Token-Status", loginReason: "Login-Token-Grund",
      loginValidUntil: "Login-Token gültig bis", botValidUntil: "Bot-Token gültig bis",
      subscriptions: "Abonnements", noSubscriptions: "Keine Abonnements gespeichert.", subscription: "Abo", state: "Zustand", reason: "Grund",
      subscriptionDetails: "Abo-Details", subscriptionRawType: "Roher Typ", subscriptionVersion: "Version", subscriptionId: "Abo-ID", subscriptionUpdated: "Zuletzt geändert",
      twitchMessage: "Twitch-Meldung", httpStatus: "HTTP-Status", missingBotPermissions: "Fehlende Bot-Berechtigungen", missingScopes: "Fehlende Scopes",
    },
    audit: {
      title: "Audit-Log", entries: "Einträge", time: "Zeit", action: "Aktion", who: "Wer",
      load: "Audit-Log wird geladen …", empty: "Noch keine Audit-Einträge gespeichert.", changeData: "Änderungsdaten",
      before: "Vorher", after: "Nachher", olderEntries: "Ältere Einträge laden", loadingOlderEntries: "Ältere Einträge werden geladen …",
      yes: "Ja", no: "Nein", newValue: "neu", removedValue: "entfernt",
      changedTruncated: "geändert (Text länger als die Vorschau)",
      filter: "Filter", person: "Person",
      personHint: "Wer die Aktion ausgeführt hat, nicht wer betroffen war.",
      personPlaceholder: "Login oder ID, z. B. beispielnutzer",
      area: "Bereich", allAreas: "Alle Bereiche",
      areaLabels: { module: "Module", command: "Textbefehle", member: "Mitglieder", channel: "Kanal", overlay: "Overlay" },
      activeFilters: "Aktive Filter:", resetFilters: "Filter zurücksetzen", noMatches: "Keine Einträge passen zu den Filtern.",
    },
    events: {
      title: "Ereignisse", count: (count) => `${count} Einträge`, log: "Ereignisprotokoll", time: "Zeit", event: "Ereignis",
      module: "Modul", who: "Wer", automatic: "Automatisch", info: "Info", error: "Fehler", notice: "Hinweis", unknown: "Unbekannt", code: "Code", timestamp: "Zeitstempel", operation: "Vorgang", participants: "Beteiligte", history: "Verlauf",
      load: "Ereignisse werden geladen …",
      none: "Noch keine Ereignisse protokolliert.", detail: "Detail", loadOlder: "Ältere Ereignisse laden", loadingOlder: "Ältere Ereignisse werden geladen …",
      filter: "Filter", origin: "Herkunft", moduleFilter: "Modul", allModules: "Alle Module", tone: "Ton", person: "Person", all: "Alle",
      channelEvents: "Kanalereignisse", moduleDiagnostics: "Moduldiagnosen", activeFilters: "Aktive Filter:", resetFilters: "Filter zurücksetzen",
      noMatches: "Keine Ereignisse passen zu den Filtern.", loadMoreAtEnd: "Am Ende werden ältere Ereignisse nachgeladen.",
      feedEnd: "Ende des Ereignisverlaufs erreicht.",
      realtimeConnecting: "Verbindet …", realtimeConnected: "Verbunden", realtimeReconnecting: "Verbindet neu …",
      realtimeOffline: "Offline", realtimeRenewSession: "Sitzung erneuern", realtimeNew: (count) => `${count} neue Ereignisse`,
      connectionLost: "Verbindung unterbrochen. Die Ereignisse konnten nicht geladen werden.",
      retry: "Erneut versuchen", technicalDetails: "Technische Details", copyId: "ID kopieren", copied: "Kopiert",
      trigger: "Auslöser", moderator: "Moderator", affectedPerson: "Betroffene Person",
      showCause: (eventLabel) => `Ursache anzeigen: ${eventLabel}`,
      causeTwitchMessage: (message) => `Twitch: ${message}`,
      causeDetailMessage: (message) => `Details: ${message}`,
    },
    signIn: {
      required: "Anmeldung erforderlich", explanation: "Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.",
      signInWithTwitch: "Mit Twitch anmelden", checkChannelAccess: "Kanalzugriff wird geprüft …", loadMembers: "Mitglieder werden geladen …",
    },
    module: {
      module: "Modul", available: "Verfügbare Module", load: "Module werden geladen …",
      registered: "Für diesen Bot ist noch kein Modul registriert.", active: "Aktiv", inactive: "Inaktiv",
      enable: "aktivieren", disable: "deaktivieren", moduleList: "Modulliste",
      moduleOverview: "Modulübersicht",
      managementLocked: "Nur Broadcaster und Verwalter dürfen Module ändern.", noneActive: "Keine Module aktiv.",
      noView: "Für dieses aktive Modul gibt es noch keine Panel-Ansicht.", views: "Modulansichten",
      loadingViews: "Modulansichten werden geladen …",
      settingsLoadError: "Moduleinstellungen konnten nicht geladen werden.",
      unsavedChangesTitle: "Ungespeicherte Änderungen",
      unsavedChangesDescription: "Du hast ungespeicherte Moduleinstellungen. Was möchtest du tun?",
      continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln",
      notActive: (name) => `Das Modul „${name}“ ist in diesem Kanal nicht aktiv.`,
      scopesMissing: (name) => `Das Modul „${name}“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.`,
      requestScopeConsent: "Broadcaster-Berechtigungen erteilen",
      scopeConsentLocked: "Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.",
      scopeList: "Benötigte Broadcaster-Berechtigungen",
      scopeMissing: "Fehlt",
      scopeGranted: "Erteilt",
      unknown: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    },
    streamManager: {
      immediateActions: "Sofortaktionen",
      availabilityReasons: {
        stream_offline: "Der Stream ist offline.",
        stream_state_unknown: "Der Streamstatus ist derzeit nicht verfügbar.",
      },
      checksHealthy: (count) => `Alles in Ordnung · ${count} Prüfungen`,
      checksNeedAttention: (problems, checks) => `${problems} auffällige ${problems === "1" ? "Prüfung" : "Prüfungen"} · ${checks} Prüfungen`,
      runAd: (length) => `Werbung jetzt (${length}s)`,
      createClip: "Clip erstellen",
      sendShoutout: "Shoutout senden",
      feedTitle: "Warnungen und Fehler",
      feedEmpty: "Keine Warnungen oder Fehler.",
      feedAll: "Alle im Ereignisprotokoll",
      yesterday: "Gestern",
    },
    channelControls: {
      muteName: "Stummschaltung",
      pauseName: "Pause",
      muteEnable: "Kanal stummschalten",
      muteDisable: "Stummschaltung aufheben",
      pauseEnable: "Automatische Aktionen pausieren",
      pauseDisable: "Automatische Aktionen fortsetzen",
      muteActive: "Kanal stumm",
      pauseActive: "Pausiert",
      muteRemaining: (minutes) => `Stumm · ${minutes} min`,
      pauseRemaining: (minutes) => `Pause · ${minutes} min`,
      untilStreamEnd: "Bis Streamende",
      pendingUntilStreamStart: "Gilt ab dem nächsten Stream",
      unlimited: "Unbegrenzt",
      durationTitle: (control) => `${control} aktivieren`,
      durationDescription: (control) => `Wähle, wie lange ${control.toLowerCase()} aktiv bleibt.`,
      durationLabel: "Dauer",
      durationHint: "Der Standard ist unbegrenzt.",
      duration15m: "15 Minuten",
      duration15mDescription: "Endet automatisch nach 15 Minuten.",
      duration1h: "1 Stunde",
      duration1hDescription: "Endet automatisch nach einer Stunde.",
      durationStream: "Bis Streamende",
      durationStreamDescription: "Wird beim Ende des aktuellen Streams aufgehoben. Ist keiner live, gilt es für den nächsten Stream.",
      durationUnlimited: "Unbegrenzt",
      durationUnlimitedDescription: "Bleibt aktiv, bis du es aufhebst.",
      enable: "Aktivieren",
      cancel: "Abbrechen",
      failure: "Die Kanalsteuerung konnte nicht geändert werden.",
    },
    spotlight: {
      placeholder: "Suchen oder Aktion ausführen …",
      empty: "Keine Treffer.",
      groupModules: "Module",
      groupCommands: "Befehle",
      groupVariables: "Variablen",
      groupActions: "Aktionen",
      adOff: "Werbung aus",
      adOn: "Werbung an",
      shoutoutHint: "shoutout <Twitch-Name>",
      shoutoutMissingLogin: "Twitch-Name nach „shoutout“ eingeben.",
      openCommand: (name) => `Befehl !${name} öffnen`,
    },
    blocking: {
      botTitle: "Der Bot ist nicht angemeldet",
      botDescriptionAdmin: (botLogin) => `Das Bot-Konto @${botLogin} muss die Verbindung herstellen. Melde dich mit diesem Konto an. Verwende dafür nicht dein eigenes Konto.`,
      botDescriptionBot: "Du bist als Bot-Konto angemeldet. Verbinde es, damit BroBot in den freigegebenen Kanälen funktioniert.",
      botDescriptionViewer: "Der Bot ist nicht verbunden. Das betrifft jeden Kanal: EventSub, Chat, Shoutouts und die Mitgliedersuche funktionieren nirgends. Das kann nur der Betreiber der Installation beheben.",
      botAction: "Bot verbinden",
      botSwitchAction: "Mit Bot-Account anmelden",
      botSwitching: "Abmelden …",
      botContact: "Wende dich an den Betreiber der Installation.",
      channelTitle: "Kanal nicht freigegeben",
      channelDescription: "Dieser Kanal ist für dein Konto nicht freigegeben. Andere Kanäle sind davon nicht betroffen.",
      channelAction: "Zur Betreiberansicht",
      channelContact: "Nur der Betreiber kann diesen Kanal für dein Konto freigeben.",
    },
  },
  en: {
    header: {
      connectionRunning: "Running",
      connectionWaiting: "Waiting",
      connectionInterrupted: "Interrupted",
      channelIdentity: "Channel",
      noConnection: "No connection",
      switchOn: "On",
      switchOff: "Off",
      streamLive: (duration) => duration === null ? "Live" : `Live · ${duration} h`,
      streamOffline: "Offline",
      streamUnknown: "Status unknown",
      streamChecked: (relativeTime) => `State checked ${relativeTime}`,
    },
    status: {
      connected: "Connected", revoked: "Revoked", error: "Error", loginIdentityMissing: "Login identity missing",
      notChecked: "Not checked", expired: "Expired", refreshing: "updating", maintenanceOverdue: "Maintenance overdue",
      renewalOverdue: "Renewal overdue", valid: "Valid", moderatorRoleMissing: "Moderator role missing",
      chatSubscriptionError: "Chat subscription error", chatSubscriptionRevoked: "Chat subscription revoked", botError: "Bot error",
      botTokenRevoked: "Bot token revoked", broadcasterConsentMissing: "Broadcaster consent missing",
      chatSubscriptionMissing: "Chat subscription missing", chatSubscriptionNotNeeded: "Not needed — no active module reads chat.", healthy: "Healthy", stateIncomplete: "Incomplete status",
      notConnected: "Not connected", notSetUp: "Not set up", moderator: "Moderator", missing: "Missing", active: "Active",
      pending: "Pending", notRequired: "Not required", present: "Present",
      botPermissionsMissing: (count) => `${count} missing`,
    },
    navigation: {
      mainNavigation: "Main navigation", overview: "Overview", channel: "Channel", system: "System",
      members: "Members", variables: "Variables", module: "Modules", events: "Events", audit: "Audit log", selectChannel: "Select channel",
      overlays: "Overlays",
      selectModule: "Select module",
      signInWithTwitch: "Sign in with Twitch", twitchAccount: "Twitch account",
      signingOut: "Signing out …", signOut: "Sign out",
      operationSection: "Operation",
      collapseSidebar: "Collapse sidebar", expandSidebar: "Expand sidebar",
      openSidebar: "Open sidebar", closeSidebar: "Close sidebar",
    },
    overview: {
      oneChannelAvailable: "1 channel available",
      channelsAvailable: (count) => `${count} channels are available to you.`,
      channelsAvailableShort: (count) => `${count} channels available`,
      noChannelAvailable: "No channel available yet", noMembership: "This account is not a member of an available channel.",
      activeModules: "Active modules", loadState: "Loading channel status …",
    },
    moderation: {
      noCheckForChannel: "This channel has not been checked yet.", lastCheck: (timestamp) => `Last checked: ${timestamp}`,
      checkRunning: "Checking …", checkModeratorStatus: "Check moderator status",
      nextCheckFrom: (timestamp) => `Next check available ${timestamp}.`,
      checkLocked: "Only broadcasters and managers may check moderator status.",
      broadcasterReauthorize: "The broadcaster must authorize Twitch again.", requestBroadcasterConsent: "Request broadcaster consent",
    },
    bot: {
      noSavedStatus: "No bot status has been saved yet.", lastUpdated: (timestamp) => `Last updated: ${timestamp}`,
      optionalModules: "Connected for optional broadcaster modules.", normalOperation: "Optional; not required for normal bot operation.",
      channelBotRequired: "channel:bot is required from the broadcaster.",
      botPermissionsOperator: "The operator must authorize the application again.",
      botPermissionsComplete: "All requested bot permissions are present.",
    },
    errors: {
      title: "Error", warning: "Warning", sessionInvalid: "Your session is no longer valid.", dataLoadFailed: "The data could not be loaded.",
      changeFailed: "The change failed.",
      last: "Last error", noCause: "No saved cause",
    },
    statusCard: {
      yourRole: "Your role", broadcasterOauth: "Broadcaster OAuth", chatConsent: "Chat consent", botAccount: "Bot account", botPermissions: "Bot permissions",
      moderatorStatus: "Moderator status", chatSubscription: "Chat subscription", tokenStatus: "Token status",
      broadcasterConsentMissing: "Broadcaster consent missing", broadcastExplanation: "Connected for optional broadcaster modules.",
      noBotStatus: "No bot status has been saved yet.", chatBotRequired: "channel:bot is required from the broadcaster.",
    },
    time: {
      updated: (relativeTime) => `updated ${relativeTime}`, secondsAgo: (count) => `${String(count)} sec ago`,
      minutesAgo: (count) => `${String(count)} min ago`, hoursAgo: (count) => `${String(count)} hr ago`,
    },
    system: {
      title: "System", readOnly: "read-only", loadState: "Loading system status …", properties: "Properties",
      botReason: "Bot reason", botUpdated: "Bot last updated", chatSubscriptionId: "Chat subscription ID", chatSubscriptionReason: "Chat subscription reason",
      chatSubscriptionUpdated: "Chat subscription last updated", loginStatus: "Login token status", loginReason: "Login token reason",
      loginValidUntil: "Login token valid until", botValidUntil: "Bot token valid until",
      subscriptions: "Subscriptions", noSubscriptions: "No subscriptions saved.", subscription: "Subscription", state: "State", reason: "Reason",
      subscriptionDetails: "Subscription details", subscriptionRawType: "Raw type", subscriptionVersion: "Version", subscriptionId: "Subscription ID", subscriptionUpdated: "Last changed",
      twitchMessage: "Twitch message", httpStatus: "HTTP status", missingBotPermissions: "Missing bot permissions", missingScopes: "Missing scopes",
    },
    audit: {
      title: "Audit log", entries: "entries", time: "Time", action: "Action", who: "Who",
      load: "Loading audit log …", empty: "No audit entries saved yet.", changeData: "Change data",
      before: "Before", after: "After", olderEntries: "Load older entries", loadingOlderEntries: "Loading older entries …",
      yes: "Yes", no: "No", newValue: "new", removedValue: "removed",
      changedTruncated: "changed (text longer than preview)",
      filter: "Filters", person: "Person",
      personHint: "Who performed the action, not who was affected by it.",
      personPlaceholder: "Login or ID, e.g. example_user",
      area: "Area", allAreas: "All areas",
      areaLabels: { module: "Modules", command: "Text commands", member: "Members", channel: "Channel", overlay: "Overlay" },
      activeFilters: "Active filters:", resetFilters: "Reset filters", noMatches: "No entries match the filters.",
    },
    events: {
      title: "Events", count: (count) => `${count} entries`, log: "Event log", time: "Time", event: "Event", module: "Module",
      who: "Who", automatic: "Automatic", info: "Info", error: "Error", notice: "Notice", unknown: "Unknown", code: "Code", timestamp: "Timestamp", operation: "Operation", participants: "Participants", history: "History", load: "Loading events …", none: "No events logged yet.", detail: "Detail",
      loadOlder: "Load older events", loadingOlder: "Loading older events …",
      filter: "Filters", origin: "Origin", moduleFilter: "Module", allModules: "All modules", tone: "Tone", person: "Person", all: "All",
      channelEvents: "Channel events", moduleDiagnostics: "Module diagnostics", activeFilters: "Active filters:", resetFilters: "Reset filters",
      noMatches: "No events match the filters.", loadMoreAtEnd: "Older events load at the end.",
      feedEnd: "End of the event history reached.",
      realtimeConnecting: "Connecting …", realtimeConnected: "Connected", realtimeReconnecting: "Reconnecting …",
      realtimeOffline: "Offline", realtimeRenewSession: "Renew session", realtimeNew: (count) => `${count} new events`,
      connectionLost: "Connection lost. The events could not be loaded.",
      retry: "Retry", technicalDetails: "Technical details", copyId: "Copy ID", copied: "Copied",
      trigger: "Trigger", moderator: "Moderator", affectedPerson: "Affected person",
      showCause: (eventLabel) => `Show cause: ${eventLabel}`,
      causeTwitchMessage: (message) => `Twitch: ${message}`,
      causeDetailMessage: (message) => `Details: ${message}`,
    },
    signIn: {
      required: "Sign-in required", explanation: "Sign in with your Twitch account to see available channels.",
      signInWithTwitch: "Sign in with Twitch", checkChannelAccess: "Checking channel access …", loadMembers: "Loading members …",
    },
    module: {
      module: "Module", available: "Available modules", load: "Loading modules …", registered: "No module is registered for this bot yet.",
      active: "Active", inactive: "Inactive", enable: "enable", disable: "disable", moduleList: "Module list",
      moduleOverview: "Module overview",
      managementLocked: "Only broadcasters and managers may change modules.", noneActive: "No modules active.",
      noView: "This active module does not have a panel view yet.", views: "Module views", loadingViews: "Loading module views …", settingsLoadError: "Module settings could not be loaded.",
      unsavedChangesTitle: "Unsaved changes",
      unsavedChangesDescription: "You have unsaved module settings. What would you like to do?",
      continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch",
      notActive: (name) => `The module “${name}” is not active in this channel.`,
      unknown: (name) => `The module “${name}” is unknown.`,
      scopesMissing: (name) => `The module “${name}” is disabled because broadcaster permissions are missing.`,
      requestScopeConsent: "Grant broadcaster permissions",
      scopeConsentLocked: "Only this channel’s broadcaster may grant this consent.",
      scopeList: "Required broadcaster permissions",
      scopeMissing: "Missing",
      scopeGranted: "Granted",
    },
    streamManager: {
      immediateActions: "Immediate actions",
      availabilityReasons: {
        stream_offline: "The stream is offline.",
        stream_state_unknown: "The stream status is currently unavailable.",
      },
      checksHealthy: (count) => `All clear · ${count} checks`,
      checksNeedAttention: (problems, checks) => `${problems} ${problems === "1" ? "check needs" : "checks need"} attention · ${checks} checks`,
      runAd: (length) => `Run ad now (${length}s)`,
      createClip: "Create clip",
      sendShoutout: "Send shoutout",
      feedTitle: "Warnings and errors",
      feedEmpty: "No warnings or errors.",
      feedAll: "View all in the event log",
      yesterday: "Yesterday",
    },
    channelControls: {
      muteName: "Mute",
      pauseName: "Pause",
      muteEnable: "Mute channel",
      muteDisable: "Unmute channel",
      pauseEnable: "Pause automatic actions",
      pauseDisable: "Resume automatic actions",
      muteActive: "Muted",
      pauseActive: "Paused",
      muteRemaining: (minutes) => `Muted · ${minutes} min`,
      pauseRemaining: (minutes) => `Paused · ${minutes} min`,
      untilStreamEnd: "Until stream ends",
      pendingUntilStreamStart: "Applies starting with the next stream",
      unlimited: "Unlimited",
      durationTitle: (control) => `Enable ${control.toLowerCase()}`,
      durationDescription: (control) => `Choose how long ${control.toLowerCase()} stays active.`,
      durationLabel: "Duration",
      durationHint: "Unlimited is selected by default.",
      duration15m: "15 minutes",
      duration15mDescription: "Ends automatically after 15 minutes.",
      duration1h: "1 hour",
      duration1hDescription: "Ends automatically after one hour.",
      durationStream: "Until stream ends",
      durationStreamDescription: "Turns off when the current stream ends. If offline, it applies to the next stream and ends with it.",
      durationUnlimited: "Unlimited",
      durationUnlimitedDescription: "Stays on until you turn it off.",
      enable: "Enable",
      cancel: "Cancel",
      failure: "The channel control could not be changed.",
    },
    spotlight: {
      placeholder: "Search or run an action …",
      empty: "No matches.",
      groupModules: "Modules",
      groupCommands: "Commands",
      groupVariables: "Variables",
      groupActions: "Actions",
      adOff: "Ads off",
      adOn: "Ads on",
      shoutoutHint: "shoutout <Twitch login>",
      shoutoutMissingLogin: "Type a Twitch login after “shoutout”.",
      openCommand: (name) => `Open command !${name}`,
    },
    blocking: {
      botTitle: "The bot is not signed in",
      botDescriptionAdmin: (botLogin) => `The bot account @${botLogin} must connect. Sign in with that account. Do not use your own account.`,
      botDescriptionBot: "You're signed in as the bot account. Connect it so BroBot works in the released channels.",
      botDescriptionViewer: "The bot is not connected. This affects every channel: EventSub, chat, shoutouts, and member search fail everywhere. Only the installation's operator can fix this.",
      botAction: "Connect bot",
      botSwitchAction: "Sign in with bot account",
      botSwitching: "Signing out …",
      botContact: "Contact the installation's operator.",
      channelTitle: "Channel not released",
      channelDescription: "This channel is not released to your account. Other channels are not affected.",
      channelAction: "Go to the operator view",
      channelContact: "Only the operator can release this channel to your account.",
    },
  },
};

// Re-exported from `contracts/values` (not declared here): modules and the
// worker construct diagnostics with this same type, so it has to live where
// both sides of the module boundary can reach it. See `EVENT_CODES` there
// for the full list and the freeze this closed union gives every
// construction site.
export type { EventCode };

export type EventDetail = Readonly<Record<string, unknown>>;
export type EventText = string | ((detail: EventDetail) => string);

const textCommandName = (detail: EventDetail): string | null =>
  typeof detail.name === "string" && detail.name.length > 0 ? detail.name : null;

const eventTextWithName = (
  detail: EventDetail,
  withoutName: string,
  withName: (name: string) => string,
): string => {
  const name = textCommandName(detail);
  return name === null ? withoutName : withName(name);
};

/** `channel_events.chat.unknown`'s notice type ("art"): shown when Twitch's
 *  own type is present, left out entirely (not even a placeholder) when the
 *  producer had none to record -- issue #201, "Unbekannte Chat-
 *  Benachrichtigung: unbekannt" doubled up the same "unknown" twice. Rows
 *  written before that fix still carry the old `"unbekannt"` placeholder
 *  literally (the producer stored its own internal branching sentinel,
 *  fixed at the source too, but the event log's 14-day retention means
 *  already-persisted rows keep the old value) -- treated the same as no
 *  type at all, not shown as if it were a real notice type. */
const LEGACY_UNKNOWN_NOTICE_TYPE = "unbekannt";

const chatUnknownText = (
  detail: EventDetail,
  withoutType: string,
  withType: (art: string) => string,
): string => {
  const art = detail.art;
  return typeof art === "string" && art.length > 0 && art !== LEGACY_UNKNOWN_NOTICE_TYPE
    ? withType(art)
    : withoutType;
};

const detailText = (detail: EventDetail, key: string, fallback: string): string =>
  typeof detail[key] === "string" && detail[key].length > 0 ? detail[key] : fallback;

const textCommandTier = (detail: EventDetail, key: string, fallback: string, language: DashboardLanguage): string => {
  const value = detail[key];
  const labels: Record<string, string> = language === "de"
    ? { everyone: "alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster", viewer: "Zuschauer" }
    : { everyone: "everyone", subscriber: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcaster", viewer: "viewer" };
  const values = Array.isArray(value) ? value : [value];
  const labeledValues = values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return labeledValues.length === 0
    ? fallback
    : labeledValues.map((entry) => catalogString(labels, entry) ?? entry).join(", ");
};

const detailNumber = (detail: EventDetail, key: string, fallback: string): string =>
  typeof detail[key] === "number" && Number.isFinite(detail[key]) ? String(detail[key]) : fallback;

const detailDuration = (detail: EventDetail, unit: string, fallback: string): string =>
  typeof detail.duration === "number" && Number.isFinite(detail.duration) ? `${String(detail.duration)} ${unit}` : fallback;

const detailReason = (detail: EventDetail): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? `: ${detail.reason}`
    : "";

const detailReasonWith = (detail: EventDetail, preposition: string): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? ` ${preposition} ${detail.reason}`
    : "";

const detailClassification = (detail: EventDetail, fallback: string): string =>
  typeof detail.einstufung === "string" && detail.einstufung.length > 0 ? detail.einstufung : fallback;

const detailModerator = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` von ${detail.moderator}` : fallback;

const detailModeratorEn = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` by ${detail.moderator}` : fallback;

const shoutoutFailureTexts: LocaleCatalog<Record<ShoutoutFailureReason, string>> = {
  de: {
    app_token_unavailable: "App-Token nicht verfügbar",
    bot_identity_missing: "Bot-Identität fehlt",
    network_error: "Netzwerkfehler bei Twitch",
    not_moderator: "Der Bot ist kein Moderator in diesem Kanal",
    rate_limited: "Twitch-Abklingzeit aktiv",
    scope_missing: "Berechtigung zum Senden des Shoutouts fehlt",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    twitch_error: "Twitch hat den Shoutout abgelehnt",
    twitch_user_not_found: "Twitch-Nutzer nicht gefunden",
    twitch_user_search_failed: "Twitch-Nutzersuche fehlgeschlagen",
  },
  en: {
    app_token_unavailable: "App token unavailable",
    bot_identity_missing: "Bot identity is missing",
    network_error: "Network error from Twitch",
    not_moderator: "The bot is not a moderator in this channel",
    rate_limited: "Twitch cooldown is active",
    scope_missing: "Permission to send shoutouts is missing",
    timeout: "The Twitch request timed out",
    twitch_error: "Twitch rejected the shoutout",
    twitch_user_not_found: "Twitch user not found",
    twitch_user_search_failed: "Twitch user search failed",
  },
};

export const shoutoutFailureReasonText = (
  reason: unknown,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => typeof reason === "string" && SHOUTOUT_FAILURE_REASONS.includes(reason as ShoutoutFailureReason)
  ? shoutoutFailureTexts[language][reason as ShoutoutFailureReason]
  : null;

const commercialFailureTexts: LocaleCatalog<Record<CommercialFailureReason, string>> = {
  de: {
    app_token_unavailable: "App-Token nicht verfügbar",
    network_error: "Netzwerkfehler bei Twitch",
    rate_limited: "Twitch-Abklingzeit aktiv",
    scope_missing: "Berechtigung für Werbeeinblendungen fehlt",
    stream_offline: "Stream ist offline",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    twitch_error: "Twitch hat den Start abgelehnt",
  },
  en: {
    app_token_unavailable: "App token unavailable",
    network_error: "Network error from Twitch",
    rate_limited: "Twitch cooldown is active",
    scope_missing: "Permission to run commercials is missing",
    stream_offline: "The stream is offline",
    timeout: "The Twitch request timed out",
    twitch_error: "Twitch rejected the request",
  },
};

const commercialFailureReasonText = (reason: unknown, language: DashboardLanguage): string =>
  typeof reason === "string" && COMMERCIAL_FAILURE_REASONS.includes(reason as CommercialFailureReason)
    ? commercialFailureTexts[language][reason as CommercialFailureReason]
    : commercialFailureTexts[language].twitch_error;

/**
 * `createClip` (`worker/clip.ts`) and its route (`worker/panel/routes.ts`,
 * when no bot credentials exist at all): `rate_limited` (429),
 * `scope_missing` (401), `not_live` (400 -- Twitch rejects Create Clip while
 * the channel isn't live), `bot_identity_missing`, `timeout`/`network_error`
 * from `helixRequest`, or an uncatalogued `http_<status>` that falls through
 * to the raw value below.
 */
const clipFailureTexts: LocaleCatalog<Record<string, string>> = {
  de: {
    rate_limited: "Twitch-Abklingzeit aktiv",
    scope_missing: "Berechtigung zum Erstellen von Clips fehlt",
    not_live: "Der Stream ist nicht live",
    bot_identity_missing: "Bot-Identität fehlt",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    network_error: "Netzwerkfehler bei Twitch",
  },
  en: {
    rate_limited: "Twitch cooldown is active",
    scope_missing: "Permission to create clips is missing",
    not_live: "The stream is not live",
    bot_identity_missing: "Bot identity is missing",
    timeout: "The Twitch request timed out",
    network_error: "Network error from Twitch",
  },
};

/**
 * `sendChatMessage` (`worker/chat.ts`)'s own reason beyond what the generic
 * catalog already covers: `not_sent` is its fallback when Twitch reports the
 * message as not sent (`is_sent: false`) but without a `drop_reason.code` to
 * go with it. Its other reasons (`bot_identity_missing`,
 * `app_token_unavailable`, `rate_limited`, `timeout`, `network_error`) are
 * shared infra concepts that resolve through `genericFailureTexts` instead.
 * An `http_<status>` or Twitch's own arbitrary `drop_reason.code` (e.g. a
 * moderation reason) stays uncatalogued -- there is no fixed set of those to
 * translate.
 */
const chatFailureTexts: LocaleCatalog<Record<string, string>> = {
  de: { not_sent: "Twitch hat die Nachricht nicht bestätigt" },
  en: { not_sent: "Twitch did not confirm the message" },
};

/**
 * `decideAdBreak` (`modules/ads/domain`)'s closed reason set for a skipped
 * ad break -- see `AdsSkippedReason`/`ADS_SKIPPED_REASONS`.
 */
const adsSkipReasonTexts: LocaleCatalog<Record<AdsSkippedReason, string>> = {
  de: {
    duration_zero: "Dauer ist null",
    duration_invalid: "Werbedauer ist ungültig",
    start_invalid: "Startzeitpunkt ist ungültig",
  },
  en: {
    duration_zero: "Duration is zero",
    duration_invalid: "Ad duration is invalid",
    start_invalid: "Start time is invalid",
  },
};

const adsSkipReasonText = (reason: unknown, language: DashboardLanguage): string =>
  typeof reason === "string" && (ADS_SKIPPED_REASONS as readonly string[]).includes(reason)
    ? adsSkipReasonTexts[language][reason as AdsSkippedReason]
    : adsSkipReasonTexts[language].duration_invalid;

/**
 * `decideRaid` (`modules/raid/domain`)'s closed reason set for a discarded
 * raid -- see `RaidInvalidReason`/`RAID_INVALID_REASONS`.
 */
const raidInvalidReasonTexts: LocaleCatalog<Record<RaidInvalidReason, string>> = {
  de: {
    target_invalid: "Ziel ungültig",
    source_invalid: "Quelle ungültig",
    viewers_invalid: "Zuschauerzahl ungültig",
  },
  en: {
    target_invalid: "Invalid target",
    source_invalid: "Invalid source",
    viewers_invalid: "Invalid viewer count",
  },
};

const raidInvalidReasonText = (reason: unknown, language: DashboardLanguage): string =>
  typeof reason === "string" && (RAID_INVALID_REASONS as readonly string[]).includes(reason)
    ? raidInvalidReasonTexts[language][reason as RaidInvalidReason]
    : language === "de" ? "ungültige Daten" : "invalid data";

/**
 * `processRaid` (`modules/raid/service`)'s closed reason set for a
 * suppressed shoutout -- see `ShoutoutSuppressedReason`/
 * `SHOUTOUT_SUPPRESSED_REASONS`. The row text (`eventTexts["shoutout.
 * suppressed"]`) stays a hand-rolled formatter instead of reading this --
 * it also folds in the viewer/threshold numbers, which a flat string
 * catalog can't carry. This one only backs `eventCauseText`, defensively
 * (see `REASON_CATALOG_BY_CODE`'s comment).
 */
const shoutoutSuppressedReasonTexts: LocaleCatalog<Record<ShoutoutSuppressedReason, string>> = {
  de: { disabled: "Shoutout abgeschaltet", below_threshold: "Shoutout unter der Schwelle" },
  en: { disabled: "Shoutout disabled", below_threshold: "Shoutout below threshold" },
};

/**
 * The last-resort catalog for a code with no reason vocabulary of its own
 * (`host.action.failed`, `host.module.error`, ...): only the handful of
 * reasons common enough across producers to word neutrally, worded so they
 * don't imply a specific action ("a required permission", not "to send the
 * shoutout"). Anything more specific belongs in that code's own catalog
 * instead of here -- see `REASON_CATALOG_BY_CODE`.
 */
const genericFailureTexts: LocaleCatalog<Record<string, string>> = {
  de: {
    rate_limited: "Twitch-Abklingzeit aktiv",
    scope_missing: "Eine erforderliche Berechtigung fehlt",
    not_live: "Der Stream ist nicht live",
    twitch_error: "Twitch hat die Anfrage abgelehnt",
    app_token_unavailable: "App-Token nicht verfügbar",
    bot_identity_missing: "Bot-Identität fehlt",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    network_error: "Netzwerkfehler bei Twitch",
  },
  en: {
    rate_limited: "Twitch cooldown is active",
    scope_missing: "A required permission is missing",
    not_live: "The stream is not live",
    twitch_error: "Twitch rejected the request",
    app_token_unavailable: "App token unavailable",
    bot_identity_missing: "Bot identity is missing",
    timeout: "The Twitch request timed out",
    network_error: "Network error from Twitch",
  },
};

/**
 * Which failure catalog a code's own `eventTexts` entry draws its reason
 * from -- `"twitch_error"` and `"scope_missing"` mean something different
 * for each producer ("Twitch rejected the shoutout" vs. "... the request";
 * "permission to send shoutouts" vs. "... to create clips"), so the cause
 * popover has to pick the same catalog the row's own text used, never guess
 * from the value alone across catalogs. `host.announcement.failed` reuses
 * the shoutout catalog outright -- `sendChatAnnouncement` (`worker/
 * announcement.ts`) emits exactly the same `not_moderator`/
 * `bot_identity_missing`/`app_token_unavailable` (plus the generic Helix
 * reasons) as `sendShoutout` does. `ads.skipped`, `raid.invalid`, and
 * `shoutout.suppressed` are listed here too even though
 * `eventCauseAlreadyShown` below currently suppresses their icon outright
 * (their row text is exhaustive over every reason their producer emits) --
 * belt and suspenders: if that suppression ever changes, no machine id
 * leaks through by accident.
 */
const REASON_CATALOG_BY_CODE: Partial<Record<EventCode, LocaleCatalog<Record<string, string>>>> = {
  "host.shoutout.failed": shoutoutFailureTexts,
  "host.announcement.failed": shoutoutFailureTexts,
  "ads.commercial.failed": commercialFailureTexts,
  "host.clip.failed": clipFailureTexts,
  "host.chat.failed": chatFailureTexts,
  "ads.skipped": adsSkipReasonTexts,
  "raid.invalid": raidInvalidReasonTexts,
  "shoutout.suppressed": shoutoutSuppressedReasonTexts,
};

const HTTP_STATUS_REASON_PATTERN = /^http_(\d{3})$/;

/** `helixRequest`'s (`worker/twitch/helix.ts`) generic fallback for any
 *  status it has no more specific reason for -- shared across every Helix
 *  caller (chat, shoutout, clip, ...), so this lives beside `eventCauseText`
 *  itself rather than in any one producer's catalog. */
const httpStatusCauseText = (status: string, language: DashboardLanguage): string =>
  language === "de" ? `Twitch antwortete mit Fehler ${status}` : `Twitch responded with error ${status}`;

/** The last resort when nothing else -- catalog, `http_<status>` pattern,
 *  or a `detail.message` -- identifies the cause at all (e.g. an arbitrary
 *  Twitch chat moderation code with no message attached). Still better than
 *  showing the raw machine value, which stays reserved for the inspector's
 *  technical details. */
const unknownCauseText: LocaleCatalog<string> = {
  de: "Unbekannte Ursache",
  en: "Unknown cause",
};

/**
 * The localized cause behind a warning/error event, read from the
 * `reason`/`cause`/`twitchMessage`/`message` diagnostic keys. Looks up the
 * code's own failure catalog first (`REASON_CATALOG_BY_CODE`), falls back
 * to the small shared `genericFailureTexts` only when the code has none.
 * When neither covers the value: a nonempty `detail.twitchMessage` wins
 * next, then a nonempty `detail.message` -- Twitch's own message (a Helix
 * error body's `message`, or a chat drop reason's `message`; producers
 * label it `twitchMessage` specifically where it came from a Twitch
 * response, keeping `message` for a caught exception's own local text --
 * see `writeModuleDiagnostics` in `worker/event-log.ts`, which caps both at
 * ingestion) reads better than a bare code; then an `http_<status>` pattern
 * gets a generic "Twitch responded with error <status>"; anything else
 * uncatalogued falls back to `unknownCauseText`.
 * The raw machine value never reaches this function's return value -- it
 * stays visible only in the inspector's technical details
 * (`formatEventDetail`). Reused by the events list's hover icon so the
 * cause is readable without opening the inspector, even for codes whose own
 * row text stays generic (`host.chat.failed`, `host.action.failed`, ...).
 * Returns null when the detail carries none of those keys, so the row gets
 * no icon at all.
 */
export const eventCauseText = (
  code: string,
  detail: EventDetail,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  const raw = detail.reason ?? detail.cause ?? detail.twitchMessage ?? detail.message;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const ownCatalog = REASON_CATALOG_BY_CODE[code as EventCode];
  const localized = (ownCatalog === undefined ? undefined : catalogString(ownCatalog[language], raw))
    ?? catalogString(genericFailureTexts[language], raw);
  if (localized !== undefined) return localized;
  const message = detail.twitchMessage ?? detail.message;
  if (typeof message === "string" && message.length > 0) return message;
  const httpStatus = HTTP_STATUS_REASON_PATTERN.exec(raw)?.[1];
  if (httpStatus !== undefined) return httpStatusCauseText(httpStatus, language);
  return unknownCauseText[language];
};

/**
 * Codes whose own `eventTexts` row formatter always folds *some* phrase for
 * the failure cause into what it renders, however uncatalogued the raw
 * value: `host.announcement.failed` and `ads.prewarning.schedule_error`
 * embed the full `eventCauseText` resolution verbatim (own/generic catalog,
 * then Twitch's own `message`, then the `http_<status>` pattern, then the
 * unknown-cause fallback -- always something, once there's a raw value at
 * all). `ads.commercial.failed`, `raid.invalid`, `ads.skipped`, and
 * `shoutout.suppressed` each read their own reason function that has no
 * null branch either: every value their closed union allows already has
 * covering text, `ads.commercial.failed`'s falling back to its own generic
 * "Twitch rejected the request" wording for anything else. The hover icon
 * would only repeat that -- unless Twitch also supplied a `message` these
 * never surface (see `eventCause` in `events/model.ts`, which checks that
 * separately).
 *
 * `host.shoutout.failed` is deliberately absent: its formatter's own
 * `shoutoutFailureReasonText` returns null for anything outside
 * `SHOUTOUT_FAILURE_REASONS`, and the row then shows nothing extra at all
 * ("Shoutout failed", full stop) -- exactly the case the icon needs to
 * cover, so `eventCauseAlreadyShown` checks that catalog directly below
 * instead of assuming it.
 */
const CODES_ALWAYS_FOLDING_CAUSE = new Set<EventCode>([
  "host.announcement.failed",
  "ads.commercial.failed",
  "raid.invalid",
  "ads.prewarning.schedule_error",
  "shoutout.suppressed",
  "ads.skipped",
]);

/** Whether `code`'s own row text (`eventTexts`) already shows the cause
 *  `eventCauseText` would resolve for this entry -- the other half of
 *  `eventCause`'s icon decision besides a Twitch `message` (see there).
 *  Derived from the same catalog lookups each formatter draws on, not from
 *  comparing rendered strings: a wording mismatch between this and the row
 *  would otherwise go unnoticed (see `CODES_ALWAYS_FOLDING_CAUSE`). */
export const eventCauseAlreadyShown = (code: string, detail: EventDetail): boolean =>
  CODES_ALWAYS_FOLDING_CAUSE.has(code as EventCode) ||
  (code === "host.shoutout.failed" && shoutoutFailureReasonText(detail.cause) !== null);

export const eventTexts: LocaleCatalog<Record<EventCode, EventText>> = {
  de: {
    "host.action.failed": "Aktion fehlgeschlagen",
    "host.action.suppressed": (detail) => `Aktion unterdrückt: ${detail.action === "chat" ? "Chatnachricht" : detail.action === "announcement" ? "Ankündigung" : "Shoutout"} wegen Kanal-Stummschaltung`,
    "host.chat.failed": "Chat-Nachricht fehlgeschlagen",
    "host.chat.sent": "Chat-Nachricht gesendet",
    "host.chat.skipped": "Chat-Nachricht übersprungen: Zeitplan hat sich in letzter Sekunde geändert",
    "host.announcement.sent": (detail) => `Chat-Ankündigung gesendet: ${detailText(detail, "text", "ohne Text")}`,
    "host.announcement.failed": (detail) => {
      const reason = eventCauseText("host.announcement.failed", detail, "de") ?? "unbekannter Grund";
      return detail.outcome === "sent_as_message"
        ? `Ankündigung nicht möglich (${reason}) — als Nachricht gesendet`
        : `Ankündigung nicht möglich (${reason}) — nicht gesendet`;
    },
    "template_truncated": (detail) => `Chatnachricht auf 500 Zeichen gekürzt (ursprünglich ${detailNumber(detail, "current", "unbekannte Länge")})`,
    "template.lookup_unavailable": (detail) => `Vorlagenvariable ${detailText(detail, "name", "unbekannt")} ist gerade nicht verfügbar`,
    "template_parameters_invalid": (detail) => `Ungültiger Variablenparameter: ${detailText(detail, "name", "unbekannt")}`,
    "host.module.error": "Modulfehler",
    "host.module.unknown": "Unbekanntes Modul",
    "host.overlay.not_executed": "Overlay nicht ausgeführt",
    "host.shoutout.failed": (detail) => {
      if (detail.cause === "twitch_user_not_found") return `Shoutout-Ziel ${detailText(detail, "target", "unbekannt")} wurde nicht gefunden`;
      const reason = shoutoutFailureReasonText(detail.cause, "de");
      return reason === null ? "Shoutout fehlgeschlagen" : `Shoutout fehlgeschlagen: ${reason}`;
    },
    "host.shoutout.sent": "Shoutout gesendet",
    "host.clip.failed": "Clip fehlgeschlagen",
    "channel_events.raid.incoming": (detail) => `Raid von ${detailText(detail, "source", "unbekannt")} mit ${detailNumber(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.raid.outgoing": (detail) => `Raid zu ${detailText(detail, "target", "unbekannt")} mit ${detailNumber(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.shoutout.sent": (detail) => `Shoutout an ${detailText(detail, "target", "unbekannt")}`,
    "channel_events.shoutout.received": (detail) => `Shoutout von ${detailText(detail, "source", "unbekannt")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` mit ${String(detail.viewers)} Zuschauern` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.resub": (detail) => `Resub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift-Sub von ${detailText(detail, "gifter", "unbekannt")} an ${detailText(detail, "recipient", "unbekannt")}`,
    "channel_events.chat.community_gift": (detail) => `Community-Gift von ${detailText(detail, "gifter", "unbekannt")} für ${detailNumber(detail, "count", "unbekannte Anzahl")} Subs`,
    "channel_events.chat.announcement": (detail) => `Ankündigung von ${detailText(detail, "person", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.chat.unknown": (detail) => chatUnknownText(detail, "Unbekannte Chat-Benachrichtigung", (art) => `Unbekannte Chat-Benachrichtigung: ${art}`),
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unbekannt")} gebannt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unbekannt")} für ${detailDuration(detail, "Sekunden", "unbekannte Dauer")} getimeoutet von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unbekannt")} aus dem Timeout genommen von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unbekannt")} entbannt von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.delete": (detail) => `Nachricht von ${detailText(detail, "person", "unbekannt")} gelöscht von ${detailText(detail, "moderator", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unbekannt")} verwarnt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.unknown": (detail) => `Unbekannte Moderationsaktion: ${detailText(detail, "action", "unbekannt")}`,
    "channel_events.automod.held": (detail) => `AutoMod hielt die Nachricht von ${detailText(detail, "person", "unbekannt")}${detailReasonWith(detail, "wegen")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.suspicious.message": (detail) => `Nachricht von auffälligem Nutzer ${detailText(detail, "person", "unbekannt")} (${detailClassification(detail, "unbekannte Einstufung")}): ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.suspicious.classified": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} verschärft${detailModerator(detail, "")}: ${detailClassification(detail, "unbekannt")}`,
    "channel_events.suspicious.cleared": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} aufgehoben${detailModerator(detail, "")}`,
    "channel_events.stream.online": (detail) => `Stream gestartet${typeof detail.startedAt === "string" ? `: ${detail.startedAt}` : ""}`,
    "channel_events.stream.offline": "Stream beendet",
    "raid.outgoing": (detail) => `Ausgehender Raid zu ${detailText(detail, "targetChannelId", "unbekannt")}`,
    "raid.shoutout": (detail) => `Raid über der Schwelle (${detailNumber(detail, "viewers", "unbekannt")} von ${detailNumber(detail, "threshold", "unbekannt")}): Shoutout und Chatzeile`,
    "raid.invalid": (detail) => `Raid verworfen: ${raidInvalidReasonText(detail.reason, "de")}`,
    "shoutout.suppressed": (detail) => detail.reason === ("disabled" satisfies ShoutoutSuppressedReason)
      ? "Shoutout abgeschaltet"
      : detail.reason === ("below_threshold" satisfies ShoutoutSuppressedReason)
        ? `Shoutout unter der Schwelle (${detailNumber(detail, "viewers", "unbekannt")} von ${detailNumber(detail, "threshold", "unbekannt")} Zuschauern)`
        : "Shoutout unterdrückt",
    "ads.announcement": (detail) => `Werbepause ${detail.automatic === true ? "automatisch" : "manuell"} startedAt: ${detailNumber(detail, "duration", "unbekannte Dauer")} Sekunden`,
    "ads.skipped": (detail) => `Werbepause übersprungen: ${adsSkipReasonText(detail.reason, "de")}`,
    "ads.prewarning.announced": (detail) => `Vorwarnung: Werbung in ${detailNumber(detail, "sekunden", "unbekannter Zeit")} Sekunden`,
    "ads.prewarning.no_schedule": "Keine nächste Werbepause geplant",
    "ads.prewarning.too_late": "Werbe-Vorwarnung unterdrückt: Termin zu nah",
    "ads.prewarning.break_started": "Werbe-Vorwarnung unterdrückt: Werbepause hat begonnen",
    "ads.prewarning.rescheduled": "Werbe-Vorwarnung unterdrückt: Termin wurde verschoben",
    "ads.prewarning.scope_missing": "Werbe-Vorwarnung unterdrückt: channel:read:ads fehlt",
    "ads.prewarning.schedule_error": (detail) => `Werbezeitplan nicht gelesen: ${eventCauseText("ads.prewarning.schedule_error", detail, "de") ?? "unbekannter Fehler"}`,
    "ads.snooze": (detail) => detail.outcome === "success" ? "Nächste Werbepause verschoben" : `Snooze nicht ausgeführt: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "ads.commercial.failed": (detail) => `Werbeeinblendung nicht gestartet: ${commercialFailureReasonText(detail.reason, "de")}`,
    "text_commands.cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Textbefehl abgekühlt"
        : `Befehl !${name} abgekühlt, noch ${String(detail.remainingSeconds)} s`;
    },
    "text_commands.user_cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Textbefehl durch Nutzer-Abkühlzeit gesperrt"
        : `Befehl !${name} für diesen Nutzer noch ${String(detail.remainingSeconds)} s abgekühlt`;
    },
    "text_commands.stream_state": (detail) => eventTextWithName(detail, "Befehl durch Stream-Zustand unterdrückt", (name) => {
      const allowed = detail.allowed === "online" ? "online" : "offline";
      const current = detail.streamState === "online" ? "online" : "offline";
      return `Befehl !${name} unterdrückt: nur wenn der Stream ${allowed} ist (gerade ${current})`;
    }),
    "text_commands.triggered": (detail) => eventTextWithName(detail, "Befehl ausgeführt", (name) => `Befehl !${name} ausgeführt`),
    "text_commands.disabled": (detail) => eventTextWithName(detail, "Textbefehl ausgeschaltet", (name) => `Textbefehl !${name} ausgeschaltet`),
    "text_commands.permission_denied": (detail) => eventTextWithName(detail, "Textbefehl nicht berechtigt", (name) => `Befehl !${name} nicht ausgelöst: Mindeststufe ${textCommandTier(detail, "requiredTier", "unbekannt", "de")}, vorhanden ${textCommandTier(detail, "currentTier", "kein Chat-Status", "de")}`),
    "text_commands.already_exists": (detail) => eventTextWithName(detail, "Textbefehl bereits vorhanden", (name) => `Textbefehl !${name} bereits vorhanden`),
    "text_commands.not_authorized": "Textbefehl nicht berechtigt",
    "text_commands.unknown": (detail) => eventTextWithName(detail, "Textbefehl unbekannt", (name) => `Textbefehl !${name} unbekannt`),
    "text_commands.invalid": "Textbefehl ungültig",
    "text_commands.lookup_unavailable": (detail) => `Textbefehl !${detailText(detail, "name", "unbekannt")}: ${detail.kind === "uptime" ? "Stream-Daten" : detail.kind === "followage" ? "Followage" : "Spielinformationen"} nicht verfügbar`,
    "text_commands.argument_missing": (detail) => eventTextWithName(detail, "Shoutout-Ziel fehlt", (name) => `Befehl !${name}: Twitch-Name fehlt`),
    "text_commands.argument_invalid": (detail) => eventTextWithName(detail, "Ungültiges Argument", (name) => `Befehl !${name}: Argument muss eine Ganzzahl im erlaubten Bereich sein`),
    "text_commands.changed_concurrently": (detail) => eventTextWithName(detail, "Befehl während Ausführung geändert", (name) => `Befehl !${name} wurde während der Ausführung mehrfach geändert`),
    "text_commands.variable_update_failed": (detail) => eventTextWithName(detail, "Kanalvariable nicht geändert", (name) => `Befehl !${name} konnte die Kanalvariable nicht ändern`),
  },
  en: {
    "host.action.failed": "Action failed",
    "host.action.suppressed": (detail) => `Action suppressed: ${detail.action === "chat" ? "chat message" : detail.action === "announcement" ? "announcement" : "shoutout"} while the channel is muted`,
    "host.chat.failed": "Chat message failed",
    "host.chat.sent": "Chat message sent",
    "host.chat.skipped": "Chat message skipped: schedule changed at the last moment",
    "host.announcement.sent": (detail) => `Chat announcement sent: ${detailText(detail, "text", "no text")}`,
    "host.announcement.failed": (detail) => {
      const reason = eventCauseText("host.announcement.failed", detail, "en") ?? "unknown reason";
      return detail.outcome === "sent_as_message"
        ? `Announcement unavailable (${reason}); sent as a chat message`
        : `Announcement unavailable (${reason}); not sent`;
    },
    "template_truncated": (detail) => `Chat message shortened to 500 characters (originally ${detailNumber(detail, "current", "unknown length")})`,
    "template.lookup_unavailable": (detail) => `Template variable ${detailText(detail, "name", "unknown")} is currently unavailable`,
    "template_parameters_invalid": (detail) => `Invalid variable parameter: ${detailText(detail, "name", "unknown")}`,
    "host.module.error": "Module error",
    "host.module.unknown": "Unknown module",
    "host.overlay.not_executed": "Overlay not executed",
    "host.shoutout.failed": (detail) => {
      if (detail.cause === "twitch_user_not_found") return `Shoutout target ${detailText(detail, "target", "unknown")} was not found`;
      const reason = shoutoutFailureReasonText(detail.cause, "en");
      return reason === null ? "Shoutout failed" : `Shoutout failed: ${reason}`;
    },
    "host.shoutout.sent": "Shoutout sent",
    "host.clip.failed": "Clip failed",
    "channel_events.raid.incoming": (detail) => `Raid from ${detailText(detail, "source", "unknown")} with ${detailNumber(detail, "viewers", "unknown number")} viewers`,
    "channel_events.raid.outgoing": (detail) => `Raid to ${detailText(detail, "target", "unknown")} with ${detailNumber(detail, "viewers", "unknown number")} viewers`,
    "channel_events.shoutout.sent": (detail) => `Shoutout sent to ${detailText(detail, "target", "unknown")}`,
    "channel_events.shoutout.received": (detail) => `Shoutout received from ${detailText(detail, "source", "unknown")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` with ${String(detail.viewers)} viewers` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.resub": (detail) => `Resub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift sub from ${detailText(detail, "gifter", "unknown")} to ${detailText(detail, "recipient", "unknown")}`,
    "channel_events.chat.community_gift": (detail) => `Community gift from ${detailText(detail, "gifter", "unknown")} for ${detailNumber(detail, "count", "unknown number")} subs`,
    "channel_events.chat.announcement": (detail) => `Announcement from ${detailText(detail, "person", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.chat.unknown": (detail) => chatUnknownText(detail, "Unknown chat notification", (art) => `Unknown chat notification: ${art}`),
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unknown")} banned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unknown")} timed out for ${detailDuration(detail, "seconds", "unknown duration")} by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unknown")} removed from timeout by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unknown")} unbanned by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.delete": (detail) => `Message from ${detailText(detail, "person", "unknown")} deleted by ${detailText(detail, "moderator", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unknown")} warned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.unknown": (detail) => `Unknown moderation action: ${detailText(detail, "action", "unknown")}`,
    "channel_events.automod.held": (detail) => `AutoMod held a message from ${detailText(detail, "person", "unknown")}${detailReasonWith(detail, "for")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.suspicious.message": (detail) => `Message from suspicious user ${detailText(detail, "person", "unknown")} (${detailClassification(detail, "unknown classification")}): ${detailText(detail, "text", "no text")}`,
    "channel_events.suspicious.classified": (detail) => `Classification for ${detailText(detail, "person", "unknown")} tightened${detailModeratorEn(detail, "")}: ${detailClassification(detail, "unknown")}`,
    "channel_events.suspicious.cleared": (detail) => `Classification for ${detailText(detail, "person", "unknown")} cleared${detailModeratorEn(detail, "")}`,
    "channel_events.stream.online": (detail) => `Stream started${typeof detail.startedAt === "string" ? `: ${detail.startedAt}` : ""}`,
    "channel_events.stream.offline": "Stream ended",
    "raid.outgoing": (detail) => `Outgoing raid to ${detailText(detail, "targetChannelId", "unknown")}`,
    "raid.shoutout": (detail) => `Raid above threshold (${detailNumber(detail, "viewers", "unknown")} of ${detailNumber(detail, "threshold", "unknown")}): shoutout and chat line`,
    "raid.invalid": (detail) => `Raid discarded: ${raidInvalidReasonText(detail.reason, "en")}`,
    "shoutout.suppressed": (detail) => detail.reason === ("disabled" satisfies ShoutoutSuppressedReason)
      ? "Shoutout disabled"
      : detail.reason === ("below_threshold" satisfies ShoutoutSuppressedReason)
        ? `Shoutout below threshold (${detailNumber(detail, "viewers", "unknown")} of ${detailNumber(detail, "threshold", "unknown")} viewers)`
        : "Shoutout suppressed",
    "ads.announcement": (detail) => `Ad break ${detail.automatic === true ? "automatically" : "manually"} started: ${detailNumber(detail, "duration", "unknown duration")} seconds`,
    "ads.skipped": (detail) => `Ad break skipped: ${adsSkipReasonText(detail.reason, "en")}`,
    "ads.prewarning.announced": (detail) => `Ad warning: ad in ${detailNumber(detail, "sekunden", "unknown time")} seconds`,
    "ads.prewarning.no_schedule": "No next ad break scheduled",
    "ads.prewarning.too_late": "Ad warning suppressed: ad is too close",
    "ads.prewarning.break_started": "Ad warning suppressed: ad break has started",
    "ads.prewarning.rescheduled": "Ad warning suppressed: schedule changed",
    "ads.prewarning.scope_missing": "Ad warning suppressed: channel:read:ads is missing",
    "ads.prewarning.schedule_error": (detail) => `Ad schedule could not be read: ${eventCauseText("ads.prewarning.schedule_error", detail, "en") ?? "unknown error"}`,
    "ads.snooze": (detail) => detail.outcome === "success" ? "Next ad break postponed" : `Snooze not executed: ${detailText(detail, "reason", "unknown error")}`,
    "ads.commercial.failed": (detail) => `Commercial not started: ${commercialFailureReasonText(detail.reason, "en")}`,
    "text_commands.cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Text command on cooldown"
        : `Command !${name} on cooldown, ${String(detail.remainingSeconds)}s left`;
    },
    "text_commands.user_cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Text command is on the per-user cooldown"
        : `Command !${name} is on this user's cooldown for ${String(detail.remainingSeconds)}s`;
    },
    "text_commands.stream_state": (detail) => eventTextWithName(detail, "Command suppressed by stream state", (name) => {
      const allowed = detail.allowed === "online" ? "online" : "offline";
      const current = detail.streamState === "online" ? "online" : "offline";
      return `Command !${name} suppressed: only when the stream is ${allowed} (currently ${current})`;
    }),
    "text_commands.triggered": (detail) => eventTextWithName(detail, "Command executed", (name) => `Command !${name} executed`),
    "text_commands.disabled": (detail) => eventTextWithName(detail, "Text command disabled", (name) => `Text command !${name} disabled`),
    "text_commands.permission_denied": (detail) => eventTextWithName(detail, "Text command not authorized", (name) => `Command !${name} not executed: minimum level ${textCommandTier(detail, "requiredTier", "unknown", "en")}, present ${textCommandTier(detail, "currentTier", "no chat status", "en")}`),
    "text_commands.already_exists": (detail) => eventTextWithName(detail, "Text command already exists", (name) => `Text command !${name} already exists`),
    "text_commands.not_authorized": "Text command not authorized",
    "text_commands.unknown": (detail) => eventTextWithName(detail, "Unknown text command", (name) => `Unknown text command !${name}`),
    "text_commands.invalid": "Invalid text command",
    "text_commands.lookup_unavailable": (detail) => `Command !${detailText(detail, "name", "unknown")}: ${detail.kind === "uptime" ? "stream data" : detail.kind === "followage" ? "followage" : "game information"} unavailable`,
    "text_commands.argument_missing": (detail) => eventTextWithName(detail, "Shoutout target missing", (name) => `Command !${name}: Twitch login missing`),
    "text_commands.argument_invalid": (detail) => eventTextWithName(detail, "Invalid argument", (name) => `Command !${name}: argument must be an integer in the allowed range`),
    "text_commands.changed_concurrently": (detail) => eventTextWithName(detail, "Command changed during execution", (name) => `Command !${name} changed repeatedly during execution`),
    "text_commands.variable_update_failed": (detail) => eventTextWithName(detail, "Channel variable not changed", (name) => `Command !${name} could not change the channel variable`),
  },
};

export type EventFamily = "community" | "raid" | "moderation" | "operations";
export type EventTier = "full" | "outlined";
export type EventNumberKey = "viewers" | "count" | "duration" | "remainingSeconds" | "tier" | null;
export interface EventToneEntry {
  family: EventFamily;
  tier: EventTier;
  word: LocaleCatalog<string>;
  numberKey: EventNumberKey;
  tone?: EventTone;
}

export const eventToneEntries: Record<EventCode, EventToneEntry> = {
  "host.action.failed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.action.suppressed": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "host.chat.failed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.chat.sent": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "host.chat.skipped": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "host.announcement.failed": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "host.announcement.sent": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "template_truncated": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "template.lookup_unavailable": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "template_parameters_invalid": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "host.module.error": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.module.unknown": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "host.overlay.not_executed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.shoutout.failed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.shoutout.sent": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "channel_events.raid.incoming": { family: "raid", tier: "full", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "channel_events.raid.outgoing": { family: "raid", tier: "outlined", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "channel_events.shoutout.sent": { family: "raid", tier: "outlined", word: { de: "Shoutout", en: "Shoutout" }, numberKey: null },
  "channel_events.shoutout.received": { family: "raid", tier: "full", word: { de: "Shoutout", en: "Shoutout" }, numberKey: "viewers" },
  "channel_events.chat.sub": { family: "community", tier: "full", word: { de: "Abo", en: "Sub" }, numberKey: "tier" },
  "channel_events.chat.resub": { family: "community", tier: "full", word: { de: "Resub", en: "Resub" }, numberKey: "tier" },
  "channel_events.chat.gift_sub": { family: "community", tier: "full", word: { de: "Gift-Sub", en: "Gift Sub" }, numberKey: "tier" },
  "channel_events.chat.community_gift": { family: "community", tier: "full", word: { de: "Gift", en: "Gift" }, numberKey: "count" },
  "channel_events.chat.announcement": { family: "community", tier: "outlined", word: { de: "Ankündigung", en: "Announcement" }, numberKey: null },
  "channel_events.chat.unknown": { family: "community", tier: "full", word: { de: "Unbekannt", en: "Unknown" }, numberKey: null },
  "channel_events.moderation.ban": { family: "moderation", tier: "full", word: { de: "Bann", en: "Ban" }, numberKey: null },
  "channel_events.moderation.timeout": { family: "moderation", tier: "full", word: { de: "Auszeit", en: "Timeout" }, numberKey: "duration" },
  "channel_events.moderation.untimeout": { family: "moderation", tier: "outlined", word: { de: "Entsperrt", en: "Untimeout" }, numberKey: null },
  "channel_events.moderation.unban": { family: "moderation", tier: "outlined", word: { de: "Entbannt", en: "Unbanned" }, numberKey: null },
  "channel_events.moderation.delete": { family: "moderation", tier: "full", word: { de: "Gelöscht", en: "Deleted" }, numberKey: null },
  "channel_events.moderation.warn": { family: "moderation", tier: "full", word: { de: "Verwarnung", en: "Warning" }, numberKey: null },
  "channel_events.moderation.unknown": { family: "moderation", tier: "full", word: { de: "Unbekannt", en: "Unknown" }, numberKey: null },
  "channel_events.automod.held": { family: "moderation", tier: "full", word: { de: "AutoMod", en: "AutoMod" }, numberKey: null },
  "channel_events.suspicious.message": { family: "moderation", tier: "full", word: { de: "Verdacht", en: "Suspicious" }, numberKey: null },
  "channel_events.suspicious.classified": { family: "moderation", tier: "full", word: { de: "Einstufung", en: "Classified" }, numberKey: null },
  "channel_events.suspicious.cleared": { family: "moderation", tier: "outlined", word: { de: "Entwarnt", en: "Cleared" }, numberKey: null },
  "channel_events.stream.offline": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "channel_events.stream.online": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "raid.outgoing": { family: "raid", tier: "outlined", word: { de: "Raid", en: "Raid" }, numberKey: "viewers", tone: "warning" },
  "raid.shoutout": { family: "raid", tier: "full", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "raid.invalid": { family: "raid", tier: "outlined", word: { de: "Raid", en: "Raid" }, numberKey: null, tone: "warning" },
  "shoutout.suppressed": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.announcement": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: "duration", tone: "info" },
  "ads.skipped": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.announced": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "ads.prewarning.no_schedule": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.too_late": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.break_started": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.rescheduled": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.scope_missing": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.schedule_error": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "ads.snooze": { family: "operations", tier: "outlined", word: { de: "Snooze", en: "Snooze" }, numberKey: null, tone: "info" },
  "ads.commercial.failed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.clip.failed": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "text_commands.cooldown": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: "remainingSeconds", tone: "warning" },
  "text_commands.user_cooldown": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: "remainingSeconds", tone: "info" },
  "text_commands.stream_state": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.triggered": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.disabled": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.permission_denied": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.already_exists": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.not_authorized": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.unknown": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.invalid": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.lookup_unavailable": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "text_commands.argument_missing": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.argument_invalid": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.changed_concurrently": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.variable_update_failed": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
};

export function eventText(code: string, language?: DashboardLanguage): string;
export function eventText(code: string, detail: EventDetail, language?: DashboardLanguage): string;
export function eventText(
  code: string,
  detailOrLanguage: EventDetail | DashboardLanguage = {},
  language?: DashboardLanguage,
): string {
  const detail = typeof detailOrLanguage === "string" ? {} : detailOrLanguage;
  const resolvedLanguage = typeof detailOrLanguage === "string"
    ? detailOrLanguage
    : language ?? dashboardLanguage();
  if (Object.prototype.hasOwnProperty.call(eventTexts[resolvedLanguage], code)) {
    const text = eventTexts[resolvedLanguage][code as EventCode];
    if (typeof text === "function") return text(detail);
    if (typeof text === "string") return text;
  }
  return code;
}

const auditActionTexts: LocaleCatalog<Record<AuditAction, string>> = {
  de: {
    "channel.released": "Kanal freigegeben",
    "channel.full_consent_changed": "Vollzustimmung geändert",
    "member.added": "Mitglied hinzugefügt",
    "member.role_changed": "Mitgliedsrolle geändert",
    "member.removed": "Mitglied entfernt",
    "module.enabled": "Modul aktiviert",
    "module.disabled": "Modul deaktiviert",
    "text_commands.command.created": "Textbefehl erstellt",
    "text_commands.command.updated": "Textbefehl aktualisiert",
    "text_commands.command.removed": "Textbefehl entfernt",
    "channel.variable.created": "Kanalvariable erstellt",
    "channel.variable.renamed": "Kanalvariable geändert",
    "channel.variable.removed": "Kanalvariable gelöscht",
    "channel.variable.value_changed": "Kanalvariablenwert geändert",
    "ads.commercial_started": "Werbung gestartet",
    "clip.created": "Clip erstellt",
    "channel.mute.enabled": "Kanal stummgeschaltet",
    "channel.mute.disabled": "Kanal-Stummschaltung aufgehoben",
    "channel.pause.enabled": "Automatische Aktionen pausiert",
    "channel.pause.disabled": "Automatische Aktionen fortgesetzt",
    "overlay.token.issued": "Overlay-Token ausgestellt",
    "overlay.token.revoked": "Overlay-Token widerrufen",
    "overlay.access.issued": "Overlay-Zugang ausgestellt",
    "overlay.access.revealed": "Overlay-Zugang angezeigt",
    "overlay.access.revoked": "Overlay-Zugang widerrufen",
    "overlay.created": "Overlay erstellt",
    "overlay.updated": "Overlay geändert",
    "overlay.deleted": "Overlay gelöscht",
    "overlay.legacy.imported": "Alter Overlay-Link importiert",
  },
  en: {
    "channel.released": "Channel released",
    "channel.full_consent_changed": "Full consent changed",
    "member.added": "Member added",
    "member.role_changed": "Member role changed",
    "member.removed": "Member removed",
    "module.enabled": "Module enabled",
    "module.disabled": "Module disabled",
    "text_commands.command.created": "Text command created",
    "text_commands.command.updated": "Text command updated",
    "text_commands.command.removed": "Text command removed",
    "channel.variable.created": "Channel variable created",
    "channel.variable.renamed": "Channel variable changed",
    "channel.variable.removed": "Channel variable deleted",
    "channel.variable.value_changed": "Channel variable value changed",
    "ads.commercial_started": "Commercial started",
    "clip.created": "Clip created",
    "channel.mute.enabled": "Channel muted",
    "channel.mute.disabled": "Channel unmuted",
    "channel.pause.enabled": "Automatic actions paused",
    "channel.pause.disabled": "Automatic actions resumed",
    "overlay.token.issued": "Overlay token issued",
    "overlay.token.revoked": "Overlay token revoked",
    "overlay.access.issued": "Overlay access issued",
    "overlay.access.revealed": "Overlay access revealed",
    "overlay.access.revoked": "Overlay access revoked",
    "overlay.created": "Overlay created",
    "overlay.updated": "Overlay updated",
    "overlay.deleted": "Overlay deleted",
    "overlay.legacy.imported": "Legacy overlay link imported",
  },
};

interface ModuleAuditTexts {
  settingsChanged: (name: string) => string;
}

const moduleAuditTexts: LocaleCatalog<ModuleAuditTexts> = {
  de: { settingsChanged: (name) => `Einstellungen geändert: ${name}` },
  en: { settingsChanged: (name) => `Settings changed: ${name}` },
};

export const moduleSettingsChangedText = (
  name: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => moduleAuditTexts[language].settingsChanged(name);

export const auditActionLabel = (
  action: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => catalogString(auditActionTexts[language], action) ?? action;

const memberAsWords: LocaleCatalog<string> = { de: "als", en: "as" };

/** The connector between a member's login and their role in an audit row's subject, e.g. "beispielnutzer als Bediener" (#181). */
export const memberAsWord = (language: DashboardLanguage = dashboardLanguage()): string => memberAsWords[language];

/**
 * Fallback labels for the handful of common audit diff field keys that
 * aren't a module's own settings (member role, channel consent, overlay
 * token lifecycle, ...). Anything not listed here falls back to its raw
 * key, per #181's explicit allowance -- this stays a short, curated list,
 * not an attempt at completeness.
 */
const auditFieldLabels: LocaleCatalog<Record<string, string>> = {
  de: {
    role: "Rolle", enabled: "Aktiv", fullConsent: "Vollzustimmung", revocationReason: "Widerrufsgrund",
    expiresAt: "Gültig bis", createdAt: "Erstellt am", revokedAt: "Widerrufen am", length: "Länge (Sekunden)", retryAfter: "Erneut möglich ab",
    clipId: "Clip-ID", tokenId: "Token-ID", login: "Login", displayName: "Anzeigename",
    name: "Name", value: "Wert", description: "Beschreibung", overlayId: "Overlay-ID",
    width: "Breite", height: "Höhe", revision: "Revision", elementCount: "Elemente",
  },
  en: {
    role: "Role", enabled: "Enabled", fullConsent: "Full consent", revocationReason: "Revocation reason",
    expiresAt: "Valid until", createdAt: "Created at", revokedAt: "Revoked at", length: "Length (seconds)", retryAfter: "Retry after",
    clipId: "Clip ID", tokenId: "Token ID", login: "Login", displayName: "Display name",
    name: "Name", value: "Value", description: "Description", overlayId: "Overlay ID",
    width: "Width", height: "Height", revision: "Revision", elementCount: "Elements",
  },
};

export const auditFieldLabel = (
  key: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => catalogString(auditFieldLabels[language], key) ?? key;

/**
 * DE/EN text for every `ApiErrorCode` the worker (or the dashboard's own
 * request guard) can send back as `{ "error": "<code>" }`. `Record<ApiErrorCode,
 * string>` per language, the same reasoning as `eventTexts`: adding a code in
 * `contracts/values.ts` without a matching entry here fails the build.
 */
export const apiErrorTexts: LocaleCatalog<Record<ApiErrorCode, string>> = {
  de: {
    session_missing: "Sitzung fehlt.",
    websocket_origin_invalid: "Die WebSocket-Anfrage stammt nicht von dieser Website.",
    realtime_protocol_unsupported: "Das Echtzeitprotokoll wird nicht unterstützt.",
    csrf_invalid: "CSRF-Token fehlt oder ist ungültig.",
    channel_missing: "Kanal fehlt.",
    channel_access_denied: "Kanalzugriff verweigert.",
    platform_access_denied: "Kein Betreiberzugang.",
    panel_request_not_allowed: "Die Panel-Anfrage ist nicht erlaubt.",
    pagination_limit_invalid: "Die Begrenzung ist ungültig.",
    pagination_cursor_invalid: "Der Cursor ist ungültig.",
    twitch_login_invalid: "Twitch-Name fehlt oder ist ungültig.",
    twitch_user_not_found: "Twitch-Nutzer nicht gefunden.",
    twitch_user_search_failed: "Twitch-Nutzersuche ist fehlgeschlagen.",
    channel_not_found: "Kanal nicht gefunden.",
    broadcaster_role_immutable: "Die Rolle Broadcaster darf auf der Betreiberebene nicht geändert werden.",
    broadcaster_role_change_requires_broadcaster: "Nur ein Broadcaster darf die Rolle Broadcaster vergeben oder entziehen.",
    mutation_failed: "Die Änderung konnte nicht durchgeführt werden.",
    member_changed_concurrently: "Mitglied wurde inzwischen geändert.",
    release_input_invalid: "Login oder Vollzustimmung ist ungültig.",
    channel_already_released: "Der Kanal ist bereits freigegeben.",
    channel_release_failed: "Der Kanal konnte nicht freigegeben werden.",
    full_consent_invalid: "Vollzustimmung ist ungültig.",
    full_consent_already_set: "Diese Vollzustimmung ist bereits gesetzt.",
    member_or_role_invalid: "Mitglied oder Rolle ist ungültig.",
    member_already_exists: "Dieses Mitglied ist bereits freigegeben.",
    member_management_denied: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.",
    self_membership_denied: "Du kannst deine eigene Mitgliedschaft nicht per POST anlegen.",
    member_add_failed: "Mitglied konnte nicht hinzugefügt werden.",
    role_invalid: "Rolle ist ungültig.",
    member_not_found: "Mitglied nicht gefunden.",
    role_already_set: "Diese Rolle ist bereits gesetzt.",
    self_role_escalation_denied: "Du kannst deine eigene Rolle nicht erhöhen.",
    last_broadcaster_cannot_be_demoted: "Der letzte Broadcaster kann nicht herabgestuft werden.",
    last_broadcaster_cannot_be_removed: "Der letzte Broadcaster kann nicht entfernt werden.",
    event_origin_invalid: "Ereignis-Herkunft ist ungültig.",
    event_tone_invalid: "Ereignis-Ton ist ungültig.",
    audit_area_invalid: "Audit-Bereich ist ungültig.",
    moderator_status_check_denied: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
    moderator_status_check_rate_limited: "Der Moderatorstatus wurde für diesen Kanal kürzlich geprüft.",
    moderator_status_check_failed: "Moderatorstatus konnte nicht gelesen werden.",
    module_management_denied: "Nur Broadcaster und Verwalter dürfen Module ändern.",
    module_unknown: "Unbekanntes Modul.",
    module_not_configured: "Modul ist in diesem Kanal nicht eingerichtet.",
    module_disabled: "Modul ist in diesem Kanal nicht aktiv.",
    module_settings_invalid: "Moduleinstellungen sind ungültig.",
    module_settings_changed_concurrently: "Moduleinstellungen wurden inzwischen geändert.",
    module_enabled_field_invalid: "Feld enabled ist ungültig.",
    module_mandatory: "Kanalereignisse sind immer aktiv.",
    module_changed_concurrently: "Modul wurde inzwischen geändert.",
    command_management_denied: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, ändern oder löschen.",
    command_data_invalid: "Befehlsdaten sind ungültig.",
    command_already_exists: "Der Befehl existiert bereits.",
    command_alias_conflict: "Name oder Alias wird bereits von einem anderen Befehl verwendet.",
    command_creation_denied: "Der Befehl darf nicht angelegt werden.",
    command_not_found: "Der Befehl wurde nicht gefunden.",
    command_update_denied: "Der Befehl darf nicht geändert werden.",
    command_changed_concurrently: "Der Befehl wurde inzwischen geändert.",
    command_delete_denied: "Der Befehl darf nicht gelöscht werden.",
    variable_data_invalid: "Die Variablendaten sind ungültig.",
    variable_not_found: "Die Kanalvariable wurde nicht gefunden.",
    variable_already_exists: "Eine Variable mit diesem Namen gibt es bereits.",
    variable_limit_reached: "Der Kanal hat bereits 50 Variablen.",
    variable_in_use: "Eine Textbefehlsaktion verwendet diese Variable.",
    variable_changed_concurrently: "Die Kanalvariable wurde inzwischen geändert.",
    variable_management_denied: "Nur Broadcaster und Verwalter dürfen Variablen anlegen, umbenennen oder löschen.",
    variable_value_change_denied: "Du darfst den Variablenwert nicht ändern.",
    ad_schedule_read_failed: "Der Werbezeitplan konnte nicht gelesen werden.",
    ad_snooze_failed: "Die nächste Werbepause konnte nicht verschoben werden.",
    commercial_length_invalid: "Die Werbedauer ist ungültig.",
    commercial_start_failed: "Die Werbeeinblendung konnte nicht gestartet werden.",
    commercial_stream_offline: "Die Werbeeinblendung ist offline nicht verfügbar.",
    clip_create_failed: "Der Clip konnte nicht erstellt werden.",
    clip_stream_offline: "Ein Clip kann nur erstellt werden, wenn der Stream live ist.",
    channel_control_input_invalid: "Die Kanalsteuerung ist ungültig.",
    channel_control_changed_concurrently: "Die Kanalsteuerung wurde inzwischen geändert.",
    shoutout_send_failed: "Der Shoutout konnte nicht gesendet werden.",
    overlay_token_manage_denied: "Nur Broadcaster und Verwalter dürfen Overlay-Token verwalten.",
    overlay_expiry_invalid: "Ablaufzeit ist ungültig.",
    overlay_revocation_reason_invalid: "Widerrufsgrund fehlt oder ist ungültig.",
    overlay_token_not_found: "Overlay-Token nicht gefunden.",
    overlay_token_invalid: "Overlay-Zugang ungültig.",
    overlay_variable_not_found: "Die Kanalvariable wurde nicht gefunden.",
    overlay_management_denied: "Nur Broadcaster und Verwalter dürfen Overlays ändern.",
    overlay_css_invalid: "Overlay-CSS darf keine Stylesheets importieren und nur relative Asset-URLs verwenden.",
    overlay_data_invalid: "Overlay-Daten sind ungültig.",
    overlay_not_found: "Overlay nicht gefunden.",
    overlay_token_already_bound: "Dieser Overlay-Link ist bereits an ein Overlay gebunden.",
    overlay_limit_reached: "Ein Kanal kann höchstens 20 Overlays haben.",
    overlay_element_limit_reached: "Ein Overlay kann höchstens 20 Elemente haben.",
    overlay_changed_concurrently: "Overlay wurde inzwischen geändert.",
    unknown_api_route: "Unbekannte API-Route.",
  },
  en: {
    session_missing: "Session missing.",
    websocket_origin_invalid: "The WebSocket request did not come from this website.",
    realtime_protocol_unsupported: "The realtime protocol is not supported.",
    csrf_invalid: "CSRF token missing or invalid.",
    channel_missing: "Channel missing.",
    channel_access_denied: "Channel access denied.",
    platform_access_denied: "No operator access.",
    panel_request_not_allowed: "This panel request is not allowed.",
    pagination_limit_invalid: "The limit is invalid.",
    pagination_cursor_invalid: "The cursor is invalid.",
    twitch_login_invalid: "Twitch name missing or invalid.",
    twitch_user_not_found: "Twitch user not found.",
    twitch_user_search_failed: "Twitch user search failed.",
    channel_not_found: "Channel not found.",
    broadcaster_role_immutable: "The broadcaster role cannot be changed at the operator level.",
    broadcaster_role_change_requires_broadcaster: "Only a broadcaster can grant or revoke the broadcaster role.",
    mutation_failed: "The change could not be made.",
    member_changed_concurrently: "The member has since changed.",
    release_input_invalid: "Login or full consent is invalid.",
    channel_already_released: "The channel is already released.",
    channel_release_failed: "The channel could not be released.",
    full_consent_invalid: "Full consent is invalid.",
    full_consent_already_set: "This full consent is already set.",
    member_or_role_invalid: "Member or role is invalid.",
    member_already_exists: "This member is already added.",
    member_management_denied: "Only broadcasters and managers may change members.",
    self_membership_denied: "You cannot add your own membership by POST.",
    member_add_failed: "The member could not be added.",
    role_invalid: "Role is invalid.",
    member_not_found: "Member not found.",
    role_already_set: "This role is already set.",
    self_role_escalation_denied: "You cannot raise your own role.",
    last_broadcaster_cannot_be_demoted: "The last broadcaster cannot be demoted.",
    last_broadcaster_cannot_be_removed: "The last broadcaster cannot be removed.",
    event_origin_invalid: "Event origin is invalid.",
    event_tone_invalid: "Event tone is invalid.",
    audit_area_invalid: "Audit area is invalid.",
    moderator_status_check_denied: "Only broadcasters and managers may check the moderator status.",
    moderator_status_check_rate_limited: "The moderator status for this channel was checked recently.",
    moderator_status_check_failed: "The moderator status could not be read.",
    module_management_denied: "Only broadcasters and managers may change modules.",
    module_unknown: "Unknown module.",
    module_not_configured: "This module is not set up for this channel.",
    module_disabled: "This module is not active for this channel.",
    module_settings_invalid: "The module settings are invalid.",
    module_settings_changed_concurrently: "The module settings have since changed.",
    module_enabled_field_invalid: "The enabled field is invalid.",
    module_mandatory: "Channel events are always active.",
    module_changed_concurrently: "The module has since changed.",
    command_management_denied: "Only broadcasters and managers may create, change, or remove commands.",
    command_data_invalid: "Command data is invalid.",
    command_already_exists: "This command already exists.",
    command_alias_conflict: "The name or alias is already used by another command.",
    command_creation_denied: "This command may not be created.",
    command_not_found: "This command was not found.",
    command_update_denied: "This command may not be changed.",
    command_changed_concurrently: "This command has since changed.",
    command_delete_denied: "This command may not be removed.",
    variable_data_invalid: "The variable data is invalid.",
    variable_not_found: "The channel variable was not found.",
    variable_already_exists: "A variable with this name already exists.",
    variable_limit_reached: "This channel already has 50 variables.",
    variable_in_use: "A text command action uses this variable.",
    variable_changed_concurrently: "The channel variable has since changed.",
    variable_management_denied: "Only broadcasters and managers may create, rename, or delete variables.",
    variable_value_change_denied: "You may not change the variable value.",
    ad_schedule_read_failed: "The ad schedule could not be read.",
    ad_snooze_failed: "The next ad break could not be postponed.",
    commercial_length_invalid: "The commercial length is invalid.",
    commercial_start_failed: "The commercial could not be started.",
    commercial_stream_offline: "A commercial cannot run while the stream is offline.",
    clip_create_failed: "The clip could not be created.",
    clip_stream_offline: "A clip can only be created while the stream is live.",
    channel_control_input_invalid: "The channel control is invalid.",
    channel_control_changed_concurrently: "The channel control has changed since it was loaded.",
    shoutout_send_failed: "The shoutout could not be sent.",
    overlay_token_manage_denied: "Only broadcasters and managers may manage overlay tokens.",
    overlay_expiry_invalid: "Expiry is invalid.",
    overlay_revocation_reason_invalid: "Revocation reason missing or invalid.",
    overlay_token_not_found: "Overlay token not found.",
    overlay_token_invalid: "Overlay access invalid.",
    overlay_variable_not_found: "The channel variable was not found.",
    overlay_management_denied: "Only broadcasters and managers may change overlays.",
    overlay_css_invalid: "Overlay CSS cannot import stylesheets and may use only relative asset URLs.",
    overlay_data_invalid: "Overlay data is invalid.",
    overlay_not_found: "Overlay not found.",
    overlay_token_already_bound: "This overlay link is already bound to an overlay.",
    overlay_limit_reached: "A channel can have at most 20 overlays.",
    overlay_element_limit_reached: "An overlay can have at most 20 elements.",
    overlay_changed_concurrently: "The overlay has changed since it was loaded.",
    unknown_api_route: "Unknown API route.",
  },
};

/**
 * Looks a server error code up in `apiErrorTexts`. Falls back to the
 * caller's own generic text -- never to raw server text -- for a code an
 * old worker, a proxy's HTML error page, or a network failure didn't give
 * us, or gave us one this build doesn't know.
 */
export const apiErrorText = (
  code: string | null,
  fallback: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const catalog: Record<string, string> = apiErrorTexts[language];
  return (code === null ? undefined : catalogString(catalog, code)) ?? fallback;
};

/**
 * DE/EN text for the known-closed subset of `reason` codes written to
 * `bot_identity_status`/`twitch_login_identity`/`eventsub_subscriptions` by
 * `bot-maintenance.ts`/`login-maintenance.ts`/`eventsub-subscriptions.ts`.
 * Unlike `apiErrorTexts`, this isn't a closed union: Twitch's own error
 * body can pass its own code straight through (`error.code ?? fallbackCode`
 * in `bot-maintenance.ts`'s `maintenanceErrorDetails`), so an unrecognized
 * code falls back to showing itself -- it's already an English identifier,
 * never German prose, so that's safe.
 */
const maintenanceReasonTexts: LocaleCatalog<Record<string, string>> = {
  de: {
    timeout: "Zeitüberschreitung",
    network_error: "Netzwerkfehler",
    invalid_response: "Ungültige Antwort",
    invalid_target: "Unbekanntes Ziel",
    pagination_loop: "Wiederholte Seitenblätterung",
    maintenance_failed: "Wartung fehlgeschlagen",
    moderator_status_failed: "Moderatorstatus-Prüfung fehlgeschlagen",
    channel_or_consent_missing: "Kanal oder Zustimmung fehlt",
    token_ciphertext_unreadable: "Token nicht lesbar",
  },
  en: {
    timeout: "Timeout",
    network_error: "Network error",
    invalid_response: "Invalid response",
    invalid_target: "Unknown target",
    pagination_loop: "Repeated pagination",
    maintenance_failed: "Maintenance failed",
    moderator_status_failed: "Moderator status check failed",
    channel_or_consent_missing: "Channel or consent missing",
    token_ciphertext_unreadable: "Token unreadable",
  },
};

const eventSubNeutralReasonTexts: LocaleCatalog<Record<EventSubNeutralReasonCode, string>> = {
  de: {
    moderator_required: "Wartet auf Moderatorstatus des Bots",
    pending_adoption: "Wird übernommen",
  },
  en: {
    moderator_required: "Waiting for the bot's moderator status",
    pending_adoption: "Being adopted",
  },
};

const isEventSubNeutralReasonCode = (code: string): code is EventSubNeutralReasonCode =>
  (EVENTSUB_NEUTRAL_REASON_CODES as readonly string[]).includes(code);

export const maintenanceReasonText = (
  code: string | null | undefined,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  if (code === null || code === undefined) return null;
  if (isEventSubNeutralReasonCode(code)) {
    return catalogString(eventSubNeutralReasonTexts[language], code) ?? code;
  }
  const catalog: Record<string, string> = maintenanceReasonTexts[language];
  return catalogString(catalog, code) ?? code;
};

export const dashboardTexts = (): DashboardTexts => dashboardTextsCatalog[dashboardLanguage()];

export const immediateActionUnavailableReasonText = (
  reason: ImmediateActionUnavailableReason,
  language: DashboardLanguage = dashboardLanguage(),
): string => dashboardTextsCatalog[language].streamManager.availabilityReasons[reason];

export const formatDashboardDate = (
  value: string,
  options: Intl.DateTimeFormatOptions,
): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(dashboardLanguage(), options).format(date);
};

export const formatDate = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium" });

export const formatTimestamp = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium", timeStyle: "short" });

export const formatClockTime = (value: string): string =>
  formatDashboardDate(value, { hour: "2-digit", minute: "2-digit" });

const localDayKey = (date: Date): string =>
  `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const formatStreamManagerFeedTime = (value: string, now = new Date()): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = formatClockTime(value);
  if (localDayKey(date) === localDayKey(now)) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDayKey(date) === localDayKey(yesterday)) return `${dashboardTexts().streamManager.yesterday} ${time}`;
  return `${formatDate(value)} ${time}`;
};

export const formatNumber = (value: number): string =>
  new Intl.NumberFormat(dashboardLanguage()).format(value);
