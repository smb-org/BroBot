import { ADS_SKIPPED_REASONS, COMMERCIAL_FAILURE_REASONS, EVENTSUB_NEUTRAL_REASON_CODES, RAID_INVALID_REASONS, SHOUTOUT_FAILURE_REASONS, type AdsSkippedReason, type ApiErrorCode, type AuditAction, type AuditArea, type ChannelRole, type CommercialFailureReason, type EventCode, type EventSubNeutralReasonCode, type EventTone, type ImmediateActionUnavailableReason, type ModerationFailureReason, type RaidInvalidReason, type ShoutoutFailureReason, type ShoutoutSuppressedReason } from "../contracts/values";
import { browserModuleLanguage, type ModuleChatCommandThreshold, type ModuleChatStatus, type ModuleLanguage, type ModuleNavigationCategory } from "../modules/contract";
import type { ApiSourceFailureReason } from "../modules/api_source/contracts";
import type { SystemVariableName } from "../template-variables";
import type { GameMultiSelectMessages } from "./ui/GameMultiSelect";

export type DashboardLanguage = ModuleLanguage;
export type LocaleCatalog<T> = Record<DashboardLanguage, T>;

export interface AuditSentenceParts {
  actor: string;
  object: string;
  from: string | null;
  to: string | null;
  outcome?: string | null;
}

export const catalogString = (catalog: object, key: string): string | undefined => {
  if (!Object.hasOwn(catalog, key)) return undefined;
  const value = (catalog as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

export interface DashboardCommonTexts {
  cancel: string;
  close: string;
  clearSearch: string;
  noValue: string;
  noMatches: string;
  activeFilters: string;
  of: string;
  reset: string;
  retry: string;
  loaded: string;
  dismissNotification: string;
  invalidFieldCount: (count: number) => string;
  invalidFieldsTitle: string;
  showInvalidFields: string;
  hideInvalidFields: string;
  save: string;
  /** `EditorShell.discardLabel` -- reverts an editor draft to its last saved value. */
  discard: string;
  /** `EditorShell.savedLabel` -- the clean-after-save status text. */
  saved: string;
  /** `EditorShell.pendingLabel` -- the in-flight status text. */
  saving: string;
  /** `EditorShell.issueLabels` -- appended to a tab's accessible name. */
  error: string;
  warning: string;
  moreActions: string;
  activeModule: string;
  pausedModule: string;
  chooseCollection: string;
  editSelection: string;
  noCollectionEntries: string;
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
    clearSearch: "Suche leeren",
    noValue: "kein Wert",
    noMatches: "Keine passenden Einträge gefunden.",
    activeFilters: "Aktive Filter:",
    of: "von",
    reset: "Zurücksetzen",
    retry: "Erneut versuchen",
    loaded: "geladen",
    dismissNotification: "Benachrichtigung schließen",
    invalidFieldCount: (count) => `${String(count)} ${count === 1 ? "Feld" : "Felder"} fehlerhaft`,
    invalidFieldsTitle: "Fehlerhafte Felder",
    showInvalidFields: "Fehlerhafte Felder anzeigen",
    hideInvalidFields: "Fehlerhafte Felder verbergen",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert.",
    saving: "Wird gespeichert …",
    error: "Fehler",
    warning: "Hinweis",
    moreActions: "Weitere Aktionen",
    activeModule: "Aktiv",
    pausedModule: "Pausiert",
    chooseCollection: "Eintrag auswählen",
    editSelection: "Eintrag bearbeiten",
    noCollectionEntries: "Noch keine Einträge vorhanden.",
    immediate: "wirkt sofort",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Verwalter",
      operator: "Bediener",
    },
    roleDescriptions: {
      broadcaster: "Vergibt und entzieht auch die Broadcaster-Rolle.",
      manager: "Verwaltet Mitglieder, Module und Moduleinstellungen.",
      operator: "Sieht alles; darf Abstimmungen, Shoutouts, Clips und Votekicks bedienen, aber keine Werbung starten oder verschieben.",
    },
  },
  en: {
    cancel: "Cancel",
    close: "Close",
    clearSearch: "Clear search",
    noValue: "no value",
    noMatches: "No matching entries found.",
    activeFilters: "Active filters:",
    of: "of",
    reset: "Reset",
    retry: "Retry",
    loaded: "loaded",
    dismissNotification: "Dismiss notification",
    invalidFieldCount: (count) => `${String(count)} invalid ${count === 1 ? "field" : "fields"}`,
    invalidFieldsTitle: "Invalid fields",
    showInvalidFields: "Show invalid fields",
    hideInvalidFields: "Hide invalid fields",
    save: "Save",
    discard: "Discard",
    saved: "Saved.",
    saving: "Saving …",
    error: "Error",
    warning: "Notice",
    moreActions: "More actions",
    activeModule: "Active",
    pausedModule: "Paused",
    chooseCollection: "Select an entry",
    editSelection: "Edit entry",
    noCollectionEntries: "No entries yet.",
    immediate: "takes effect immediately",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Manager",
      operator: "Operator",
    },
    roleDescriptions: {
      broadcaster: "Also grants and revokes the broadcaster role.",
      manager: "Manages members, modules, and module settings.",
      operator: "Sees everything; can run votes, shoutouts, clips, and votekicks, but cannot start or snooze ads.",
    },
  },
};

/**
 * The panel's language, derived from the browser (decision 0007).
 * This is the only place that determines it — a later, deliberate
 * per-user language choice only replaces this function.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const dashboardCommonTexts = (language: DashboardLanguage = dashboardLanguage()): DashboardCommonTexts => commonTexts[language];

type ServerFieldErrorReasonCode =
  | "settings_payload_invalid"
  | "settings_revision_invalid"
  | "settings_invalid"
  | "invalid_type"
  | "too_small"
  | "too_big"
  | "invalid_enum_value"
  | "invalid_value"
  | "invalid_literal"
  | "invalid_string"
  | "invalid_format"
  | "not_multiple_of"
  | "unrecognized_keys"
  | "invalid_union"
  | "invalid_key"
  | "invalid_element"
  | "custom"
  | "template_text_invalid";

const serverFieldErrorCatalog: LocaleCatalog<Record<ServerFieldErrorReasonCode, string>> = {
  de: {
    settings_payload_invalid: "Die Einstellungsdaten sind ungültig.",
    settings_revision_invalid: "Der Einstellungsstand ist ungültig.",
    settings_invalid: "Die Einstellungen entsprechen nicht dem Modulschema.",
    invalid_type: "Verwende einen Wert vom erwarteten Typ.",
    too_small: "Der Wert liegt unter dem erlaubten Minimum.",
    too_big: "Der Wert überschreitet das erlaubte Maximum.",
    invalid_enum_value: "Wähle einen der verfügbaren Werte.",
    invalid_value: "Wähle einen der verfügbaren Werte.",
    invalid_literal: "Wähle einen der verfügbaren Werte.",
    invalid_string: "Das Format ist ungültig.",
    invalid_format: "Das Format ist ungültig.",
    not_multiple_of: "Verwende einen erlaubten Schrittwert.",
    unrecognized_keys: "Die Einstellungen enthalten ein unbekanntes Feld.",
    invalid_union: "Der Wert entspricht keinem unterstützten Format.",
    invalid_key: "Ein Feldname ist ungültig.",
    invalid_element: "Ein Eintrag hat einen ungültigen Wert.",
    custom: "Dieser Wert ist ungültig.",
    template_text_invalid: "Der Chattext kann nicht gesendet werden.",
  },
  en: {
    settings_payload_invalid: "The settings data is invalid.",
    settings_revision_invalid: "The settings revision is invalid.",
    settings_invalid: "The settings do not match the module schema.",
    invalid_type: "Use a value of the expected type.",
    too_small: "This value is below the allowed minimum.",
    too_big: "This value exceeds the allowed maximum.",
    invalid_enum_value: "Choose one of the available values.",
    invalid_value: "Choose one of the available values.",
    invalid_literal: "Choose one of the available values.",
    invalid_string: "The format is invalid.",
    invalid_format: "The format is invalid.",
    not_multiple_of: "Use an allowed step value.",
    unrecognized_keys: "The settings include an unsupported field.",
    invalid_union: "The value does not match a supported format.",
    invalid_key: "A field name is invalid.",
    invalid_element: "An entry has an invalid value.",
    custom: "This value is invalid.",
    template_text_invalid: "This chat message cannot be sent.",
  },
};

export const serverFieldErrorText = (
  reasonCode: string,
  language: DashboardLanguage = dashboardLanguage(),
): string | undefined => Object.hasOwn(serverFieldErrorCatalog[language], reasonCode)
  ? serverFieldErrorCatalog[language][reasonCode as ServerFieldErrorReasonCode]
  : undefined;

const apiSourceFailureCatalog: Readonly<Record<DashboardLanguage, Record<ApiSourceFailureReason, string | ((retryAfter?: number | null) => string)>>> = {
  de: {
    unreachable: "Der Endpunkt ist nicht erreichbar.",
    timeout: "Der Endpunkt hat nicht rechtzeitig geantwortet.",
    http_error: "Der Endpunkt hat einen HTTP-Fehler zurückgegeben.",
    invalid_json: "Die Antwort ist kein gültiges JSON.",
    invalid_expression: "Der JSONata-Ausdruck ist ungültig.",
    unsupported_expression: "Der JSONata-Ausdruck enthält ein nicht unterstütztes Konstrukt.",
    missing_value: "Der Ausdruck hat keinen Wert zurückgegeben.",
    invalid_url: "Die HTTPS-URL ist ungültig oder nicht erlaubt.",
    response_too_large: "Die Antwort überschreitet das Größenlimit.",
    redirect_error: "Die Weiterleitung ist ungültig oder nicht erlaubt.",
    rate_limited: (retryAfter) => retryAfter === null || retryAfter === undefined
      ? "Das Abruflimit für diese Anfrage ist erreicht. Starte einen neuen Abruf."
      : `Das Abruflimit für diesen Kanal ist erreicht. Erneut möglich ab ${new Date(retryAfter).toLocaleTimeString("de-DE")}.`,
  },
  en: {
    unreachable: "The endpoint could not be reached.",
    timeout: "The endpoint did not respond in time.",
    http_error: "The endpoint returned an HTTP error.",
    invalid_json: "The response is not valid JSON.",
    invalid_expression: "The JSONata expression is invalid.",
    unsupported_expression: "The JSONata expression contains an unsupported construct.",
    missing_value: "The expression returned no value.",
    invalid_url: "The HTTPS URL is invalid or not allowed.",
    response_too_large: "The response exceeds the size limit.",
    redirect_error: "The redirect is invalid or not allowed.",
    rate_limited: (retryAfter) => retryAfter === null || retryAfter === undefined
      ? "This request has reached its fetch limit. Try again in a new request."
      : `This channel has reached its fetch limit. Try again after ${new Date(retryAfter).toLocaleTimeString("en-GB")}.`,
  },
};

export const apiSourceFailureText = (
  reason: ApiSourceFailureReason,
  language: DashboardLanguage = dashboardLanguage(),
  retryAfter?: number | null,
): string => {
  const text = apiSourceFailureCatalog[language][reason];
  return typeof text === "string" ? text : text(retryAfter);
};

interface SystemTemplateVariableLocale {
  label: string;
  description: string;
  sample: string;
}

export type SystemTemplateVariableCatalog = Readonly<Record<SystemVariableName, SystemTemplateVariableLocale>>;

export const systemTemplateVariableLocale: Readonly<Record<DashboardLanguage, SystemTemplateVariableCatalog>> = {
  de: {
    user: { label: "Chat-Login", description: "Login der Person im Chat", sample: "zuschauerin" },
    displayname: { label: "Anzeigename", description: "Anzeigename der Person im Chat", sample: "Zuschauerin" },
    channel: { label: "Kanal-Login", description: "Login deines Kanals", sample: "beispielkanal" },
    target: { label: "Zielperson", description: "Erstes Argument oder die auslösende Person", sample: "freund" },
    args: { label: "Alle Argumente", description: "Alle Argumente des Befehls", sample: "hallo zusammen" },
    game: { label: "Aktuelle Kategorie", description: "Aktuelle Kategorie des Streams", sample: "Minecraft" },
    title: { label: "Streamtitel", description: "Aktueller Streamtitel", sample: "Ein gemütlicher Abend" },
    uptime: { label: "Laufzeit", description: "Laufzeit des Streams oder offline", sample: "2 Std. 14 Min." },
    viewers: { label: "Zuschauer", description: "Aktuelle Zuschauerzahl", sample: "42" },
    live: { label: "Live-Status", description: "Ob der Kanal live oder offline ist", sample: "live" },
    followers: { label: "Follower insgesamt", description: "Gesamtzahl der Follower", sample: "12.345" },
    chatters: { label: "Personen im Chat", description: "Personen im Chat", sample: "42" },
    followage: { label: "Follow-Alter", description: "Wie lange die Person dem Kanal folgt", sample: "1 Jahr, 3 Monate" },
    subage: { label: "Abo-Monate", description: "Monate des aktuellen Abzeichens", sample: "6" },
    accountage: { label: "Kontoalter", description: "Alter des Twitch-Kontos", sample: "4 Jahre" },
    uses: { label: "Auslösungen", description: "Auslösungen dieses Befehls einschließlich dieser", sample: "12" },
    cooldown: { label: "Abkühlzeit", description: "Abkühlzeit des Befehls in Sekunden", sample: "5" },
    command: { label: "Befehlsname", description: "Befehlsname oder verwendeter Alias", sample: "hallo" },
    date: { label: "Datum", description: "Heutiges Datum in der Kanalzeitzone", sample: "23.09.2026" },
    time: { label: "Uhrzeit", description: "Aktuelle Uhrzeit in der Kanalzeitzone", sample: "20:15" },
    random: { label: "Zufallszahl", description: "Zufallszahl; Beispielbereich 1–100", sample: "73" },
    pick: { label: "Zufällige Auswahl", description: "Zufällige Auswahl aus deinen Optionen", sample: "Kopf" },
  },
  en: {
    user: { label: "Chat login", description: "Login of the person in chat", sample: "viewer" },
    displayname: { label: "Display name", description: "Display name of the person in chat", sample: "Viewer" },
    channel: { label: "Channel login", description: "Login of your channel", sample: "samplechannel" },
    target: { label: "Target person", description: "First argument or the person who triggered the command", sample: "friend" },
    args: { label: "All arguments", description: "All command arguments", sample: "hello everyone" },
    game: { label: "Current category", description: "Current stream category", sample: "Minecraft" },
    title: { label: "Stream title", description: "Current stream title", sample: "A cozy evening" },
    uptime: { label: "Stream duration", description: "Stream duration or offline", sample: "2 h 14 min" },
    viewers: { label: "Viewers", description: "Current viewer count", sample: "42" },
    live: { label: "Live status", description: "Whether the channel is live or offline", sample: "live" },
    followers: { label: "Total followers", description: "Total follower count", sample: "12,345" },
    chatters: { label: "People in chat", description: "People in chat", sample: "42" },
    followage: { label: "Follow age", description: "How long this person has followed the channel", sample: "1 year, 3 months" },
    subage: { label: "Subscription months", description: "Months on the current subscriber badge", sample: "6" },
    accountage: { label: "Account age", description: "Age of the Twitch account", sample: "4 years" },
    uses: { label: "Command uses", description: "Command triggers including this one", sample: "12" },
    cooldown: { label: "Cooldown", description: "Command cooldown in seconds", sample: "5" },
    command: { label: "Command name", description: "Command name or alias used", sample: "hello" },
    date: { label: "Date", description: "Today's date in the channel time zone", sample: "23.09.2026" },
    time: { label: "Time", description: "Current time in the channel time zone", sample: "20:15" },
    random: { label: "Random number", description: "Random number; example range 1–100", sample: "73" },
    pick: { label: "Random choice", description: "Random choice from your options", sample: "Heads" },
  },
};

export const channelVariableTemplateDescription: Readonly<Record<DashboardLanguage, string>> = {
  de: "Kanalvariable",
  en: "Channel variable",
};

export interface ChannelVariablesTexts {
  title: string;
  list: string;
  search: string;
  countSuffix: string;
  limitSuffix: string;
  filteredSuffix: string;
  create: string;
  empty: string;
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
  generalSection: string;
  valueSection: string;
  valueHint: string;
  editValue: string;
  applyValue: string;
  cancelValueEdit: string;
  minimumValueReached: string;
  maximumValueReached: string;
  resetOnStreamStart: string;
  resetHint: string;
  renameHint: string;
  usages: string;
  noUsages: string;
  usageKindLabel: (kind: "template" | "action" | "display") => string;
  usageModuleLabel: (moduleId: string) => string;
  usageLine: (moduleId: string, itemName: string, kind: "template" | "action" | "display") => string;
  increase: string;
  decrease: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteDescription: (name: string, usages: string, overlayCount?: number) => string;
  deleteConfirm: (name: string) => string;
  deleteCancel: string;
  inUseReason: (usages: string) => string;
  managementLocked: string;
  limitReached: string;
  newVariable: string;
  save: string;
  discard: string;
  close: string;
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
    title: "Kanalvariablen", list: "Variablen", search: "Variablen suchen", countSuffix: "Variablen", limitSuffix: "Variablen belegt", filteredSuffix: "Variablen", create: "Variable anlegen",
    empty: "Noch keine Kanalvariablen angelegt.", loadError: "Kanalvariablen konnten nicht geladen werden.",
    saveError: "Die Kanalvariable konnte nicht gespeichert werden.", deleteError: "Die Kanalvariable konnte nicht gelöscht werden.",
    name: "Name", nameHint: "Kleinbuchstaben, Zahlen und Unterstrich; höchstens 32 Zeichen.", nameInvalid: "Nur Kleinbuchstaben, Zahlen und Unterstrich.",
    description: "Beschreibung", descriptionHint: "Erscheint in der Variablenauswahl. Höchstens 80 Zeichen.", noDescription: "Keine Beschreibung",
    value: "Wert", generalSection: "Allgemein", valueSection: "Aktueller Wert",
    valueHint: "Ganze Zahl von −999.999.999 bis 999.999.999.", editValue: "Wert bearbeiten", applyValue: "Übernehmen", cancelValueEdit: "Abbrechen",
    minimumValueReached: "Der Mindestwert ist erreicht.", maximumValueReached: "Der Höchstwert ist erreicht.",
    resetOnStreamStart: "Bei Streamstart auf null setzen", resetHint: "Wird zurückgesetzt, wenn der nächste Stream startet.",
    renameHint: "Vorlagen und gespeicherte Overlay-Elemente werden angepasst.", usages: "Verwendet in", noUsages: "Noch nicht verwendet.",
    usageKindLabel: (kind) => kind === "action" ? "Aktion" : kind === "display" ? "Anzeige" : "Vorlage",
    usageModuleLabel: (moduleId) => moduleId === "text_commands" ? "Textbefehle" : moduleId === "overlays" ? "Overlays" : moduleId.replace(/[_-]+/gu, " "),
    usageLine: (moduleId, itemName, kind) => `${moduleId === "text_commands" ? `!${itemName.replace(/^!/u, "")}` : itemName} · ${kind === "action" ? "zählt eine Aktion" : kind === "display" ? "Overlay-Anzeige" : "Vorlage"}`,
    increase: "+1", decrease: "−1", delete: "Variable löschen", deleteTitle: (name) => `Variable „${name}“ löschen?`,
    deleteDescription: (name, usages, overlayCount = 0) => overlayCount > 0
      ? `Die Variable „${name}“ wird entfernt; ${String(overlayCount)} Overlay-Element${overlayCount === 1 ? "" : "e"} zeigen sie danach nicht mehr${usages.length === 0 ? "." : `; weitere Verwendungen: ${usages}.`}`
      : usages.length === 0 ? `Die Variable „${name}“ und alle zugehörigen Verwendungen werden entfernt.` : `Die Variable „${name}“ und ihre Verwendungen (${usages}) werden entfernt.`,
    deleteConfirm: (name) => `Variable löschen: ${name}`, deleteCancel: "Abbrechen",
    inUseReason: (usages) => `Wird von ${usages} verwendet. Entferne zuerst die Befehlsaktion.`,
    managementLocked: "Nur Broadcaster und Verwalter dürfen Variablen anlegen, umbenennen, beschreiben oder löschen.",
    limitReached: "Die maximale Zahl der Kanalvariablen ist erreicht.", newVariable: "Neue Variable", save: "Speichern", discard: "Verwerfen", close: "Schließen",
    useInOverlay: "In Overlay verwenden", useOverlayHint: "Wähle ein Overlay. Die Variable wird im Editor als ungespeicherter Entwurf eingefügt.",
    chooseOverlay: "Overlay auswählen", createOverlay: "Neues Overlay", newOverlayName: "Name des neuen Overlays",
    defaultOverlayName: (variableName) => `Overlay ${variableName}`,
    openEditor: "Editor öffnen", reconnect: "Neu verbinden", variableMissing: "Variable fehlt — neu wählen.",
    reconnectConflict: "Das Overlay-Element wurde inzwischen geändert. Lade die Seite neu, bevor du es verbindest.",
    legacyRenameWarning: "Alte Links mit #var=… zeigen diese Variable nach der Umbenennung nicht mehr an.",
  },
  en: {
    title: "Channel variables", list: "Variables", search: "Search variables", countSuffix: "variables", limitSuffix: "variables used", filteredSuffix: "variables", create: "Create variable",
    empty: "No channel variables yet.", loadError: "Channel variables could not be loaded.",
    saveError: "The channel variable could not be saved.", deleteError: "The channel variable could not be deleted.",
    name: "Name", nameHint: "Lowercase letters, numbers, and underscores; up to 32 characters.", nameInvalid: "Use lowercase letters, numbers, and underscores only.",
    description: "Description", descriptionHint: "Shown in the variable picker. Up to 80 characters.", noDescription: "No description",
    value: "Value", generalSection: "General", valueSection: "Current value",
    valueHint: "Integer from −999,999,999 to 999,999,999.", editValue: "Edit value", applyValue: "Apply", cancelValueEdit: "Cancel",
    minimumValueReached: "The minimum value has been reached.", maximumValueReached: "The maximum value has been reached.",
    resetOnStreamStart: "Reset to zero when the stream starts", resetHint: "Resets when the next stream starts.",
    renameHint: "Templates and saved overlay elements are updated.", usages: "Used in", noUsages: "Not used yet.",
    usageKindLabel: (kind) => kind === "action" ? "action" : kind === "display" ? "display" : "template",
    usageModuleLabel: (moduleId) => moduleId === "text_commands" ? "Text commands" : moduleId === "overlays" ? "Overlays" : moduleId.replace(/[_-]+/gu, " "),
    usageLine: (moduleId, itemName, kind) => `${moduleId === "text_commands" ? `!${itemName.replace(/^!/u, "")}` : itemName} · ${kind === "action" ? "changes a variable" : kind === "display" ? "overlay display" : "template"}`,
    increase: "+1", decrease: "−1", delete: "Delete variable", deleteTitle: (name) => `Delete variable “${name}”?`,
    deleteDescription: (name, usages, overlayCount = 0) => overlayCount > 0
      ? `Variable “${name}” will be removed; ${String(overlayCount)} overlay element${overlayCount === 1 ? "" : "s"} will stop showing it${usages.length === 0 ? "." : `, along with these other uses: ${usages}.`}`
      : usages.length === 0 ? `Variable “${name}” and all its references will be removed.` : `Variable “${name}” and its references (${usages}) will be removed.`,
    deleteConfirm: (name) => `Delete variable: ${name}`, deleteCancel: "Cancel",
    inUseReason: (usages) => `Used by ${usages}. Remove the command action first.`,
    managementLocked: "Only broadcasters and managers may create, rename, describe, or delete variables.",
    limitReached: "The channel has reached its variable limit.", newVariable: "New variable", save: "Save", discard: "Discard", close: "Close",
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
  title: string; list: string; search: string; countSuffix: string; limitSuffix: string; filteredSuffix: string; limitReached: string; details: string; empty: string; loading: string;
  loadError: string; actionError: string; managementLocked: string; create: string; createTitle: string;
  name: string; size: string; width: string; height: string; standardSize: string; compactSize: string; customSize: string;
  createSubmit: string; cancel: string; elements: string; accesses: string; lastUsedAt: string; statusLabel: string;
  issue: string; issueLabel: string; copied: string;
  editComposition: string; editorBack: string; editorLoading: string; editorLoadError: string;
  editorElements: string; editorPreview: string; editorPreviewCanvas: string; editorProperties: string;
  editorPropertiesTab: string; editorStyleTab: string; editorCssTab: string;
  editorPropertiesTabShort: string; editorStyleTabShort: string; editorCssTabShort: string;
  editorStyleTarget: string; editorStyleOverlayTarget: string; editorStyleElementTarget: (name: string) => string;
  editorStyleFontSystem: string; editorStyleFontCustomHint: string;
  editorStyleFontSection: string; editorStyleOutlineSection: string; editorStyleShadowSection: string; editorStyleBackgroundSection: string;
  editorStyleSectionUnset: string;
  editorStyleFontFamily: string; editorStyleFontFamilyCount: (count: number, maximum: number) => string;
  editorStyleColorUnset: string; editorStyleColorClear: string;
  editorStyleFontSize: string; editorStyleFontWeight: string; editorStyleColor: string;
  editorStyleAlignment: string; editorStyleAlignmentHint: string; editorStyleLeft: string; editorStyleCenter: string; editorStyleRight: string;
  editorStyleLineHeight: string; editorStyleLetterSpacing: string; editorStyleStrokeWidth: string; editorStyleStrokeColor: string;
  editorStyleShadowX: string; editorStyleShadowY: string; editorStyleShadowBlur: string; editorStyleShadowColor: string;
  editorStyleShadowXShort: string; editorStyleShadowYShort: string; editorStyleShadowBlurShort: string;
  editorStyleBackgroundColor: string; editorStyleBackgroundOpacity: string; editorStylePadding: string; editorStyleRadius: string;
  editorStyleReset: string; editorStyleLocked: string; editorStyleRewrite: string; editorStyleOwnCssHint: string;
  editorStyleReadOnlyReason: string;
  editorStyleCodeHint: string; editorCssReadOnlyReason: string; editorStyleCopy: string; editorStyleCopied: string; editorStyleCopyError: string; editorStyleCssLimit: string;
  editorNoElements: string; editorNoSelection: string; editorReadOnly: string;
  editorAddElement: string; editorPaletteSearch: string; editorPaletteVariables: string;
  editorPaletteNoResults: (query: string) => string; editorPaletteModuleOff: (moduleName: string) => string;
  editorRemoveElement: (name: string) => string; editorLockedReason: string;
  editorPaletteNavigate: string; editorPaletteChoose: string; editorPaletteClose: string;
  editorModuleElement: string; editorModuleDisabled: (moduleName: string) => string;
  editorLabel: string; editorDisplayText: string;
  editorVariable: string; editorX: string; editorY: string; editorScale: string; editorZ: string;
  editorMoveForward: string; editorMoveBackward: string; editorInComposition: string;
  editorZoom: string; editorReference: (width: number, height: number) => string; editorTextHint: string;
  editorElementLimit: string; editorElementUsage: string; editorMissingPrefill: (name: string) => string; editorSave: string;
  editorDiscard: string; editorSaved: string; editorClean: string; editorUnsaved: string; editorSaving: string;
  editorSaveError: string; editorConflictTitle: string; editorConflictDescription: string;
  editorConflictKeep: string; editorConflictReload: string; editorConflictOverwrite: string;
  editorUnsavedTitle: string; editorUnsavedDescription: string; editorContinue: string;
  editorDiscardAndLeave: string; editorSaveAndLeave: string;
  copyError: string; copyLink: string; copyLinkUnrecoverableReason: string; linkExpiredReason: string;
  accessActions: (name: string) => string; showLink: string; hideLink: string; replace: string; revoke: string; remove: string; removed: string; revoked: string; revokedPending: string;
  replaceTitle: (name: string) => string; replaceConsequence: string; replaceConfirm: (name: string) => string;
  revokeTitle: (name: string) => string; revokeConsequence: string; revokeConfirm: (name: string) => string;
  revokedCount: (count: number) => string; newLinkTitle: string;
  accessUnrecoverable: string;
  setup: string; setupAssistant: string; setupAccessSelected: (name: string) => string; setupTarget: string;
  setupObs: string; setupStreamElements: string; setupSoundAlerts: string; setupOutput: string;
  setupWholeOverlay: string; setupSingleElement: string; setupOverlayUrl: string; setupCopyRevealedUrl: string; setupCopiedUrl: string;
  setupDimensions: (width: number, height: number) => string; setupElementDimensions: string;
  setupObsAddSource: string; setupObsBrowser: string; setupObsPasteUrl: string; setupObsSetSize: string; setupObsClearCss: string;
  setupObsCssNote: string; setupStreamElementsPath: string; setupStreamElementsPaste: string;
  setupStreamElementsWholePlacement: (width: number, height: number) => string; setupStreamElementsElementPlacement: string;
  setupSoundAlertsPath: string; setupSoundAlertsImportFields: string; setupSoundAlertsFallback: string; setupSoundAlertsUnverified: string;
  setupHtml: string; setupJs: string; setupFields: string; setupViewSnippet: string;
  setupCopySnippet: (name: string) => string; setupSnippetCopied: (name: string) => string;
  setupAccessInactive: string;
  active: string; expired: string; revokedStatus: string; noAccesses: string; delete: string; deleteTitle: (name: string) => string;
  deleteDescription: (name: string) => string; deleteConfirm: (name: string) => string; close: string;
  conflict: string;
  elementsSummary: (count: number, names: string) => string;
  missingVariable: (name: string) => string;
  legacyTitle: string; legacyDescription: string; legacyEmpty: string; legacyTokenName: string; legacyCreatedByUnknown: string;
  legacyCreatedAt: string; legacyTokenId: string; legacyRevokeTitle: (name: string) => string; legacyRevokeDescription: (name: string) => string;
  legacyRevokeConfirm: (name: string) => string; legacyRevocationReason: string; loadMore: string; legacyLoaded: string;
  legacyImport: string; legacyImportTitle: string; legacyImportDescription: string; legacyImportLinkLabel: string;
  legacyImportPlaceholder: string; legacyImportCssWarning: string; legacyImportPositionWarning: string;
  legacyImportTokenWarning: string; legacyImportConfirm: string; legacyImportSuccess: (name: string) => string;
  legacyImportInvalidLink: string; legacyImportTokenNotFound: string; legacyImportAlreadyBound: string; legacyImportClosingPending: string;
}

const overlaysCatalog: LocaleCatalog<OverlaysTexts> = {
  de: {
    title: "Overlays", list: "Overlays", search: "Overlays suchen", countSuffix: "Overlays", limitSuffix: "Overlays belegt", filteredSuffix: "Overlays", limitReached: "Das Overlay-Limit ist erreicht.",
    details: "Übersicht",
    empty: "Noch keine Overlays angelegt.", loading: "Overlays werden geladen …", loadError: "Overlays konnten nicht geladen werden.",
    actionError: "Die Änderung konnte nicht durchgeführt werden.", managementLocked: "Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.",
    create: "Neues Overlay", createTitle: "Neues Overlay anlegen", name: "Name", size: "Größe", width: "Breite", height: "Höhe",
    standardSize: "1920 × 1080", compactSize: "1280 × 720", customSize: "Eigene Fläche", createSubmit: "Overlay anlegen", cancel: "Abbrechen",
    elements: "Elemente", accesses: "Zugänge", lastUsedAt: "Zuletzt benutzt", statusLabel: "Status", editComposition: "Komposition bearbeiten",
    editorBack: "Zurück zu Overlays", editorLoading: "Overlay wird geladen …", editorLoadError: "Das Overlay konnte nicht geladen werden.",
    editorElements: "Elemente", editorPreview: "Live-Vorschau", editorPreviewCanvas: "Overlay-Vorschau", editorProperties: "Eigenschaften",
    editorPropertiesTab: "Position", editorStyleTab: "Stil-Editor", editorCssTab: "CSS-Code",
    editorPropertiesTabShort: "Position", editorStyleTabShort: "Stil", editorCssTabShort: "CSS",
    editorStyleTarget: "Stil anwenden auf", editorStyleOverlayTarget: "Overlay-Vorgabe",
    editorStyleElementTarget: (name) => `Element: ${name}`,
    editorStyleFontSection: "Schrift", editorStyleOutlineSection: "Kontur", editorStyleShadowSection: "Schatten", editorStyleBackgroundSection: "Hintergrund & Abstand",
    editorStyleSectionUnset: "nicht gesetzt",
    editorStyleFontSystem: "Systemschrift auswählen", editorStyleFontCustomHint: "Wähle eine Systemschrift oder gib einen eigenen Namen ein.",
    editorStyleFontFamily: "Schriftart oder eigener Name", editorStyleFontFamilyCount: (count, maximum) => `${String(count)} / ${String(maximum)} Zeichen`,
    editorStyleColorUnset: "Nicht gesetzt", editorStyleColorClear: "Farbe entfernen",
    editorStyleFontSize: "Schriftgröße", editorStyleFontWeight: "Schriftstärke", editorStyleColor: "Textfarbe",
    editorStyleAlignment: "Anker", editorStyleAlignmentHint: "Legt die Wuchsrichtung fest.",
    editorStyleLeft: "Links", editorStyleCenter: "Mittig", editorStyleRight: "Rechts",
    editorStyleLineHeight: "Zeilenhöhe", editorStyleLetterSpacing: "Buchstabenabstand", editorStyleStrokeWidth: "Konturstärke", editorStyleStrokeColor: "Konturfarbe",
    editorStyleShadowX: "Schatten X-Versatz", editorStyleShadowY: "Schatten Y-Versatz", editorStyleShadowBlur: "Schattenunschärfe", editorStyleShadowColor: "Schattenfarbe",
    editorStyleShadowXShort: "X", editorStyleShadowYShort: "Y", editorStyleShadowBlurShort: "Unschärfe",
    editorStyleBackgroundColor: "Hintergrundfarbe", editorStyleBackgroundOpacity: "Hintergrund-Deckkraft", editorStylePadding: "Innenabstand", editorStyleRadius: "Rundung",
    editorStyleReset: "Stil zurücksetzen", editorStyleLocked: "Der Stilblock wurde im Code geändert oder enthält unbekannte CSS-Eigenschaften. Die Stilfelder sind gesperrt.",
    editorStyleRewrite: "Aus Editor neu schreiben", editorStyleOwnCssHint: "Eigenes CSS unterhalb des verwalteten Blocks gewinnt bei gleichen Eigenschaften.",
    editorStyleReadOnlyReason: "Bediener dürfen den Overlay-Stil ansehen, aber nicht ändern.",
    editorStyleCodeHint: "Das Overlay-CSS ist die Quelle der Wahrheit. Änderungen bleiben im Entwurf, bis du speicherst.",
    editorCssReadOnlyReason: "Bediener können das Overlay-CSS kopieren, aber nicht ändern.",
    editorStyleCopy: "CSS kopieren", editorStyleCopied: "CSS kopiert", editorStyleCopyError: "CSS konnte nicht kopiert werden.",
    editorStyleCssLimit: "Overlay-CSS darf höchstens 16.000 Zeichen enthalten.",
    editorNoElements: "Noch keine Elemente. Füge über „Element hinzufügen“ eine Kanalvariable oder ein Modul-Element hinzu.", editorNoSelection: "Wähle ein Element aus.", editorReadOnly: "Bediener können die Komposition ansehen, aber nicht ändern.",
    editorAddElement: "Element hinzufügen", editorPaletteSearch: "Elemente suchen", editorPaletteVariables: "Kanalvariablen",
    editorPaletteNoResults: (query) => `Kein Element passt zu „${query}“.`, editorPaletteModuleOff: (moduleName) => `Modul aus · ${moduleName}`,
    editorRemoveElement: (name) => `Entfernen: ${name}`, editorLockedReason: "Nur Verwalter und Broadcaster können die Komposition ändern.",
    editorPaletteNavigate: "Navigieren", editorPaletteChoose: "Hinzufügen", editorPaletteClose: "Schließen",
    editorModuleElement: "Modul-Element", editorModuleDisabled: (moduleName) => `Modul ${moduleName} ist deaktiviert.`,
    editorLabel: "Elementname", editorDisplayText: "Anzeigetext",
    editorVariable: "Kanalvariable", editorX: "X (px)", editorY: "Y (px)", editorScale: "Skalierung (%)", editorZ: "Ebene (z)",
    editorMoveForward: "Eine Ebene nach vorn", editorMoveBackward: "Eine Ebene nach hinten", editorInComposition: "In der Komposition anzeigen",
    editorZoom: "Vorschau-Zoom", editorReference: (width, height) => `${String(width)} × ${String(height)} Referenz`, editorTextHint: "Genau ein {value}-Platzhalter ist erforderlich.",
    editorElementLimit: "Pro Overlay sind höchstens 20 Elemente möglich.", editorElementUsage: "Elemente belegt", editorMissingPrefill: (name) => `Die Variable ${name} ist nicht mehr verfügbar.`, editorSave: "Speichern",
    editorDiscard: "Entwurf verwerfen", editorSaved: "Gespeichert — verbundene Quellen übernehmen die Änderungen sofort.", editorClean: "Gespeicherte Komposition. Änderungen werden erst nach dem Speichern live.",
    editorUnsaved: "Ungespeicherte Änderungen", editorSaving: "Wird gespeichert …", editorSaveError: "Die Komposition konnte nicht gespeichert werden.",
    editorConflictTitle: "Overlay wurde geändert", editorConflictDescription: "Eine andere Person hat dieses Overlay geändert. Du kannst die aktuelle Fassung laden oder deinen Entwurf überschreiben.",
    editorConflictKeep: "Weiter bearbeiten", editorConflictReload: "Neu laden", editorConflictOverwrite: "Überschreiben",
    editorUnsavedTitle: "Ungespeicherte Änderungen", editorUnsavedDescription: "Beim Verlassen gehen deine ungespeicherten Änderungen verloren.",
    editorContinue: "Weiter bearbeiten", editorDiscardAndLeave: "Verwerfen und verlassen", editorSaveAndLeave: "Speichern und verlassen",
    issue: "Zugang ausstellen", issueLabel: "Name des Zugangs",
    copied: "Kopiert", copyError: "Der Link konnte nicht kopiert werden.", copyLink: "Link kopieren",
    copyLinkUnrecoverableReason: "Link nicht wiederherstellbar – für einen neuen ersetzen.", linkExpiredReason: "Link abgelaufen – ersetzen oder widerrufen.",
    accessActions: (name) => `Aktionen für ${name}`, showLink: "Link anzeigen", hideLink: "Link verbergen", replace: "Ersetzen", revoke: "Widerrufen", remove: "Entfernen",
    replaceTitle: (name) => `Zugang „${name}“ ersetzen?`, replaceConsequence: "Der bisherige Link wird ungültig und verbundene Quellen verlieren den Zugriff.",
    replaceConfirm: (name) => `Zugang ersetzen: ${name}`, revokeTitle: (name) => `Zugang „${name}“ widerrufen?`,
    revokeConsequence: "Quellen mit diesem Zugang verlieren sofort den Zugriff.", revokeConfirm: (name) => `Zugang widerrufen: ${name}`,
    revokedCount: (count) => `${String(count)} widerrufene Zugänge`, newLinkTitle: "Neuer Link – nur jetzt vollständig",
    accessUnrecoverable: "Dieser alte Zugang kann nicht erneut angezeigt werden. Stelle einen neuen Zugang aus.",
    setup: "Einrichten", setupAssistant: "Einrichtungsassistent", setupAccessSelected: (name) => `Zugang: ${name}`, setupTarget: "Zielsystem",
    setupObs: "OBS", setupStreamElements: "StreamElements", setupSoundAlerts: "Sound Alerts", setupOutput: "Ausgabe",
    setupWholeOverlay: "Ganzes Overlay", setupSingleElement: "Einzelnes Element", setupOverlayUrl: "Maskierter Overlay-Link (Anzeige)",
    setupCopyRevealedUrl: "Overlay-Link kopieren", setupCopiedUrl: "Overlay-Link kopiert",
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
    setupSoundAlertsImportFields: "Nach dem Import in Fields brobotAddress auf den HTTPS-Ursprung des Overlay-Links und overlayUrl auf den vollständigen Link mit Zugangstoken setzen; sonst bleibt brobotAddress auf dem Platzhalterwert und das Widget lehnt den Overlay-Link ab.",
    setupSoundAlertsFallback: "Alternativ ein Custom Widget anlegen und dieselben HTML-, JS- und Fields-Inhalte einsetzen. In Fields brobotAddress auf den HTTPS-Ursprung des Overlay-Links und overlayUrl auf den vollständigen Link mit Zugangstoken setzen; CSS leer lassen.",
    setupSoundAlertsUnverified: "Dieser Klickpfad wurde noch nicht am echten Sound-Alerts-Produkt geprüft.",
    setupHtml: "HTML", setupJs: "JS", setupFields: "Fields", setupViewSnippet: "Inhalt ansehen",
    setupCopySnippet: (name) => `${name} kopieren`, setupSnippetCopied: (name) => `${name} kopiert`,
    setupAccessInactive: "Dieser Zugang ist abgelaufen oder widerrufen und kann nicht kopiert werden.",
    revoked: "Zugang widerrufen.", revokedPending: "Zugang widerrufen. Verbundene Quellen werden noch geschlossen.", removed: "Zugang entfernt.", active: "Aktiv",
    expired: "Abgelaufen", revokedStatus: "Widerrufen", noAccesses: "Für dieses Overlay gibt es noch keine Zugänge.", delete: "Overlay löschen",
    deleteTitle: (name) => `Overlay „${name}“ löschen?`, deleteDescription: () => `Das Overlay mit seinen Elementen wird gelöscht und alle Zugänge werden widerrufen.`,
    deleteConfirm: (name) => `Overlay löschen: ${name}`, close: "Schließen", conflict: "Das Overlay wurde zwischenzeitlich geändert. Lade es neu und versuche es erneut.",
    elementsSummary: (count, names) => count === 0 ? "Noch keine – in der Komposition hinzufügen" : `${String(count)} · ${names}`,
    missingVariable: (name) => `Variable ${name} fehlt`,
    legacyTitle: "Alte Links",
    legacyDescription: "Diese ungebundenen Links verwenden noch die alte Konfiguration im Fragment. Hier kannst du sie widerrufen.",
    legacyEmpty: "Keine ungebundenen alten Links.",
    legacyTokenName: "Unbenannter Alt-Link", legacyCreatedByUnknown: "Ersteller unbekannt", legacyCreatedAt: "Erstellt", legacyTokenId: "Link-ID",
    legacyRevokeTitle: (name) => `Alten Link „${name}“ widerrufen?`,
    legacyRevokeDescription: () => `Der alte Link wird ungültig und verbundene Quellen werden geschlossen.`,
    legacyRevokeConfirm: (name) => `Alten Link widerrufen: ${name}`, legacyRevocationReason: "Über Alte Links im Dashboard widerrufen", loadMore: "Weitere laden", legacyLoaded: "geladen",
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
    title: "Overlays", list: "Overlays", search: "Search overlays", countSuffix: "overlays", limitSuffix: "overlays used", filteredSuffix: "overlays", limitReached: "The overlay limit has been reached.",
    details: "Overview",
    empty: "No overlays yet.", loading: "Loading overlays …", loadError: "Overlays could not be loaded.",
    actionError: "The change could not be completed.", managementLocked: "Only broadcasters and managers may change overlays or accesses.",
    create: "New overlay", createTitle: "Create an overlay", name: "Name", size: "Size", width: "Width", height: "Height",
    standardSize: "1920 × 1080", compactSize: "1280 × 720", customSize: "Custom size", createSubmit: "Create overlay", cancel: "Cancel",
    elements: "Elements", accesses: "Accesses", lastUsedAt: "Last used", statusLabel: "Status", editComposition: "Edit composition",
    editorBack: "Back to overlays", editorLoading: "Loading overlay …", editorLoadError: "The overlay could not be loaded.",
    editorElements: "Elements", editorPreview: "Live preview", editorPreviewCanvas: "Overlay preview", editorProperties: "Properties",
    editorPropertiesTab: "Layout", editorStyleTab: "Style editor", editorCssTab: "CSS code",
    editorPropertiesTabShort: "Layout", editorStyleTabShort: "Style", editorCssTabShort: "CSS",
    editorStyleTarget: "Apply style to", editorStyleOverlayTarget: "Overlay default",
    editorStyleElementTarget: (name) => `Element: ${name}`,
    editorStyleFontSection: "Font", editorStyleOutlineSection: "Outline", editorStyleShadowSection: "Shadow", editorStyleBackgroundSection: "Background & spacing",
    editorStyleSectionUnset: "not set",
    editorStyleFontSystem: "Choose a system font", editorStyleFontCustomHint: "Choose a system font or enter a custom font name.",
    editorStyleFontFamily: "Font family or custom name", editorStyleFontFamilyCount: (count, maximum) => `${String(count)} / ${String(maximum)} characters`,
    editorStyleColorUnset: "Not set", editorStyleColorClear: "Clear color",
    editorStyleFontSize: "Font size", editorStyleFontWeight: "Font weight", editorStyleColor: "Text color",
    editorStyleAlignment: "Anchor", editorStyleAlignmentHint: "Sets the growth direction.",
    editorStyleLeft: "Left", editorStyleCenter: "Center", editorStyleRight: "Right",
    editorStyleLineHeight: "Line height", editorStyleLetterSpacing: "Letter spacing", editorStyleStrokeWidth: "Outline width", editorStyleStrokeColor: "Outline color",
    editorStyleShadowX: "Shadow X offset", editorStyleShadowY: "Shadow Y offset", editorStyleShadowBlur: "Shadow blur", editorStyleShadowColor: "Shadow color",
    editorStyleShadowXShort: "X", editorStyleShadowYShort: "Y", editorStyleShadowBlurShort: "Blur",
    editorStyleBackgroundColor: "Background color", editorStyleBackgroundOpacity: "Background opacity", editorStylePadding: "Padding", editorStyleRadius: "Corner radius",
    editorStyleReset: "Reset style", editorStyleLocked: "The style block was changed in code or contains unknown CSS properties. Style fields are locked.",
    editorStyleRewrite: "Rewrite from editor", editorStyleOwnCssHint: "Custom CSS below the managed block wins when it sets the same properties.",
    editorStyleReadOnlyReason: "Operators can view overlay styles, but cannot change them.",
    editorStyleCodeHint: "Overlay CSS is the source of truth. Changes stay in the draft until you save.",
    editorCssReadOnlyReason: "Operators can copy overlay CSS, but cannot change it.",
    editorStyleCopy: "Copy CSS", editorStyleCopied: "CSS copied", editorStyleCopyError: "CSS could not be copied.",
    editorStyleCssLimit: "Overlay CSS can contain at most 16,000 characters.",
    editorNoElements: "No elements yet. Add a channel variable or module element with “Add element”.", editorNoSelection: "Select an element.", editorReadOnly: "Operators can view the composition, but cannot edit it.",
    editorAddElement: "Add element", editorPaletteSearch: "Search elements", editorPaletteVariables: "Channel variables",
    editorPaletteNoResults: (query) => `No element matches “${query}”.`, editorPaletteModuleOff: (moduleName) => `Module off · ${moduleName}`,
    editorRemoveElement: (name) => `Remove: ${name}`, editorLockedReason: "Only managers and broadcasters can edit the composition.",
    editorPaletteNavigate: "Navigate", editorPaletteChoose: "Add", editorPaletteClose: "Close",
    editorModuleElement: "Module element", editorModuleDisabled: (moduleName) => `${moduleName} module is disabled.`,
    editorLabel: "Element label", editorDisplayText: "Display text",
    editorVariable: "Channel variable", editorX: "X (px)", editorY: "Y (px)", editorScale: "Scale (%)", editorZ: "Layer (z)",
    editorMoveForward: "Move one layer forward", editorMoveBackward: "Move one layer backward", editorInComposition: "Show in composition",
    editorZoom: "Preview zoom", editorReference: (width, height) => `${String(width)} × ${String(height)} reference`, editorTextHint: "Exactly one {value} placeholder is required.",
    editorElementLimit: "An overlay can contain at most 20 elements.", editorElementUsage: "elements used", editorMissingPrefill: (name) => `Variable ${name} is no longer available.`, editorSave: "Save",
    editorDiscard: "Discard draft", editorSaved: "Saved — connected sources use the changes immediately.", editorClean: "Saved composition. Changes go live after you save.",
    editorUnsaved: "Unsaved changes", editorSaving: "Saving …", editorSaveError: "The composition could not be saved.",
    editorConflictTitle: "Overlay changed", editorConflictDescription: "Someone else changed this overlay. Reload the latest version or overwrite it with your draft.",
    editorConflictKeep: "Keep editing", editorConflictReload: "Reload", editorConflictOverwrite: "Overwrite",
    editorUnsavedTitle: "Unsaved changes", editorUnsavedDescription: "Your unsaved changes will be lost if you leave.",
    editorContinue: "Keep editing", editorDiscardAndLeave: "Discard and leave", editorSaveAndLeave: "Save and leave",
    issue: "Issue access", issueLabel: "Access name",
    copied: "Copied", copyError: "The link could not be copied.", copyLink: "Copy link",
    copyLinkUnrecoverableReason: "Link cannot be recovered — replace it to issue a new one.", linkExpiredReason: "Link expired — replace or revoke it.",
    accessActions: (name) => `Actions for ${name}`, showLink: "Show link", hideLink: "Hide link", replace: "Replace", revoke: "Revoke", remove: "Remove",
    replaceTitle: (name) => `Replace access “${name}”?`, replaceConsequence: "The current link will stop working and connected sources will lose access.",
    replaceConfirm: (name) => `Replace access: ${name}`, revokeTitle: (name) => `Revoke access “${name}”?`,
    revokeConsequence: "Sources using this access will lose access immediately.", revokeConfirm: (name) => `Revoke access: ${name}`,
    revokedCount: (count) => `${String(count)} revoked accesses`, newLinkTitle: "New link — shown in full only now",
    accessUnrecoverable: "This legacy access cannot be shown again. Issue a new access.",
    setup: "Set up", setupAssistant: "Setup assistant", setupAccessSelected: (name) => `Access: ${name}`, setupTarget: "Target platform",
    setupObs: "OBS", setupStreamElements: "StreamElements", setupSoundAlerts: "Sound Alerts", setupOutput: "Output",
    setupWholeOverlay: "Whole overlay", setupSingleElement: "Single element", setupOverlayUrl: "Masked overlay link (display)",
    setupCopyRevealedUrl: "Copy overlay link", setupCopiedUrl: "Overlay link copied",
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
    setupSoundAlertsImportFields: "After importing, in Fields set brobotAddress to the HTTPS origin of the overlay link and overlayUrl to the full link containing the access token; otherwise brobotAddress stays at its placeholder value and the widget rejects the overlay link.",
    setupSoundAlertsFallback: "Alternatively add a Custom Widget and paste the same HTML, JS and Fields contents. In Fields, set brobotAddress to the HTTPS origin of the overlay link and overlayUrl to the full link containing the access token; leave CSS empty.",
    setupSoundAlertsUnverified: "This click path has not yet been checked in the real Sound Alerts product.",
    setupHtml: "HTML", setupJs: "JS", setupFields: "Fields", setupViewSnippet: "View contents",
    setupCopySnippet: (name) => `Copy ${name}`, setupSnippetCopied: (name) => `${name} copied`,
    setupAccessInactive: "This access has expired or been revoked and cannot be copied.",
    revoked: "Access revoked.", revokedPending: "Access revoked. Connected sources are still closing.", removed: "Access removed.", active: "Active",
    expired: "Expired", revokedStatus: "Revoked", noAccesses: "This overlay has no accesses yet.", delete: "Delete overlay",
    deleteTitle: (name) => `Delete overlay “${name}”?`, deleteDescription: () => `The overlay and its elements will be deleted, and all accesses will be revoked.`,
    deleteConfirm: (name) => `Delete overlay: ${name}`, close: "Close", conflict: "This overlay changed while you were viewing it. Reload it and try again.",
    elementsSummary: (count, names) => count === 0 ? "None yet — add elements in the composition" : `${String(count)} · ${names}`,
    missingVariable: (name) => `Variable ${name} is missing`,
    legacyTitle: "Legacy links",
    legacyDescription: "These unbound links still use the old fragment configuration. You can revoke them here.",
    legacyEmpty: "No unbound legacy links.",
    legacyTokenName: "Unnamed legacy link", legacyCreatedByUnknown: "Creator unknown", legacyCreatedAt: "Created", legacyTokenId: "Link ID",
    legacyRevokeTitle: (name) => `Revoke legacy link “${name}”?`,
    legacyRevokeDescription: () => `The legacy link will stop working and connected sources will close.`,
    legacyRevokeConfirm: (name) => `Revoke legacy link: ${name}`, legacyRevocationReason: "Revoked from Legacy links in the dashboard", loadMore: "Load more", legacyLoaded: "loaded",
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

export interface DashboardTexts {
  header: {
    connectionRunning: string;
    streamLive: (duration: string | null) => string;
    streamOffline: string;
    streamUnknown: string;
    streamChecked: (relativeTime: string) => string;
    locationMenu: {
      openIn: string;
      openStreetMap: string;
      googleMaps: string;
      appleMaps: string;
      copyCoordinates: string;
      coordinatesCopied: string;
      copyCoordinatesFailed: string;
    };
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
    present: string;
    botPermissionsMissing: (count: string) => string;
  };
  navigation: {
    mainNavigation: string;
    overview: string;
    live: string;
    setup: string;
    channel: string;
    system: string;
    locationWeather: string;
    members: string;
    variables: string;
    overlays: string;
    overlaysChecking: string;
    module: string;
    manageModules: string;
    moduleCategories: Readonly<Record<ModuleNavigationCategory, string>>;
    events: string;
    audit: string;
    selectChannel: string;
    accountMenu: string;
    appearance: string;
    appearanceNightShift: string;
    appearanceIndigoNight: string;
    signingOut: string;
    signOut: string;
    /** Sidebar section heading; the "what you open during an incident" group. */
    openSidebar: string;
    closeSidebar: string;
    sidebarSetupHeading: string;
    sidebarSetupDescription: string;
    sidebarSearch: string;
    moduleOff: string;
  };
  overview: {
    oneChannelAvailable: string;
    channelsAvailableShort: (count: string) => string;
    noChannelAvailable: string;
    noMembership: string;
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
    broadcasterOauth: string;
    chatConsent: string;
    botAccount: string;
    botPermissions: string;
    moderatorStatus: string;
    chatSubscription: string;
    tokenStatus: string;
    requestChannelBotConsent: string;
    channelBotConsentLocked: string;
    channelBotConsentMissing: string;
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
    who: string;
    systemActor: string;
    load: string;
    loadError: string;
    empty: string;
    changeData: string;
    before: string;
    after: string;
    olderEntries: string;
    loaded: string;
    loadingOlderEntries: string;
    yes: string;
    no: string;
    newValue: string;
    removedValue: string;
    changedTruncated: string;
    changesHeading: string;
    sentenceTemplates: Record<AuditAction, (parts: AuditSentenceParts) => string>;
    sentenceSettingsChanged: (actor: string, module: string) => string;
    /** `channel.variable.renamed` when only the description changed (#254 review; see `audit/model.ts`'s `channelVariableChangeKind`). */
    sentenceVariableDescriptionChanged: (actor: string, object: string) => string;
    /** `channel.variable.renamed` when the reset-on-stream-start setting changed. */
    sentenceVariableSettingsChanged: (actor: string, object: string) => string;
    sentenceUnknownAction: (actor: string) => string;
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
    timestamp: string;
    operation: string;
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
    feedEnd: string;
    realtimeConnecting: string;
    realtimeConnected: string;
    realtimeReconnecting: string;
    realtimeOffline: string;
    realtimeRenewSession: string;
    realtimeNew: (count: string) => string;
    connectionLost: string;
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
  };
  module: {
    module: string;
    available: string;
    load: string;
    managementLocked: string;
    noneActive: string;
    noView: string;
    views: string;
    settingsLoadError: string;
    componentLoadError: string;
    unsavedChangesTitle: string;
    unsavedChangesDescription: string;
    continueEditing: string;
    discardAndSwitch: string;
    saveAndSwitch: string;
    scopesMissing: (name: string) => string;
    requestScopeConsent: string;
    scopeConsentLocked: string;
    scopeList: string;
    scopeMissing: string;
    scopeGranted: string;
    chatCommands: string;
    chatCommandsButtonLabel: (count: string) => string;
    chatCommandArguments: string;
    chatCommandAvailableTo: string;
    chatCommandCopy: string;
    chatCommandCopied: string;
    chatCommandCopyFailed: string;
    chatCommandThresholds: Record<ModuleChatCommandThreshold, string>;
  };
  /** Shared live-cockpit action frames and reserved tile copy. */
  streamManager: {
    immediateActions: string;
    actionCount: (count: number) => string;
    actionRun: string;
    actionCancel: string;
    actionRunning: string;
    actionLoading: string;
    actionLoadFailed: string;
    actionAvailabilityFailed: string;
    actionAvailabilityStale: string;
    actionFailed: string;
    actionSucceeded: (name: string) => string;
    actionErrorActions: {
      commercialScopeNextStep: string;
      commercialCooldown: (remaining: string) => string;
      clipScopeNextStep: string;
    };
    operatorOnly: string;
    managerOnly: string;
    broadcasterOnly: string;
    availabilityReasons: Record<ImmediateActionUnavailableReason, string>;
    /** Command palette action labels; cockpit labels come from module declarations. */
    runAd: (length: string) => string;
    createClip: string;
    sendShoutout: string;
    today: string;
    yesterday: string;
    browserTimeZoneFallback: string;
  };
  liveCockpit: {
    live: string;
    actionsHint: string;
    offline: string;
    unknown: string;
    duration: string;
    viewers: string;
    youAre: (role: string) => string;
    roles: Record<ChannelRole, string>;
    broadcastLoading: string;
    broadcastUnavailable: string;
    broadcastEmptyTitle: string;
    broadcastNoCategory: string;
    broadcastEdit: string;
    broadcastSave: string;
    broadcastTitleLabel: string;
    broadcastTitleCount: (count: number, maximum: number) => string;
    broadcastManagerOnly: string;
    broadcastScopeMissing: string;
    broadcastReconnect: string;
    broadcastReconnectOwnerOnly: string;
    broadcastSaveError: string;
    broadcastIdentityMissing: string;
    broadcastSaved: string;
    broadcastGamePicker: GameMultiSelectMessages;
    bot: string;
    botConnected: string;
    botUnavailable: string;
    belabox: string;
    belaboxDisabled: string;
    belaboxChecking: string;
    belaboxNotConfigured: string;
    belaboxUnavailable: string;
    belaboxDisconnected: string;
    belaboxConnected: (bitrate: string) => string;
    overlays: string;
    overlaysCount: (count: string) => string;
    overlaysNotSetUp: string;
    overlaysChecking: string;
    runningNow: string;
    liveDataLoading: string;
    liveDataUnavailable: string;
    noActionRunning: string;
    voteType: string;
    votekickType: string;
    voteEndsIn: (time: string) => string;
    voteTotal: (count: string) => string;
    voteOptionCount: (count: string, percent: string) => string;
    voteExtend: string;
    voteEnd: string;
    voteExtended: string;
    voteExtensionUnavailable: string;
    voteChanged: string;
    voteEnded: string;
    voteEndFailed: string;
    votekickVotes: (yes: string, no: string, threshold: string) => string;
    votekickCancel: string;
    votekickCancelTitle: string;
    votekickCancelDescription: (target: string) => string;
    votekickCanceled: string;
    votekickChanged: string;
    votekickCancelFailed: string;
    nextUp: string;
    noUpcomingItems: string;
    nextAdBreak: string;
    adDuration: (duration: string) => string;
    adSnooze: string;
    adSnoozed: string;
    adSnoozeFailed: string;
    adSnoozeRetryAfter: (time: string) => string;
    adSnoozeUnavailable: string;
    events: string;
    eventsFilterLabel: string;
    eventsAll: string;
    eventsRaids: string;
    eventsCommunity: string;
    eventsChat: string;
    eventsSearch: string;
    eventsEmpty: string;
    eventsUnavailable: string;
    eventsLoading: string;
    raidShoutout: string;
    raidShoutoutSent: string;
    raidShoutoutFailed: string;
    statusIndicators: string;
    systemStatus: string;
    systemStatusDescription: (health: string) => string;
    systemReady: string;
    liveDataCurrent: string;
    locationMissing: string;
    locationMissingDescription: string;
    configureLocation: string;
    belaboxWeak: string;
    belaboxWeakDescription: (bitrate: string) => string;
    openBelabox: string;
    actionDraftDiscardTitle: string;
    actionDraftDiscardDescription: string;
    actionDraftDiscard: string;
    actionDraftContinue: string;
  };
  channelControls: {
    controlsHeading: string;
    inactive: string;
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
    refreshFailure: string;
  };
  /** Cmd/Ctrl+K searches pages, entities, and registered channel actions. */
  commandPalette: {
    title: string;
    description: string;
    placeholder: string;
    navigateHint: string;
    openHint: string;
    empty: string;
    groupRecentTargets: string;
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
      streamLive: (duration) => duration === null ? "Live" : `Live · ${duration} h`,
      streamOffline: "Offline",
      streamUnknown: "Status unbekannt",
      streamChecked: (relativeTime) => `Zustand geprüft ${relativeTime}`,
      locationMenu: {
        openIn: "Öffnen in",
        openStreetMap: "OpenStreetMap",
        googleMaps: "Google Maps",
        appleMaps: "Apple Karten",
        copyCoordinates: "Koordinaten kopieren",
        coordinatesCopied: "Koordinaten kopiert",
        copyCoordinatesFailed: "Koordinaten konnten nicht kopiert werden.",
      },
    },
    status: {
      connected: "Verbunden", revoked: "Widerrufen", error: "Fehler",
      loginIdentityMissing: "Login-Identität fehlt", notChecked: "Nicht geprüft", expired: "Abgelaufen", refreshing: "wird aktualisiert",
      maintenanceOverdue: "Wartung überfällig", renewalOverdue: "Erneuerung überfällig", valid: "Gültig",
      moderatorRoleMissing: "Moderatorrolle fehlt", chatSubscriptionError: "Chat-Abo-Fehler", chatSubscriptionRevoked: "Chat-Abo widerrufen",
      botError: "Bot-Fehler", botTokenRevoked: "Bot-Token widerrufen", broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt",
      chatSubscriptionMissing: "Chat-Abo fehlt", chatSubscriptionNotNeeded: "Nicht benötigt — kein aktives Modul liest den Chat.", healthy: "Gesund", stateIncomplete: "Zustand unvollständig",
      notConnected: "Nicht verbunden", notSetUp: "Nicht eingerichtet", moderator: "Moderator", missing: "Fehlt",
      active: "Aktiv", pending: "Ausstehend", present: "Vorhanden",
      botPermissionsMissing: (count) => `${count} fehlen`,
    },
    navigation: {
      mainNavigation: "Hauptnavigation", overview: "Übersicht", live: "Live", setup: "Einrichten", channel: "Kanal", system: "System", locationWeather: "Ort & Wetter",
      members: "Mitglieder", variables: "Variablen", module: "Module", events: "Ereignisse", audit: "Protokoll", selectChannel: "Kanal auswählen",
      accountMenu: "Konto", appearance: "Darstellung", appearanceNightShift: "Nachtschicht", appearanceIndigoNight: "Indigo-Nacht",
      manageModules: "Module verwalten", moduleCategories: { chat: "Chat", participation: "Mitmachen", twitch: "Twitch", data: "Daten", stream: "Stream", admin: "Verwaltung" },
      overlays: "Overlays",
      overlaysChecking: "Wird geprüft …",
      signingOut: "Abmeldung …", signOut: "Abmelden",
      openSidebar: "Seitenleiste öffnen", closeSidebar: "Seitenleiste schließen",
      sidebarSetupHeading: "Einrichten", sidebarSetupDescription: "Alles für deinen Stream.", sidebarSearch: "Alles durchsuchen", moduleOff: "Aus",
    },
    overview: {
      oneChannelAvailable: "1 Kanal freigegeben",
      channelsAvailableShort: (count) => `${count} Kanäle freigegeben`,
      noChannelAvailable: "Noch kein Kanal freigegeben",
      noMembership: "Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.",
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
      botPermissionsOperator: "Der Betreiber muss die Anwendung neu autorisieren.",
      botPermissionsComplete: "Alle angeforderten Bot-Berechtigungen sind vorhanden.",
    },
    errors: {
      title: "Fehler", warning: "Warnung", sessionInvalid: "Deine Sitzung ist nicht mehr gültig.",
      dataLoadFailed: "Die Daten konnten nicht geladen werden.", changeFailed: "Die Änderung ist fehlgeschlagen.", last: "Letzter Fehler",
      noCause: "Keine gespeicherte Ursache",
    },
    statusCard: {
      broadcasterOauth: "Broadcaster-OAuth", chatConsent: "Chat-Zustimmung",
      botAccount: "Bot-Account", botPermissions: "Bot-Berechtigungen", moderatorStatus: "Moderatorstatus", chatSubscription: "Chat-Abo", tokenStatus: "Token-Zustand",
      requestChannelBotConsent: "Chat-Zugriff erlauben",
      channelBotConsentLocked: "Nur der Twitch-Kanalinhaber kann diese Zustimmung erteilen.",
      channelBotConsentMissing: "Der Bot darf noch nicht im Chat schreiben.",
    },
    time: {
      updated: (relativeTime) => `aktualisiert ${relativeTime}`, secondsAgo: (count) => `vor ${String(count)} s`,
      minutesAgo: (count) => `vor ${String(count)} Min.`, hoursAgo: (count) => `vor ${String(count)} Std.`,
    },
    system: {
      title: "System", readOnly: "Kanalvorgaben und technischer Systemzustand", loadState: "Systemzustand wird geladen …", properties: "Eigenschaften",
      botReason: "Bot-Grund", botUpdated: "Bot zuletzt aktualisiert", chatSubscriptionId: "Chat-Abo-ID", chatSubscriptionReason: "Chat-Abo-Grund",
      chatSubscriptionUpdated: "Chat-Abo zuletzt aktualisiert", loginStatus: "Login-Token-Status", loginReason: "Login-Token-Grund",
      loginValidUntil: "Login-Token gültig bis", botValidUntil: "Bot-Token gültig bis",
      subscriptions: "Abonnements", noSubscriptions: "Keine Abonnements gespeichert.", subscription: "Abo", state: "Zustand", reason: "Grund",
      subscriptionDetails: "Abo-Details", subscriptionRawType: "Roher Typ", subscriptionVersion: "Version", subscriptionId: "Abo-ID", subscriptionUpdated: "Zuletzt geändert",
      twitchMessage: "Twitch-Meldung", httpStatus: "HTTP-Status", missingBotPermissions: "Fehlende Bot-Berechtigungen", missingScopes: "Fehlende Scopes",
    },
    audit: {
      title: "Audit-Log", entries: "Einträge", who: "Wer", systemActor: "Automatisches System",
      load: "Audit-Log wird geladen …", loadError: "Der Audit-Log konnte nicht geladen werden.", empty: "Noch keine Audit-Einträge gespeichert.", changeData: "Änderungsdaten",
      before: "Vorher", after: "Nachher", olderEntries: "Ältere Einträge laden", loaded: "geladen", loadingOlderEntries: "Ältere Einträge werden geladen …",
      yes: "Ja", no: "Nein", newValue: "neu", removedValue: "entfernt",
      changedTruncated: "geändert (Text länger als die Vorschau)", changesHeading: "Änderungen",
      sentenceTemplates: {
        "channel.released": ({ actor, object }) => `${actor} gab den Kanal ${object} frei`,
        "channel.full_consent_changed": ({ actor, object, from, to }) => `${actor} änderte die Vollzustimmung für ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "channel.time_zone.updated": ({ actor, object, from, to }) => `${actor} änderte die Zeitzone für ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "channel.default_chat_target.updated": ({ actor, object, from, to }) => `${actor} änderte das Standard-Chat-Ziel für ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "channel.location.updated": ({ actor, object, from, to }) => `${actor} änderte den Standort für ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "member.added": ({ actor, object, to }) => `${actor} fügte ${object}${to === null ? "" : ` als ${to}`} hinzu`,
        "member.role_changed": ({ actor, object, from, to }) => `${actor} änderte die Rolle von ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "member.removed": ({ actor, object, from }) => `${actor} entfernte ${object}${from === null ? "" : ` mit der Rolle ${from}`}`,
        "module.enabled": ({ actor, object }) => `${actor} aktivierte das Modul ${object}`,
        "module.disabled": ({ actor, object }) => `${actor} deaktivierte das Modul ${object}`,
        "module.secret.replaced": ({ actor, object }) => `${actor} ersetzte ein Geheimnis für ${object}`,
        "module.secret.removed": ({ actor, object }) => `${actor} entfernte ein Geheimnis für ${object}`,
        "chat_voting.started": ({ actor }) => `${actor} startete eine Chat-Abstimmung`,
        "chat_voting.closed": ({ actor }) => `${actor} schloss eine Chat-Abstimmung`,
        "chat_voting.extended": ({ actor }) => `${actor} verlängerte eine Chat-Abstimmung`,
        "chat_voting.template.created": ({ actor, object }) => `${actor} erstellte die Abstimmungsvorlage ${object}`,
        "chat_voting.template.updated": ({ actor, object }) => `${actor} änderte die Abstimmungsvorlage ${object}`,
        "chat_voting.template.deleted": ({ actor, object }) => `${actor} löschte die Abstimmungsvorlage ${object}`,
        "text_commands.command.created": ({ actor, object }) => `${actor} erstellte den Textbefehl ${object}`,
        "text_commands.command.updated": ({ actor, object }) => `${actor} änderte den Textbefehl ${object}`,
        "text_commands.command.removed": ({ actor, object }) => `${actor} entfernte den Textbefehl ${object}`,
        "faq.entry.created": ({ actor, object }) => `${actor} legte den FAQ-Eintrag ${object} an`,
        "faq.entry.updated": ({ actor, object }) => `${actor} änderte den FAQ-Eintrag ${object}`,
        "faq.entry.removed": ({ actor, object }) => `${actor} entfernte den FAQ-Eintrag ${object}`,
        "faq.entry.enabled": ({ actor, object }) => `${actor} aktivierte den FAQ-Eintrag ${object}`,
        "faq.entry.disabled": ({ actor, object }) => `${actor} deaktivierte den FAQ-Eintrag ${object}`,
        "faq.entry.reordered": ({ actor, object }) => `${actor} änderte die Reihenfolge des FAQ-Eintrags ${object}`,
        "text_library.block.created": ({ actor, object }) => `${actor} erstellte den Textbaustein ${object}`,
        "text_library.block.updated": ({ actor, object }) => `${actor} änderte den Textbaustein ${object}`,
        "text_library.block.renamed": ({ actor, from, to, object }) => `${actor} benannte den Textbaustein ${from ?? object} in ${to ?? object} um`,
        "text_library.block.removed": ({ actor, object }) => `${actor} entfernte den Textbaustein ${object}`,
        "text_library.category.created": ({ actor, object }) => `${actor} erstellte die Textkategorie ${object}`,
        "text_library.category.renamed": ({ actor, from, to, object }) => `${actor} benannte die Textkategorie ${from ?? object} in ${to ?? object} um`,
        "text_library.category.removed": ({ actor, object }) => `${actor} entfernte die Textkategorie ${object}`,
        "text_library.settings.updated": ({ actor, object, from, to }) => `${actor} änderte die Einstellungen der ${object}${from === null || to === null ? "" : ` von ${from} zu ${to}`}`,
        "timers.timer.created": ({ actor, object }) => `${actor} legte den Timer ${object} an`,
        "timers.timer.updated": ({ actor, object }) => `${actor} änderte den Timer ${object}`,
        "timers.timer.removed": ({ actor, object }) => `${actor} entfernte den Timer ${object}`,
        "timers.timer.enabled": ({ actor, object }) => `${actor} aktivierte den Timer ${object}`,
        "timers.timer.disabled": ({ actor, object }) => `${actor} deaktivierte den Timer ${object}`,
        "api_source.source_created": ({ actor, object }) => `${actor} legte die API-Quelle ${object} an`,
        "api_source.source_changed": ({ actor, object }) => `${actor} änderte die API-Quelle ${object}`,
        "api_source.source_deleted": ({ actor, object }) => `${actor} löschte die API-Quelle ${object}`,
        "channel.variable.created": ({ actor, object }) => `${actor} legte die Kanalvariable ${object} an`,
        "channel.variable.renamed": ({ actor, from, to, object }) => `${actor} benannte die Kanalvariable ${from ?? object} in ${to ?? object} um`,
        "channel.variable.removed": ({ actor, object }) => `${actor} löschte die Kanalvariable ${object}`,
        "channel.variable.value_changed": ({ actor, object, from, to }) => `${actor} änderte den Wert der Kanalvariable ${object} von ${from ?? "—"} zu ${to ?? "—"}`,
        "ads.commercial_started": ({ actor, object, to }) => `${actor} startete ${object}${to === null ? "" : ` für ${to}`}`,
        "clip.created": ({ actor, object }) => `${actor} erstellte ${object}`,
        "channel.mute.enabled": ({ actor, object }) => `${actor} schaltete ${object} stumm`,
        "channel.mute.disabled": ({ actor, object }) => `${actor} hob die Stummschaltung für ${object} auf`,
        "channel.pause.enabled": ({ actor, object }) => `${actor} pausierte automatische Aktionen für ${object}`,
        "channel.pause.disabled": ({ actor, object }) => `${actor} setzte automatische Aktionen für ${object} fort`,
        "votekick.cancelled": ({ actor, object }) => `${actor} brach die Abstimmung ${object} ab`,
        "votekick.timeout_lift_attempted": (parts) => `${parts.actor} versuchte, den Timeout für ${parts.object} aufzuheben (${votekickLiftOutcomeText(parts.outcome, "de")})`,
        "overlay.token.issued": ({ actor, object }) => `${actor} stellte ${object} aus`,
        "overlay.token.revoked": ({ actor, object }) => `${actor} widerrief ${object}`,
        "overlay.access.issued": ({ actor, object }) => `${actor} stellte ${object} aus`,
        "overlay.access.revealed": ({ actor, object }) => `${actor} zeigte ${object} an`,
        "overlay.access.revoked": ({ actor, object }) => `${actor} widerrief ${object}`,
        "overlay.access.replaced": ({ actor, object }) => `${actor} ersetzte ${object}`,
        "overlay.access.removed": ({ actor, object }) => `${actor} entfernte ${object}`,
        "overlay.created": ({ actor, object }) => `${actor} erstellte das Overlay ${object}`,
        "overlay.updated": ({ actor, object }) => `${actor} änderte das Overlay ${object}`,
        "overlay.deleted": ({ actor, object }) => `${actor} löschte das Overlay ${object}`,
        "overlay.legacy.imported": ({ actor, object }) => `${actor} importierte den alten Overlay-Link ${object}`,
      },
      sentenceSettingsChanged: (actor, module) => `${actor} änderte die Einstellungen von ${module}`,
      sentenceVariableDescriptionChanged: (actor, object) => `${actor} änderte die Beschreibung der Kanalvariable ${object}`,
      sentenceVariableSettingsChanged: (actor, object) => `${actor} änderte die Einstellungen der Kanalvariable ${object}`,
      sentenceUnknownAction: (actor) => `${actor} führte eine nicht erkannte Aktion aus`,
      filter: "Filter", person: "Person",
      personHint: "Wer die Aktion ausgeführt hat, nicht wer betroffen war.",
      personPlaceholder: "Login oder ID, z. B. beispielnutzer",
      area: "Bereich", allAreas: "Alle Bereiche",
      areaLabels: { module: "Module", command: "Textbefehle", member: "Mitglieder", channel: "Kanal", overlay: "Overlay" },
      activeFilters: "Aktive Filter:", resetFilters: "Filter zurücksetzen", noMatches: "Keine Einträge passen zu den Filtern.",
    },
    events: {
      title: "Ereignisse", count: (count) => `${count} Einträge`, log: "Ereignisprotokoll", time: "Zeit", event: "Ereignis",
      module: "Modul", who: "Wer", automatic: "Automatisch", info: "Info", error: "Fehler", notice: "Hinweis", unknown: "Unbekannt", timestamp: "Zeitstempel", operation: "Vorgang", history: "Verlauf",
      load: "Ereignisse werden geladen …",
      none: "Noch keine Ereignisse protokolliert.", detail: "Detail", loadOlder: "Ältere Ereignisse laden", loadingOlder: "Ältere Ereignisse werden geladen …",
      filter: "Filter", origin: "Herkunft", moduleFilter: "Modul", allModules: "Alle Module", tone: "Ton", person: "Person", all: "Alle",
      channelEvents: "Kanalereignisse", moduleDiagnostics: "Moduldiagnosen", activeFilters: "Aktive Filter:", resetFilters: "Filter zurücksetzen",
      noMatches: "Keine Ereignisse passen zu den Filtern.",
      feedEnd: "Ende des Ereignisverlaufs erreicht.",
      realtimeConnecting: "Verbindet …", realtimeConnected: "Verbunden", realtimeReconnecting: "Verbindet neu …",
      realtimeOffline: "Offline", realtimeRenewSession: "Sitzung erneuern", realtimeNew: (count) => `${count} neue Ereignisse`,
      connectionLost: "Verbindung unterbrochen. Die Ereignisse konnten nicht geladen werden.",
      technicalDetails: "Technische Details", copyId: "ID kopieren", copied: "Kopiert",
      trigger: "Auslöser", moderator: "Moderator", affectedPerson: "Betroffene Person",
      showCause: (eventLabel) => `Ursache anzeigen: ${eventLabel}`,
      causeTwitchMessage: (message) => `Twitch: ${message}`,
      causeDetailMessage: (message) => `Details: ${message}`,
    },
    signIn: {
      required: "Anmeldung erforderlich", explanation: "Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.",
      signInWithTwitch: "Mit Twitch anmelden",
    },
    module: {
      module: "Modul", available: "Verfügbare Module", load: "Module werden geladen …",
      managementLocked: "Nur Broadcaster und Verwalter dürfen Module ändern.", noneActive: "Keine Module aktiv.",
      noView: "Für dieses aktive Modul gibt es noch keine Panel-Ansicht.", views: "Modulansichten",
      settingsLoadError: "Moduleinstellungen konnten nicht geladen werden.",
      componentLoadError: "Modulinhalte konnten nicht geladen werden.",
      unsavedChangesTitle: "Ungespeicherte Änderungen",
      unsavedChangesDescription: "Du hast ungespeicherte Moduleinstellungen. Was möchtest du tun?",
      continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln",
      scopesMissing: (name) => `Das Modul „${name}“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.`,
      requestScopeConsent: "Broadcaster-Berechtigungen erteilen",
      scopeConsentLocked: "Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.",
      scopeList: "Benötigte Broadcaster-Berechtigungen",
      scopeMissing: "Fehlt",
      scopeGranted: "Erteilt",
      chatCommands: "Chatbefehle",
      chatCommandsButtonLabel: (count) => `Chatbefehle · ${count}`,
      chatCommandArguments: "Argumente",
      chatCommandAvailableTo: "Im Chat ausführbar für",
      chatCommandCopy: "Kopieren",
      chatCommandCopied: "Chatbefehl kopiert.",
      chatCommandCopyFailed: "Chatbefehl konnte nicht kopiert werden.",
      chatCommandThresholds: {
        everyone: "alle",
        subscriber: "Abonnenten und höher",
        vip: "VIPs, Moderatoren und Broadcaster",
        moderator: "Moderatoren und Broadcaster",
        broadcaster: "Broadcaster",
        configurable: "in den Votekick-Einstellungen (Standard: VIP)",
      },
    },
    streamManager: {
      immediateActions: "Sofortaktionen",
      actionCount: (count) => `${String(count)} ${count === 1 ? "Aktion" : "Aktionen"}`,
      actionRun: "Ausführen",
      actionCancel: "Abbrechen",
      actionRunning: "Wird ausgeführt …",
      actionLoading: "Aktion wird geladen …",
      actionLoadFailed: "Die Aktion konnte nicht geladen werden.",
      actionAvailabilityFailed: "Die Verfügbarkeit konnte nicht geprüft werden.",
      actionAvailabilityStale: "Prüfung veraltet; Aktion bleibt verfügbar.",
      actionFailed: "Die Aktion konnte nicht ausgeführt werden.",
      actionSucceeded: (name) => `${name} ausgeführt.`,
      actionErrorActions: {
        commercialScopeNextStep: "Erneuere die Twitch-Berechtigung channel:edit:commercial für dieses Kanal-Konto.",
        commercialCooldown: (remaining) => `Die Werbe-Abklingzeit läuft noch. Erneut versuchen in ${remaining}.`,
        clipScopeNextStep: "Verbinde das Bot-Konto erneut und erteile die Twitch-Berechtigung clips:edit.",
      },
      operatorOnly: "Nur Bediener und höhere Rollen dürfen diese Aktion ausführen.",
      managerOnly: "Nur Verwalter und Broadcaster dürfen diese Aktion ausführen.",
      broadcasterOnly: "Nur Broadcaster dürfen diese Aktion ausführen.",
      availabilityReasons: {
        stream_offline: "Der Stream ist offline.",
        stream_state_unknown: "Der Streamstatus ist derzeit nicht verfügbar.",
      },
      runAd: (length) => `Werbung jetzt (${length}s)`,
      createClip: "Clip erstellen",
      sendShoutout: "Shoutout senden",
      today: "Heute",
      yesterday: "Gestern",
      browserTimeZoneFallback: "Browser-Zeitzone wird verwendet",
    },
    liveCockpit: {
      live: "Live",
      actionsHint: "Direkt im Stream steuerbar",
      offline: "Offline",
      unknown: "Status unbekannt",
      duration: "Dauer",
      viewers: "Zuschauer",
      youAre: (role) => `Du bist: ${role}`,
      roles: { broadcaster: "Broadcaster", manager: "Verwalter", operator: "Bediener" },
      broadcastLoading: "Streamtitel und Kategorie werden geladen.",
      broadcastUnavailable: "Streamtitel und Kategorie sind gerade nicht verfügbar.",
      broadcastEmptyTitle: "Kein Streamtitel gesetzt",
      broadcastNoCategory: "Keine Kategorie",
      broadcastEdit: "Titel und Kategorie bearbeiten",
      broadcastSave: "Änderungen speichern",
      broadcastTitleLabel: "Streamtitel",
      broadcastTitleCount: (count, maximum) => `${String(count)} / ${String(maximum)} Zeichen`,
      broadcastManagerOnly: "Nur Verwalter und Broadcaster dürfen Streamtitel und Kategorie ändern.",
      broadcastScopeMissing: "Dem Kanalzugang fehlt die Twitch-Berechtigung channel:manage:broadcast.",
      broadcastReconnect: "Twitch-Zugang erneuern",
      broadcastReconnectOwnerOnly: "Nur der Broadcaster kann diese Twitch-Berechtigung erneuern.",
      broadcastSaveError: "Streamtitel und Kategorie konnten nicht gespeichert werden.",
      broadcastIdentityMissing: "Der Twitch-Zugang dieses Kanals ist nicht verbunden.",
      broadcastSaved: "Streamtitel und Kategorie gespeichert.",
      broadcastGamePicker: {
        label: "Kategorie", hint: "Eine Kategorie auswählen.", search: "Kategorie suchen", searchHint: "Mindestens zwei Zeichen eingeben.",
        loading: "Kategorien werden geladen.", empty: "Keine Kategorien gefunden.", error: "Kategorien konnten nicht geladen werden.",
        suggestions: "Vorschläge", allGames: "Kategorie auswählen", limitReached: "Es kann nur eine Kategorie gewählt werden.",
        selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)} ausgewählt`, remove: (name) => `${name} entfernen`,
      },
      bot: "Bot",
      botConnected: "Verbunden",
      botUnavailable: "Nicht verbunden",
      belabox: "BELABOX",
      belaboxDisabled: "Aus",
      belaboxChecking: "wird geprüft",
      belaboxNotConfigured: "nicht eingerichtet",
      belaboxUnavailable: "nicht erreichbar",
      belaboxDisconnected: "getrennt",
      belaboxConnected: (bitrate) => `${bitrate} kbit/s verbunden`,
      overlays: "Overlays",
      overlaysCount: (count) => `${count} aktiv`,
      overlaysNotSetUp: "Nicht eingerichtet",
      overlaysChecking: "wird geprüft",
      runningNow: "Läuft gerade",
      liveDataLoading: "Live-Daten werden geladen.",
      liveDataUnavailable: "Live-Daten sind gerade nicht verfügbar.",
      noActionRunning: "Noch keine Aktion läuft.",
      voteType: "Abstimmung",
      votekickType: "Votekick",
      voteEndsIn: (time) => `noch ${time}`,
      voteTotal: (count) => `${count} Stimmen gesamt`,
      voteOptionCount: (count, percent) => `${count} Stimmen · ${percent} %`,
      voteExtend: "+30 s",
      voteEnd: "Beenden",
      voteExtended: "Abstimmung um 30 Sekunden verlängert.",
      voteExtensionUnavailable: "Die Abstimmung lässt sich nicht weiter verlängern.",
      voteChanged: "Die Abstimmung wurde inzwischen ersetzt. Bitte prüfe den aktuellen Stand.",
      voteEnded: "Abstimmung beendet.",
      voteEndFailed: "Abstimmung konnte nicht beendet werden.",
      votekickVotes: (yes, no, threshold) => `Ja ${yes} · Nein ${no} · Schwelle ${threshold}`,
      votekickCancel: "Votekick abbrechen",
      votekickCancelTitle: "Votekick abbrechen?",
      votekickCancelDescription: (target) => `Die Abstimmung gegen ${target} endet sofort. Es wird kein Timeout ausgelöst.`,
      votekickCanceled: "Votekick abgebrochen.",
      votekickChanged: "Der Votekick wurde inzwischen ersetzt. Bitte prüfe den aktuellen Stand.",
      votekickCancelFailed: "Votekick konnte nicht abgebrochen werden.",
      nextUp: "Als Nächstes",
      noUpcomingItems: "Noch nichts geplant.",
      nextAdBreak: "Nächste Werbepause",
      adDuration: (duration) => `Werbepause · ${duration} s`,
      adSnooze: "Verschieben",
      adSnoozed: "Werbepause verschoben.",
      adSnoozeFailed: "Werbepause konnte nicht verschoben werden.",
      adSnoozeRetryAfter: (time) => `Erneut möglich ab ${time}.`,
      adSnoozeUnavailable: "Werbepause lässt sich nicht weiter verschieben.",
      events: "Ereignisse",
      eventsFilterLabel: "Ereignisse filtern",
      eventsAll: "Alle",
      eventsRaids: "Raids",
      eventsCommunity: "Community",
      eventsChat: "Chat",
      eventsSearch: "Person oder Ereignis suchen",
      eventsEmpty: "Noch keine Ereignisse.",
      eventsUnavailable: "Ereignisse konnten nicht geladen werden.",
      eventsLoading: "Ereignisse werden geladen.",
      raidShoutout: "Shoutout senden",
      raidShoutoutSent: "Shoutout gesendet.",
      raidShoutoutFailed: "Shoutout konnte nicht gesendet werden.",
      statusIndicators: "Verbindungsstatus",
      systemStatus: "Systemstatus",
      systemStatusDescription: (health) => `Systemstatus: ${health}`,
      systemReady: "Alles bereit",
      liveDataCurrent: "Live-Daten aktuell",
      locationMissing: "Standort fehlt",
      locationMissingDescription: "Wetter, Sonnenzeiten und Mondphase brauchen einen Kanalstandort.",
      configureLocation: "Einrichten",
      belaboxWeak: "BELABOX-Verbindung schwach",
      belaboxWeakDescription: (bitrate) => `Aktuelle Bitrate: ${bitrate} kbit/s.`,
      openBelabox: "BELABOX öffnen",
      actionDraftDiscardTitle: "Eingaben verwerfen?",
      actionDraftDiscardDescription: "Deine Eingaben gehen verloren, wenn du diese Aktion schließt.",
      actionDraftDiscard: "Eingaben verwerfen",
      actionDraftContinue: "Weiter bearbeiten",
    },
    channelControls: {
      controlsHeading: "Kanalsteuerung",
      inactive: "Inaktiv",
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
      refreshFailure: "Die Kanalsteuerung wurde geändert, aber ihr Status konnte nicht aktualisiert werden.",
    },
    commandPalette: {
      title: "Seite suchen",
      description: "Finde eine Seite im Bedienpanel.",
      placeholder: "Suchen oder Aktion ausführen …",
      navigateHint: "navigieren",
      openHint: "öffnen",
      empty: "Keine Treffer.",
      groupRecentTargets: "Zuletzt besucht",
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
      streamLive: (duration) => duration === null ? "Live" : `Live · ${duration} h`,
      streamOffline: "Offline",
      streamUnknown: "Status unknown",
      streamChecked: (relativeTime) => `State checked ${relativeTime}`,
      locationMenu: {
        openIn: "Open in",
        openStreetMap: "OpenStreetMap",
        googleMaps: "Google Maps",
        appleMaps: "Apple Maps",
        copyCoordinates: "Copy coordinates",
        coordinatesCopied: "Coordinates copied",
        copyCoordinatesFailed: "Coordinates could not be copied.",
      },
    },
    status: {
      connected: "Connected", revoked: "Revoked", error: "Error", loginIdentityMissing: "Login identity missing",
      notChecked: "Not checked", expired: "Expired", refreshing: "updating", maintenanceOverdue: "Maintenance overdue",
      renewalOverdue: "Renewal overdue", valid: "Valid", moderatorRoleMissing: "Moderator role missing",
      chatSubscriptionError: "Chat subscription error", chatSubscriptionRevoked: "Chat subscription revoked", botError: "Bot error",
      botTokenRevoked: "Bot token revoked", broadcasterConsentMissing: "Broadcaster consent missing",
      chatSubscriptionMissing: "Chat subscription missing", chatSubscriptionNotNeeded: "Not needed — no active module reads chat.", healthy: "Healthy", stateIncomplete: "Incomplete status",
      notConnected: "Not connected", notSetUp: "Not set up", moderator: "Moderator", missing: "Missing", active: "Active",
      pending: "Pending", present: "Present",
      botPermissionsMissing: (count) => `${count} missing`,
    },
    navigation: {
      mainNavigation: "Main navigation", overview: "Overview", live: "Live", setup: "Setup", channel: "Channel", system: "System", locationWeather: "Location & weather",
      members: "Members", variables: "Variables", module: "Modules", events: "Events", audit: "Log", selectChannel: "Select channel",
      accountMenu: "Account", appearance: "Appearance", appearanceNightShift: "Night shift", appearanceIndigoNight: "Indigo night",
      manageModules: "Manage modules", moduleCategories: { chat: "Chat", participation: "Participation", twitch: "Twitch", data: "Data", stream: "Stream", admin: "Administration" },
      overlays: "Overlays",
      overlaysChecking: "Checking …",
      signingOut: "Signing out …", signOut: "Sign out",
      openSidebar: "Open sidebar", closeSidebar: "Close sidebar",
      sidebarSetupHeading: "Setup", sidebarSetupDescription: "Everything for your stream.", sidebarSearch: "Search everything", moduleOff: "Off",
    },
    overview: {
      oneChannelAvailable: "1 channel available",
      channelsAvailableShort: (count) => `${count} channels available`,
      noChannelAvailable: "No channel available yet", noMembership: "This account is not a member of an available channel.",
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
      botPermissionsOperator: "The operator must authorize the application again.",
      botPermissionsComplete: "All requested bot permissions are present.",
    },
    errors: {
      title: "Error", warning: "Warning", sessionInvalid: "Your session is no longer valid.", dataLoadFailed: "The data could not be loaded.",
      changeFailed: "The change failed.",
      last: "Last error", noCause: "No saved cause",
    },
    statusCard: {
      broadcasterOauth: "Broadcaster OAuth", chatConsent: "Chat consent", botAccount: "Bot account", botPermissions: "Bot permissions",
      moderatorStatus: "Moderator status", chatSubscription: "Chat subscription", tokenStatus: "Token status",
      requestChannelBotConsent: "Allow chat access",
      channelBotConsentLocked: "Only the Twitch channel owner can grant this consent.",
      channelBotConsentMissing: "The bot cannot write in chat yet.",
    },
    time: {
      updated: (relativeTime) => `updated ${relativeTime}`, secondsAgo: (count) => `${String(count)} sec ago`,
      minutesAgo: (count) => `${String(count)} min ago`, hoursAgo: (count) => `${String(count)} hr ago`,
    },
    system: {
      title: "System", readOnly: "Channel defaults and technical system status", loadState: "Loading system status …", properties: "Properties",
      botReason: "Bot reason", botUpdated: "Bot last updated", chatSubscriptionId: "Chat subscription ID", chatSubscriptionReason: "Chat subscription reason",
      chatSubscriptionUpdated: "Chat subscription last updated", loginStatus: "Login token status", loginReason: "Login token reason",
      loginValidUntil: "Login token valid until", botValidUntil: "Bot token valid until",
      subscriptions: "Subscriptions", noSubscriptions: "No subscriptions saved.", subscription: "Subscription", state: "State", reason: "Reason",
      subscriptionDetails: "Subscription details", subscriptionRawType: "Raw type", subscriptionVersion: "Version", subscriptionId: "Subscription ID", subscriptionUpdated: "Last changed",
      twitchMessage: "Twitch message", httpStatus: "HTTP status", missingBotPermissions: "Missing bot permissions", missingScopes: "Missing scopes",
    },
    audit: {
      title: "Audit log", entries: "entries", who: "Who", systemActor: "Automated system",
      load: "Loading audit log …", loadError: "The audit log could not be loaded.", empty: "No audit entries saved yet.", changeData: "Change data",
      before: "Before", after: "After", olderEntries: "Load older entries", loaded: "loaded", loadingOlderEntries: "Loading older entries …",
      yes: "Yes", no: "No", newValue: "new", removedValue: "removed",
      changedTruncated: "changed (text longer than preview)", changesHeading: "Changes",
      sentenceTemplates: {
        "channel.released": ({ actor, object }) => `${actor} released channel ${object}`,
        "channel.time_zone.updated": ({ actor, object, from, to }) => `${actor} changed the time zone for ${object} from ${from ?? "—"} to ${to ?? "—"}`,
        "channel.default_chat_target.updated": ({ actor, object, from, to }) => `${actor} changed the default chat target for ${object} from ${from ?? "—"} to ${to ?? "—"}`,
        "channel.location.updated": ({ actor, object, from, to }) => `${actor} changed the location for ${object} from ${from ?? "—"} to ${to ?? "—"}`,
        "channel.full_consent_changed": ({ actor, object, from, to }) => `${actor} changed full consent for ${object} from ${from ?? "—"} to ${to ?? "—"}`,
        "member.added": ({ actor, object, to }) => `${actor} added ${object}${to === null ? "" : ` as ${to}`}`,
        "member.role_changed": ({ actor, object, from, to }) => `${actor} changed ${object}'s role from ${from ?? "—"} to ${to ?? "—"}`,
        "member.removed": ({ actor, object, from }) => `${actor} removed ${object}${from === null ? "" : ` with the ${from} role`}`,
        "module.enabled": ({ actor, object }) => `${actor} enabled the ${object} module`,
        "module.disabled": ({ actor, object }) => `${actor} disabled the ${object} module`,
        "module.secret.replaced": ({ actor, object }) => `${actor} replaced a secret for ${object}`,
        "module.secret.removed": ({ actor, object }) => `${actor} removed a secret for ${object}`,
        "chat_voting.started": ({ actor }) => `${actor} started a chat vote`,
        "chat_voting.closed": ({ actor }) => `${actor} closed a chat vote`,
        "chat_voting.extended": ({ actor }) => `${actor} extended a chat vote`,
        "chat_voting.template.created": ({ actor, object }) => `${actor} created chat vote template ${object}`,
        "chat_voting.template.updated": ({ actor, object }) => `${actor} updated chat vote template ${object}`,
        "chat_voting.template.deleted": ({ actor, object }) => `${actor} deleted chat vote template ${object}`,
        "text_commands.command.created": ({ actor, object }) => `${actor} created text command ${object}`,
        "text_commands.command.updated": ({ actor, object }) => `${actor} updated text command ${object}`,
        "text_commands.command.removed": ({ actor, object }) => `${actor} removed text command ${object}`,
        "faq.entry.created": ({ actor, object }) => `${actor} created FAQ entry ${object}`,
        "faq.entry.updated": ({ actor, object }) => `${actor} updated FAQ entry ${object}`,
        "faq.entry.removed": ({ actor, object }) => `${actor} removed FAQ entry ${object}`,
        "faq.entry.enabled": ({ actor, object }) => `${actor} enabled FAQ entry ${object}`,
        "faq.entry.disabled": ({ actor, object }) => `${actor} disabled FAQ entry ${object}`,
        "faq.entry.reordered": ({ actor, object }) => `${actor} reordered FAQ entry ${object}`,
        "text_library.block.created": ({ actor, object }) => `${actor} created text block ${object}`,
        "text_library.block.updated": ({ actor, object }) => `${actor} updated text block ${object}`,
        "text_library.block.renamed": ({ actor, from, to, object }) => `${actor} renamed text block ${from ?? object} to ${to ?? object}`,
        "text_library.block.removed": ({ actor, object }) => `${actor} removed text block ${object}`,
        "text_library.category.created": ({ actor, object }) => `${actor} created text category ${object}`,
        "text_library.category.renamed": ({ actor, from, to, object }) => `${actor} renamed text category ${from ?? object} to ${to ?? object}`,
        "text_library.category.removed": ({ actor, object }) => `${actor} removed text category ${object}`,
        "text_library.settings.updated": ({ actor, object, from, to }) => `${actor} changed ${object} settings${from === null || to === null ? "" : ` from ${from} to ${to}`}`,
        "timers.timer.created": ({ actor, object }) => `${actor} created timer ${object}`,
        "timers.timer.updated": ({ actor, object }) => `${actor} updated timer ${object}`,
        "timers.timer.removed": ({ actor, object }) => `${actor} removed timer ${object}`,
        "timers.timer.enabled": ({ actor, object }) => `${actor} enabled timer ${object}`,
        "timers.timer.disabled": ({ actor, object }) => `${actor} disabled timer ${object}`,
        "api_source.source_created": ({ actor, object }) => `${actor} created API source ${object}`,
        "api_source.source_changed": ({ actor, object }) => `${actor} updated API source ${object}`,
        "api_source.source_deleted": ({ actor, object }) => `${actor} deleted API source ${object}`,
        "channel.variable.created": ({ actor, object }) => `${actor} created channel variable ${object}`,
        "channel.variable.renamed": ({ actor, from, to, object }) => `${actor} renamed channel variable ${from ?? object} to ${to ?? object}`,
        "channel.variable.removed": ({ actor, object }) => `${actor} deleted channel variable ${object}`,
        "channel.variable.value_changed": ({ actor, object, from, to }) => `${actor} changed the value of channel variable ${object} from ${from ?? "—"} to ${to ?? "—"}`,
        "ads.commercial_started": ({ actor, object, to }) => `${actor} started ${object}${to === null ? "" : ` for ${to}`}`,
        "clip.created": ({ actor, object }) => `${actor} created ${object}`,
        "channel.mute.enabled": ({ actor, object }) => `${actor} muted ${object}`,
        "channel.mute.disabled": ({ actor, object }) => `${actor} unmuted ${object}`,
        "channel.pause.enabled": ({ actor, object }) => `${actor} paused automatic actions for ${object}`,
        "channel.pause.disabled": ({ actor, object }) => `${actor} resumed automatic actions for ${object}`,
        "votekick.cancelled": ({ actor, object }) => `${actor} cancelled the ballot ${object}`,
        "votekick.timeout_lift_attempted": (parts) => `${parts.actor} attempted to lift the timeout for ${parts.object} (${votekickLiftOutcomeText(parts.outcome, "en")})`,
        "overlay.token.issued": ({ actor, object }) => `${actor} issued ${object}`,
        "overlay.token.revoked": ({ actor, object }) => `${actor} revoked ${object}`,
        "overlay.access.issued": ({ actor, object }) => `${actor} issued ${object}`,
        "overlay.access.revealed": ({ actor, object }) => `${actor} revealed ${object}`,
        "overlay.access.revoked": ({ actor, object }) => `${actor} revoked ${object}`,
        "overlay.access.replaced": ({ actor, object }) => `${actor} replaced ${object}`,
        "overlay.access.removed": ({ actor, object }) => `${actor} removed ${object}`,
        "overlay.created": ({ actor, object }) => `${actor} created overlay ${object}`,
        "overlay.updated": ({ actor, object }) => `${actor} updated overlay ${object}`,
        "overlay.deleted": ({ actor, object }) => `${actor} deleted overlay ${object}`,
        "overlay.legacy.imported": ({ actor, object }) => `${actor} imported legacy overlay link ${object}`,
      },
      sentenceSettingsChanged: (actor, module) => `${actor} changed settings for ${module}`,
      sentenceVariableDescriptionChanged: (actor, object) => `${actor} changed the description of channel variable ${object}`,
      sentenceVariableSettingsChanged: (actor, object) => `${actor} changed settings of channel variable ${object}`,
      sentenceUnknownAction: (actor) => `${actor} performed an unrecognized action`,
      filter: "Filters", person: "Person",
      personHint: "Who performed the action, not who was affected by it.",
      personPlaceholder: "Login or ID, e.g. example_user",
      area: "Area", allAreas: "All areas",
      areaLabels: { module: "Modules", command: "Text commands", member: "Members", channel: "Channel", overlay: "Overlay" },
      activeFilters: "Active filters:", resetFilters: "Reset filters", noMatches: "No entries match the filters.",
    },
    events: {
      title: "Events", count: (count) => `${count} entries`, log: "Event log", time: "Time", event: "Event", module: "Module",
      who: "Who", automatic: "Automatic", info: "Info", error: "Error", notice: "Notice", unknown: "Unknown", timestamp: "Timestamp", operation: "Operation", history: "History", load: "Loading events …", none: "No events logged yet.", detail: "Detail",
      loadOlder: "Load older events", loadingOlder: "Loading older events …",
      filter: "Filters", origin: "Origin", moduleFilter: "Module", allModules: "All modules", tone: "Tone", person: "Person", all: "All",
      channelEvents: "Channel events", moduleDiagnostics: "Module diagnostics", activeFilters: "Active filters:", resetFilters: "Reset filters",
      noMatches: "No events match the filters.",
      feedEnd: "End of the event history reached.",
      realtimeConnecting: "Connecting …", realtimeConnected: "Connected", realtimeReconnecting: "Reconnecting …",
      realtimeOffline: "Offline", realtimeRenewSession: "Renew session", realtimeNew: (count) => `${count} new events`,
      connectionLost: "Connection lost. The events could not be loaded.",
      technicalDetails: "Technical details", copyId: "Copy ID", copied: "Copied",
      trigger: "Trigger", moderator: "Moderator", affectedPerson: "Affected person",
      showCause: (eventLabel) => `Show cause: ${eventLabel}`,
      causeTwitchMessage: (message) => `Twitch: ${message}`,
      causeDetailMessage: (message) => `Details: ${message}`,
    },
    signIn: {
      required: "Sign-in required", explanation: "Sign in with your Twitch account to see available channels.",
      signInWithTwitch: "Sign in with Twitch",
    },
    module: {
      module: "Module", available: "Available modules", load: "Loading modules …",
      managementLocked: "Only broadcasters and managers may change modules.", noneActive: "No modules active.",
      noView: "This active module does not have a panel view yet.", views: "Module views", settingsLoadError: "Module settings could not be loaded.", componentLoadError: "Module content could not be loaded.",
      unsavedChangesTitle: "Unsaved changes",
      unsavedChangesDescription: "You have unsaved module settings. What would you like to do?",
      continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch",
      scopesMissing: (name) => `The module “${name}” is disabled because broadcaster permissions are missing.`,
      requestScopeConsent: "Grant broadcaster permissions",
      scopeConsentLocked: "Only this channel’s broadcaster may grant this consent.",
      scopeList: "Required broadcaster permissions",
      scopeMissing: "Missing",
      scopeGranted: "Granted",
      chatCommands: "Chat commands",
      chatCommandsButtonLabel: (count) => `Chat commands · ${count}`,
      chatCommandArguments: "Arguments",
      chatCommandAvailableTo: "Available in chat to",
      chatCommandCopy: "Copy",
      chatCommandCopied: "Chat command copied.",
      chatCommandCopyFailed: "Chat command could not be copied.",
      chatCommandThresholds: {
        everyone: "everyone",
        subscriber: "subscribers and higher",
        vip: "VIPs, moderators, and broadcasters",
        moderator: "moderators and broadcasters",
        broadcaster: "broadcaster",
        configurable: "in Votekick settings (default: VIP)",
      },
    },
    streamManager: {
      immediateActions: "Immediate actions",
      actionCount: (count) => `${String(count)} ${count === 1 ? "action" : "actions"}`,
      actionRun: "Run",
      actionCancel: "Cancel",
      actionRunning: "Running …",
      actionLoading: "Loading action …",
      actionLoadFailed: "The action could not be loaded.",
      actionAvailabilityFailed: "The action availability could not be checked.",
      actionAvailabilityStale: "Availability check is stale; the action remains available.",
      actionFailed: "The action could not be completed.",
      actionSucceeded: (name) => `${name} completed.`,
      actionErrorActions: {
        commercialScopeNextStep: "Renew the channel:edit:commercial permission for this channel account.",
        commercialCooldown: (remaining) => `The commercial cooldown is active. Try again in ${remaining}.`,
        clipScopeNextStep: "Reconnect the bot account and grant the Twitch clips:edit permission.",
      },
      operatorOnly: "Operators and higher roles may run this action.",
      managerOnly: "Only managers and broadcasters may run this action.",
      broadcasterOnly: "Only broadcasters may run this action.",
      availabilityReasons: {
        stream_offline: "The stream is offline.",
        stream_state_unknown: "The stream status is currently unavailable.",
      },
      runAd: (length) => `Run ad now (${length}s)`,
      createClip: "Create clip",
      sendShoutout: "Send shoutout",
      today: "Today",
      yesterday: "Yesterday",
      browserTimeZoneFallback: "Using browser time zone",
    },
    liveCockpit: {
      live: "Live",
      actionsHint: "Control actions directly during the stream",
      offline: "Offline",
      unknown: "Status unknown",
      duration: "Duration",
      viewers: "Viewers",
      youAre: (role) => `You are: ${role}`,
      roles: { broadcaster: "Broadcaster", manager: "Manager", operator: "Operator" },
      broadcastLoading: "Loading stream title and category.",
      broadcastUnavailable: "Stream title and category are unavailable right now.",
      broadcastEmptyTitle: "No stream title set",
      broadcastNoCategory: "No category",
      broadcastEdit: "Edit title and category",
      broadcastSave: "Save changes",
      broadcastTitleLabel: "Stream title",
      broadcastTitleCount: (count, maximum) => `${String(count)} / ${String(maximum)} characters`,
      broadcastManagerOnly: "Only managers and broadcasters may change the stream title and category.",
      broadcastScopeMissing: "This channel account is missing the Twitch channel:manage:broadcast permission.",
      broadcastReconnect: "Reconnect Twitch access",
      broadcastReconnectOwnerOnly: "Only the broadcaster can renew this Twitch permission.",
      broadcastSaveError: "The stream title and category could not be saved.",
      broadcastIdentityMissing: "This channel's Twitch account is not connected.",
      broadcastSaved: "Stream title and category saved.",
      broadcastGamePicker: {
        label: "Category", hint: "Select one category.", search: "Search categories", searchHint: "Enter at least two characters.",
        loading: "Loading categories.", empty: "No categories found.", error: "Categories could not be loaded.",
        suggestions: "Suggestions", allGames: "Choose a category", limitReached: "Only one category can be selected.",
        selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)} selected`, remove: (name) => `Remove ${name}`,
      },
      bot: "Bot",
      botConnected: "Connected",
      botUnavailable: "Not connected",
      belabox: "BELABOX",
      belaboxDisabled: "Off",
      belaboxChecking: "checking",
      belaboxNotConfigured: "not configured",
      belaboxUnavailable: "unavailable",
      belaboxDisconnected: "disconnected",
      belaboxConnected: (bitrate) => `connected · ${bitrate} kbps`,
      overlays: "Overlays",
      overlaysCount: (count) => `${count} active`,
      overlaysNotSetUp: "Not set up",
      overlaysChecking: "checking",
      runningNow: "Running now",
      liveDataLoading: "Loading live data.",
      liveDataUnavailable: "Live data is unavailable right now.",
      noActionRunning: "No action is running.",
      voteType: "Vote",
      votekickType: "Votekick",
      voteEndsIn: (time) => `${time} left`,
      voteTotal: (count) => `${count} votes total`,
      voteOptionCount: (count, percent) => `${count} votes · ${percent}%`,
      voteExtend: "+30 s",
      voteEnd: "End",
      voteExtended: "Vote extended by 30 seconds.",
      voteExtensionUnavailable: "This vote cannot be extended further.",
      voteChanged: "This vote has been replaced. Check the current vote and try again.",
      voteEnded: "Vote ended.",
      voteEndFailed: "The vote could not be ended.",
      votekickVotes: (yes, no, threshold) => `Yes ${yes} · No ${no} · Threshold ${threshold}`,
      votekickCancel: "Cancel votekick",
      votekickCancelTitle: "Cancel votekick?",
      votekickCancelDescription: (target) => `The vote against ${target} ends now. No timeout will be applied.`,
      votekickCanceled: "Votekick canceled.",
      votekickChanged: "This votekick has been replaced. Check the current vote and try again.",
      votekickCancelFailed: "The votekick could not be canceled.",
      nextUp: "Coming up",
      noUpcomingItems: "Nothing scheduled yet.",
      nextAdBreak: "Next ad break",
      adDuration: (duration) => `Ad break · ${duration}s`,
      adSnooze: "Snooze",
      adSnoozed: "Ad break postponed.",
      adSnoozeFailed: "The ad break could not be postponed.",
      adSnoozeRetryAfter: (time) => `Try again after ${time}.`,
      adSnoozeUnavailable: "This ad break cannot be postponed again.",
      events: "Events",
      eventsFilterLabel: "Filter events",
      eventsAll: "All",
      eventsRaids: "Raids",
      eventsCommunity: "Community",
      eventsChat: "Chat",
      eventsSearch: "Search people or events",
      eventsEmpty: "No events yet.",
      eventsUnavailable: "Events could not be loaded.",
      eventsLoading: "Loading events.",
      raidShoutout: "Send shoutout",
      raidShoutoutSent: "Shoutout sent.",
      raidShoutoutFailed: "The shoutout could not be sent.",
      statusIndicators: "Connection status",
      systemStatus: "System status",
      systemStatusDescription: (health) => `System status: ${health}`,
      systemReady: "All systems ready",
      liveDataCurrent: "Live data up to date",
      locationMissing: "Location missing",
      locationMissingDescription: "Weather, sunrise and moon data need a channel location.",
      configureLocation: "Set up",
      belaboxWeak: "BELABOX connection is weak",
      belaboxWeakDescription: (bitrate) => `Current bitrate: ${bitrate} kbps.`,
      openBelabox: "Open BELABOX",
      actionDraftDiscardTitle: "Discard your changes?",
      actionDraftDiscardDescription: "Your entries will be lost if you close this action.",
      actionDraftDiscard: "Discard entries",
      actionDraftContinue: "Continue editing",
    },
    channelControls: {
      controlsHeading: "Channel controls",
      inactive: "Inactive",
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
      refreshFailure: "The channel control changed, but its status could not be refreshed.",
    },
    commandPalette: {
      title: "Search pages",
      description: "Find a page in the dashboard.",
      placeholder: "Search or run action …",
      navigateHint: "navigate",
      openHint: "open",
      empty: "No matches.",
      groupRecentTargets: "Recently visited",
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

const votekickRejectionReasonText = (reason: unknown, language: DashboardLanguage, minimumRole: unknown): string => {
  const roleLabels: LocaleCatalog<Record<ModuleChatStatus, string>> = {
    de: { viewer: "Zuschauer", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    en: { viewer: "viewers", subscriber: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcasters" },
  };
  if (reason === "starter_not_authorized" && typeof minimumRole === "string" && Object.hasOwn(roleLabels[language], minimumRole)) {
    const role = roleLabels[language][minimumRole as ModuleChatStatus];
    if (minimumRole === "broadcaster") return language === "de"
      ? "Nur Broadcaster dürfen eine Abstimmung starten."
      : "Only broadcasters can start a ballot.";
    return language === "de"
      ? `Nur ${role} und höhere Rollen dürfen eine Abstimmung starten.`
      : `Only ${role} and higher roles can start a ballot.`;
  }
  const reasons: LocaleCatalog<Record<string, string>> = {
    de: {
      busy: "Es läuft bereits eine Abstimmung.",
      channel_cooldown: "Die kanalweite Abklingzeit läuft noch.",
      target_cooldown: "Für dieses Ziel läuft die Abklingzeit noch.",
      lookup_failure: "Die erforderlichen Kanaldaten waren nicht verfügbar.",
      target_unresolvable: "Das Zielkonto wurde nicht gefunden.",
      target_protected: "Das Ziel kann nicht abgestimmt werden.",
      target_not_active: "Das Ziel war kürzlich nicht im Chat aktiv.",
      starter_not_authorized: "Die eingestellte Mindestrolle erlaubt diesen Start nicht.",
    },
    en: {
      busy: "A ballot is already running.",
      channel_cooldown: "The channel cooldown is still active.",
      target_cooldown: "The target cooldown is still active.",
      lookup_failure: "Required channel data was unavailable.",
      target_unresolvable: "The target account could not be found.",
      target_protected: "This target cannot be voted against.",
      target_not_active: "The target has not been active in chat recently.",
      starter_not_authorized: "The configured minimum role does not allow this start.",
    },
  };
  return typeof reason === "string" ? reasons[language][reason] ?? (language === "de" ? "Unbekannter Grund" : "Unknown reason")
    : language === "de" ? "Unbekannter Grund" : "Unknown reason";
};

const votekickLiftOutcomeText = (outcome: string | null | undefined, language: DashboardLanguage): string => {
  const outcomes: LocaleCatalog<Record<string, string>> = {
    de: { applied: "Timeout aufgehoben", rejected: "nicht aufgehoben", ambiguous: "Ausgang unklar" },
    en: { applied: "timeout lifted", rejected: "not lifted", ambiguous: "outcome unclear" },
  };
  return outcome === undefined || outcome === null
    ? language === "de" ? "Ergebnis unbekannt" : "outcome unknown"
    : outcomes[language][outcome] ?? (language === "de" ? "Ergebnis unbekannt" : "outcome unknown");
};

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

const moderationFailureTexts: LocaleCatalog<Record<ModerationFailureReason, string>> = {
  de: {
    already_banned: "Ziel ist bereits gebannt",
    bot_identity_missing: "Bot-Identität fehlt",
    conflict: "gleichzeitige Moderationsänderung",
    invalid_request: "ungültige Moderationsanfrage",
    network_error: "Netzwerkfehler bei Twitch",
    not_moderator: "Bot ist kein Moderator in diesem Kanal",
    protected_target: "geschütztes Ziel",
    rate_limited: "Twitch-Abklingzeit aktiv",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    token_invalid: "Bot-Token ungültig",
    twitch_error: "Twitch hat die Moderationsanfrage abgelehnt",
  },
  en: {
    already_banned: "Target is already banned",
    bot_identity_missing: "Bot identity is missing",
    conflict: "Concurrent moderation change",
    invalid_request: "Invalid moderation request",
    network_error: "Network error from Twitch",
    not_moderator: "The bot is not a moderator in this channel",
    protected_target: "Protected target",
    rate_limited: "Twitch cooldown is active",
    timeout: "The Twitch request timed out",
    token_invalid: "Bot token is invalid",
    twitch_error: "Twitch rejected the moderation request",
  },
};

const moderationFailureReasonText = (reason: unknown, language: DashboardLanguage): string | null =>
  typeof reason === "string" && Object.hasOwn(moderationFailureTexts[language], reason)
    ? moderationFailureTexts[language][reason as ModerationFailureReason]
    : null;

const commercialFailureTexts: LocaleCatalog<Record<CommercialFailureReason, string>> = {
  de: {
    app_token_unavailable: "App-Token nicht verfügbar",
    network_error: "Netzwerkfehler bei Twitch",
    rate_limited: "Twitch-Abklingzeit aktiv",
    scope_missing: "Berechtigung für Werbeeinblendungen fehlt",
    stream_offline: "Stream ist offline",
    token_invalid: "Twitch-Token ist ungültig",
    timeout: "Twitch-Anfrage hat zu lange gedauert",
    twitch_error: "Twitch hat den Start abgelehnt",
  },
  en: {
    app_token_unavailable: "App token unavailable",
    network_error: "Network error from Twitch",
    rate_limited: "Twitch cooldown is active",
    scope_missing: "Permission to run commercials is missing",
    stream_offline: "The stream is offline",
    token_invalid: "The Twitch token is invalid",
    timeout: "The Twitch request timed out",
    twitch_error: "Twitch rejected the request",
  },
};

export const commercialFailureReasonText = (reason: unknown, language: DashboardLanguage): string =>
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

export const clipFailureReasonText = (reason: unknown, language: DashboardLanguage): string | null =>
  typeof reason === "string" ? catalogString(clipFailureTexts[language], reason) ?? null : null;

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
  "host.timeout.failed": moderationFailureTexts,
  "host.ban.failed": moderationFailureTexts,
  "host.timeout.ambiguous": moderationFailureTexts,
  "host.ban.ambiguous": moderationFailureTexts,
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
  const moderationCode = code === "host.timeout.failed" || code === "host.ban.failed" ||
    code === "host.timeout.ambiguous" || code === "host.ban.ambiguous";
  const raw = moderationCode
    ? detail.cause ?? detail.reason ?? detail.twitchMessage ?? detail.message
    : detail.reason ?? detail.cause ?? detail.twitchMessage ?? detail.message;
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
  (code === "host.shoutout.failed" && shoutoutFailureReasonText(detail.cause) !== null) ||
  ((code === "host.timeout.failed" || code === "host.ban.failed") && moderationFailureReasonText(detail.cause, "en") !== null);

export const eventTexts: LocaleCatalog<Record<EventCode, EventText>> = {
  de: {
    "host.action.failed": "Aktion fehlgeschlagen",
    "host.action.suppressed": (detail) => `Aktion unterdrückt: ${detail.action === "chat" ? "Chatnachricht" : detail.action === "announcement" ? "Ankündigung" : detail.action === "timeout" ? "Timeout" : detail.action === "ban" ? "Bann" : "Shoutout"} ${detail.reason === "module_disabled" ? "weil das Modul deaktiviert ist" : detail.reason === "channel_paused" ? "wegen Kanalpause" : "wegen Kanal-Stummschaltung"}`,
    "host.chat.failed": "Chat-Nachricht fehlgeschlagen",
    "host.chat.sent": "Chat-Nachricht gesendet",
    "host.chat.skipped": (detail) => detail.reason === "automated_output_rate_limited"
      ? "Automatische Chat-Ausgabe wegen des 5-Sekunden-Limits übersprungen"
      : detail.reason === "stale_before_send"
        ? "Chat-Nachricht übersprungen: Zeitplan hat sich in letzter Sekunde geändert"
        : "Chat-Nachricht vor dem Senden übersprungen",
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
    "host.timeout.applied": (detail) => `Timeout für ${detailText(detail, "target", "unbekannte ID")} angewendet (${detailNumber(detail, "seconds", "unbekannte Dauer")} s)`,
    "host.timeout.failed": (detail) => `Timeout für ${detailText(detail, "target", "unbekannte ID")} fehlgeschlagen: ${eventCauseText("host.timeout.failed", detail, "de") ?? "unbekannter Grund"}`,
    "host.timeout.ambiguous": (detail) => `Ausgang des Timeouts für ${detailText(detail, "target", "unbekannte ID")} unklar`,
    "host.ban.applied": (detail) => `Bann für ${detailText(detail, "target", "unbekannte ID")} angewendet`,
    "host.ban.failed": (detail) => `Bann für ${detailText(detail, "target", "unbekannte ID")} fehlgeschlagen: ${eventCauseText("host.ban.failed", detail, "de") ?? "unbekannter Grund"}`,
    "host.ban.ambiguous": (detail) => `Ausgang des Banns für ${detailText(detail, "target", "unbekannte ID")} unklar`,
    "host.clip.failed": "Clip fehlgeschlagen",
    "belabox.fetch_failing": "BELABOX-Abruf fehlgeschlagen",
    "belabox.fetch_recovered": "BELABOX-Abruf wiederhergestellt",
    "belabox.alert_started": (detail) => `BELABOX-Alarm: ${detail.kind === "disconnect" ? "Encoder getrennt" : "Bitrate niedrig"} (${detailNumber(detail, "threshold", "?")} kbps, ${detailNumber(detail, "seconds", "?")} s)`,
    "belabox.alert_escalated": (detail) => `BELABOX-Alarm eskaliert: Encoder getrennt (${detailNumber(detail, "threshold", "?")} kbps)`,
    "belabox.alert_recovered": (detail) => `BELABOX-Verbindung erholt (${detail.kind === "disconnect" ? "Encoder" : "Bitrate"}, ${detailNumber(detail, "seconds", "?")} s)`,
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
    "votekick.rejected": (detail) => `Votekick abgelehnt: ${votekickRejectionReasonText(detail.reason, "de", detail.minimumRole)}`,
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
    "text_commands.game_filter": (detail) => eventTextWithName(detail, "Befehl durch Spiel-Filter unterdrückt", (name) => `Befehl !${name} unterdrückt: anderes Spiel`),
    "text_commands.game_unknown": (detail) => eventTextWithName(detail, "Spiel unbekannt; Filter übersprungen", (name) => `Befehl !${name} ausgeführt: aktuelles Spiel unbekannt, Filter übersprungen`),
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
    "host.action.suppressed": (detail) => `Action suppressed: ${detail.action === "chat" ? "chat message" : detail.action === "announcement" ? "announcement" : detail.action === "timeout" ? "timeout" : detail.action === "ban" ? "ban" : "shoutout"} ${detail.reason === "module_disabled" ? "because the module is disabled" : detail.reason === "channel_paused" ? "while the channel is paused" : "while the channel is muted"}`,
    "host.chat.failed": "Chat message failed",
    "host.chat.sent": "Chat message sent",
    "host.chat.skipped": (detail) => detail.reason === "automated_output_rate_limited"
      ? "Automated chat output skipped by the five-second channel limit"
      : detail.reason === "stale_before_send"
        ? "Chat message skipped: schedule changed at the last moment"
        : "Chat message skipped before sending",
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
    "host.timeout.applied": (detail) => `Timeout applied to ${detailText(detail, "target", "unknown ID")} (${detailNumber(detail, "seconds", "unknown duration")} s)`,
    "host.timeout.failed": (detail) => `Timeout failed for ${detailText(detail, "target", "unknown ID")}: ${eventCauseText("host.timeout.failed", detail, "en") ?? "unknown reason"}`,
    "host.timeout.ambiguous": (detail) => `Timeout outcome for ${detailText(detail, "target", "unknown ID")} is unclear`,
    "host.ban.applied": (detail) => `Ban applied to ${detailText(detail, "target", "unknown ID")}`,
    "host.ban.failed": (detail) => `Ban failed for ${detailText(detail, "target", "unknown ID")}: ${eventCauseText("host.ban.failed", detail, "en") ?? "unknown reason"}`,
    "host.ban.ambiguous": (detail) => `Ban outcome for ${detailText(detail, "target", "unknown ID")} is unclear`,
    "host.clip.failed": "Clip failed",
    "belabox.fetch_failing": "BELABOX fetch failing",
    "belabox.fetch_recovered": "BELABOX fetch recovered",
    "belabox.alert_started": (detail) => `BELABOX alert: ${detail.kind === "disconnect" ? "encoder disconnected" : "bitrate low"} (${detailNumber(detail, "threshold", "?")} kbps, ${detailNumber(detail, "seconds", "?")} s)`,
    "belabox.alert_escalated": (detail) => `BELABOX alert escalated: encoder disconnected (${detailNumber(detail, "threshold", "?")} kbps)`,
    "belabox.alert_recovered": (detail) => `BELABOX connection recovered (${detail.kind === "disconnect" ? "encoder" : "bitrate"}, ${detailNumber(detail, "seconds", "?")} s)`,
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
    "votekick.rejected": (detail) => `Votekick rejected: ${votekickRejectionReasonText(detail.reason, "en", detail.minimumRole)}`,
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
    "text_commands.game_filter": (detail) => eventTextWithName(detail, "Command suppressed by game filter", (name) => `Command !${name} suppressed: current game is not selected`),
    "text_commands.game_unknown": (detail) => eventTextWithName(detail, "Game unknown; filter skipped", (name) => `Command !${name} ran: current game unknown, filter skipped`),
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

type EventFamily = "community" | "raid" | "moderation" | "operations";
type EventTier = "full" | "outlined";
export type EventNumberKey = "viewers" | "count" | "duration" | "seconds" | "remainingSeconds" | "tier" | null;
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
  "host.timeout.applied": { family: "operations", tier: "outlined", word: { de: "Auszeit", en: "Timeout" }, numberKey: "seconds", tone: "info" },
  "host.timeout.failed": { family: "operations", tier: "outlined", word: { de: "Auszeit", en: "Timeout" }, numberKey: "seconds", tone: "error" },
  "host.timeout.ambiguous": { family: "operations", tier: "outlined", word: { de: "Auszeit", en: "Timeout" }, numberKey: "seconds", tone: "warning" },
  "host.ban.applied": { family: "operations", tier: "outlined", word: { de: "Bann", en: "Ban" }, numberKey: null, tone: "info" },
  "host.ban.failed": { family: "operations", tier: "outlined", word: { de: "Bann", en: "Ban" }, numberKey: null, tone: "error" },
  "host.ban.ambiguous": { family: "operations", tier: "outlined", word: { de: "Bann", en: "Ban" }, numberKey: null, tone: "warning" },
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
  "votekick.rejected": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
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
  "belabox.fetch_failing": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "belabox.fetch_recovered": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "belabox.alert_started": { family: "operations", tier: "outlined", word: { de: "Warnung", en: "Warning" }, numberKey: null, tone: "warning" },
  "belabox.alert_escalated": { family: "operations", tier: "outlined", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "belabox.alert_recovered": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: "seconds", tone: "info" },
  "text_commands.cooldown": { family: "operations", tier: "outlined", word: { de: "Hinweis", en: "Notice" }, numberKey: "remainingSeconds", tone: "warning" },
  "text_commands.user_cooldown": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: "remainingSeconds", tone: "info" },
  "text_commands.stream_state": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.game_filter": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.game_unknown": { family: "operations", tier: "outlined", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
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
    "channel.time_zone.updated": "Kanalzeitzone geändert",
    "channel.default_chat_target.updated": "Standard-Chat-Ziel geändert",
    "channel.location.updated": "Kanalstandort geändert",
    "member.added": "Mitglied hinzugefügt",
    "member.role_changed": "Mitgliedsrolle geändert",
    "member.removed": "Mitglied entfernt",
    "module.enabled": "Modul aktiviert",
    "module.disabled": "Modul deaktiviert",
    "module.secret.replaced": "Modulgeheimnis ersetzt",
    "module.secret.removed": "Modulgeheimnis entfernt",
    "chat_voting.started": "Abstimmung gestartet",
    "chat_voting.closed": "Abstimmung geschlossen",
    "chat_voting.extended": "Abstimmung verlängert",
    "chat_voting.template.created": "Abstimmungsvorlage erstellt",
    "chat_voting.template.updated": "Abstimmungsvorlage geändert",
    "chat_voting.template.deleted": "Abstimmungsvorlage gelöscht",
    "text_commands.command.created": "Textbefehl erstellt",
    "text_commands.command.updated": "Textbefehl aktualisiert",
    "text_commands.command.removed": "Textbefehl entfernt",
    "faq.entry.created": "FAQ-Eintrag erstellt",
    "faq.entry.updated": "FAQ-Eintrag geändert",
    "faq.entry.removed": "FAQ-Eintrag entfernt",
    "faq.entry.enabled": "FAQ-Eintrag aktiviert",
    "faq.entry.disabled": "FAQ-Eintrag deaktiviert",
    "faq.entry.reordered": "FAQ-Eintrag umsortiert",
    "text_library.block.created": "Textbaustein erstellt",
    "text_library.block.updated": "Textbaustein aktualisiert",
    "text_library.block.renamed": "Textbaustein umbenannt",
    "text_library.block.removed": "Textbaustein entfernt",
    "text_library.category.created": "Textkategorie erstellt",
    "text_library.category.renamed": "Textkategorie umbenannt",
    "text_library.category.removed": "Textkategorie entfernt",
    "text_library.settings.updated": "Textbibliothekseinstellungen geändert",
    "timers.timer.created": "Timer erstellt",
    "timers.timer.updated": "Timer geändert",
    "timers.timer.removed": "Timer entfernt",
    "timers.timer.enabled": "Timer aktiviert",
    "timers.timer.disabled": "Timer deaktiviert",
    "api_source.source_created": "API-Quelle erstellt",
    "api_source.source_changed": "API-Quelle geändert",
    "api_source.source_deleted": "API-Quelle gelöscht",
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
    "votekick.cancelled": "Votekick abgebrochen",
    "votekick.timeout_lift_attempted": "Votekick-Timeout-Aufhebung versucht",
    "overlay.token.issued": "Overlay-Token ausgestellt",
    "overlay.token.revoked": "Overlay-Token widerrufen",
    "overlay.access.issued": "Overlay-Zugang ausgestellt",
    "overlay.access.revealed": "Overlay-Zugang angezeigt",
    "overlay.access.revoked": "Overlay-Zugang widerrufen",
    "overlay.access.replaced": "Overlay-Zugang ersetzt",
    "overlay.access.removed": "Overlay-Zugang entfernt",
    "overlay.created": "Overlay erstellt",
    "overlay.updated": "Overlay geändert",
    "overlay.deleted": "Overlay gelöscht",
    "overlay.legacy.imported": "Alter Overlay-Link importiert",
  },
  en: {
    "channel.released": "Channel released",
    "channel.full_consent_changed": "Full consent changed",
    "channel.time_zone.updated": "Channel time zone changed",
    "channel.default_chat_target.updated": "Default chat target changed",
    "channel.location.updated": "Channel location changed",
    "member.added": "Member added",
    "member.role_changed": "Member role changed",
    "member.removed": "Member removed",
    "module.enabled": "Module enabled",
    "module.disabled": "Module disabled",
    "module.secret.replaced": "Module secret replaced",
    "module.secret.removed": "Module secret removed",
    "chat_voting.started": "Vote started",
    "chat_voting.closed": "Vote closed",
    "chat_voting.extended": "Vote extended",
    "chat_voting.template.created": "Vote template created",
    "chat_voting.template.updated": "Vote template updated",
    "chat_voting.template.deleted": "Vote template deleted",
    "text_commands.command.created": "Text command created",
    "text_commands.command.updated": "Text command updated",
    "text_commands.command.removed": "Text command removed",
    "faq.entry.created": "FAQ entry created",
    "faq.entry.updated": "FAQ entry updated",
    "faq.entry.removed": "FAQ entry removed",
    "faq.entry.enabled": "FAQ entry enabled",
    "faq.entry.disabled": "FAQ entry disabled",
    "faq.entry.reordered": "FAQ entry reordered",
    "text_library.block.created": "Text block created",
    "text_library.block.updated": "Text block updated",
    "text_library.block.renamed": "Text block renamed",
    "text_library.block.removed": "Text block removed",
    "text_library.category.created": "Text category created",
    "text_library.category.renamed": "Text category renamed",
    "text_library.category.removed": "Text category removed",
    "text_library.settings.updated": "Text library settings changed",
    "timers.timer.created": "Timer created",
    "timers.timer.updated": "Timer updated",
    "timers.timer.removed": "Timer removed",
    "timers.timer.enabled": "Timer enabled",
    "timers.timer.disabled": "Timer disabled",
    "api_source.source_created": "API source created",
    "api_source.source_changed": "API source updated",
    "api_source.source_deleted": "API source deleted",
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
    "votekick.cancelled": "Votekick cancelled",
    "votekick.timeout_lift_attempted": "Votekick timeout lift attempted",
    "overlay.token.issued": "Overlay token issued",
    "overlay.token.revoked": "Overlay token revoked",
    "overlay.access.issued": "Overlay access issued",
    "overlay.access.revealed": "Overlay access revealed",
    "overlay.access.revoked": "Overlay access revoked",
    "overlay.access.replaced": "Overlay access replaced",
    "overlay.access.removed": "Overlay access removed",
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
): string => catalogString(auditActionTexts[language], action) ?? auditUnknownActionLabel(language);

export const auditUnknownActionLabel = (language: DashboardLanguage = dashboardLanguage()): string =>
  language === "de" ? "Unbekannte Aktion" : "Unknown action";

const auditObjectFallbacks: LocaleCatalog<Partial<Record<AuditAction, string>>> = {
  de: {
    "channel.released": "Kanal", "channel.full_consent_changed": "Kanal", "channel.time_zone.updated": "Kanal", "channel.default_chat_target.updated": "Kanal", "channel.location.updated": "Kanal",
    "member.added": "Mitglied", "member.role_changed": "Mitglied", "member.removed": "Mitglied",
    "chat_voting.template.created": "Abstimmungsvorlage", "chat_voting.template.updated": "Abstimmungsvorlage", "chat_voting.template.deleted": "Abstimmungsvorlage",
    "module.enabled": "Modul", "module.disabled": "Modul",
    "module.secret.replaced": "Modulgeheimnis", "module.secret.removed": "Modulgeheimnis",
    "text_commands.command.created": "Textbefehl", "text_commands.command.updated": "Textbefehl", "text_commands.command.removed": "Textbefehl",
    "text_library.block.created": "Textbaustein", "text_library.block.updated": "Textbaustein", "text_library.block.renamed": "Textbaustein", "text_library.block.removed": "Textbaustein",
    "text_library.category.created": "Textkategorie", "text_library.category.renamed": "Textkategorie", "text_library.category.removed": "Textkategorie", "text_library.settings.updated": "Textbibliothek",
    "timers.timer.created": "Timer", "timers.timer.updated": "Timer", "timers.timer.removed": "Timer", "timers.timer.enabled": "Timer", "timers.timer.disabled": "Timer",
    "api_source.source_created": "API-Quelle", "api_source.source_changed": "API-Quelle", "api_source.source_deleted": "API-Quelle",
    "channel.variable.created": "Kanalvariable", "channel.variable.renamed": "Kanalvariable", "channel.variable.removed": "Kanalvariable", "channel.variable.value_changed": "Kanalvariable",
    "ads.commercial_started": "die Werbepause", "clip.created": "den Clip",
    "channel.mute.enabled": "den Kanal", "channel.mute.disabled": "den Kanal", "channel.pause.enabled": "den Kanal", "channel.pause.disabled": "den Kanal",
    "votekick.cancelled": "den Votekick", "votekick.timeout_lift_attempted": "den Votekick",
    "overlay.token.issued": "den Overlay-Token", "overlay.token.revoked": "den Overlay-Token",
    "overlay.access.issued": "den Overlay-Zugang", "overlay.access.revealed": "den Overlay-Zugang", "overlay.access.revoked": "den Overlay-Zugang", "overlay.access.replaced": "den Overlay-Zugang", "overlay.access.removed": "den Overlay-Zugang",
    "overlay.created": "Overlay", "overlay.updated": "Overlay", "overlay.deleted": "Overlay", "overlay.legacy.imported": "Overlay-Link",
  },
  en: {
    "channel.released": "channel", "channel.full_consent_changed": "channel", "channel.time_zone.updated": "channel", "channel.default_chat_target.updated": "channel", "channel.location.updated": "channel",
    "member.added": "member", "member.role_changed": "member", "member.removed": "member",
    "chat_voting.template.created": "chat vote template", "chat_voting.template.updated": "chat vote template", "chat_voting.template.deleted": "chat vote template",
    "module.enabled": "module", "module.disabled": "module",
    "module.secret.replaced": "module secret", "module.secret.removed": "module secret",
    "text_commands.command.created": "text command", "text_commands.command.updated": "text command", "text_commands.command.removed": "text command",
    "text_library.block.created": "text block", "text_library.block.updated": "text block", "text_library.block.renamed": "text block", "text_library.block.removed": "text block",
    "text_library.category.created": "text category", "text_library.category.renamed": "text category", "text_library.category.removed": "text category", "text_library.settings.updated": "text library",
    "timers.timer.created": "timer", "timers.timer.updated": "timer", "timers.timer.removed": "timer", "timers.timer.enabled": "timer", "timers.timer.disabled": "timer",
    "api_source.source_created": "API source", "api_source.source_changed": "API source", "api_source.source_deleted": "API source",
    "channel.variable.created": "channel variable", "channel.variable.renamed": "channel variable", "channel.variable.removed": "channel variable", "channel.variable.value_changed": "channel variable",
    "ads.commercial_started": "the commercial break", "clip.created": "the clip",
    "channel.mute.enabled": "the channel", "channel.mute.disabled": "the channel", "channel.pause.enabled": "the channel", "channel.pause.disabled": "the channel",
    "votekick.cancelled": "the votekick", "votekick.timeout_lift_attempted": "the votekick",
    "overlay.token.issued": "the overlay token", "overlay.token.revoked": "the overlay token",
    "overlay.access.issued": "the overlay access", "overlay.access.revealed": "the overlay access", "overlay.access.revoked": "the overlay access", "overlay.access.replaced": "the overlay access", "overlay.access.removed": "the overlay access",
    "overlay.created": "overlay", "overlay.updated": "overlay", "overlay.deleted": "overlay", "overlay.legacy.imported": "legacy overlay link",
  },
};

export const auditObjectFallback = (action: string, language: DashboardLanguage = dashboardLanguage()): string => {
  const value = catalogString(auditObjectFallbacks[language], action);
  return value ?? (language === "de" ? "Eintrag" : "item");
};

export const auditSentenceForAction = (
  action: string,
  parts: AuditSentenceParts,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const templates = dashboardTexts(language).audit.sentenceTemplates;
  if (!Object.hasOwn(templates, action)) return dashboardTexts(language).audit.sentenceUnknownAction(parts.actor);
  return templates[action as AuditAction](parts);
};

export const auditSettingsChangedSentence = (
  actor: string,
  module: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => dashboardTexts(language).audit.sentenceSettingsChanged(actor, module);

const memberAsWords: LocaleCatalog<string> = { de: "als", en: "as" };

/** The connector between a member's login and their role in an audit row's subject, e.g. "beispielnutzer als Bediener" (#181). */
export const memberAsWord = (language: DashboardLanguage = dashboardLanguage()): string => memberAsWords[language];

/**
 * Bilingual labels for known audit diff fields. Unknown keys stay opaque so
 * a new storage field cannot leak into either language as a guessed label.
 */
type AuditFieldKey =
  | "role" | "enabled" | "fullConsent" | "revocationReason" | "expiresAt" | "createdAt" | "revokedAt"
  | "length" | "retryAfter" | "clipId" | "tokenId" | "login" | "displayName" | "leadSeconds" | "name"
  | "value" | "description" | "overlayId" | "categoryId" | "timeZone" | "locationName" | "locationTimeZone" | "latitude" | "longitude" | "width" | "height" | "revision" | "elementCount";

const auditFieldLabels: LocaleCatalog<Record<AuditFieldKey, string>> = {
  de: {
    role: "Rolle", enabled: "Aktiv", fullConsent: "Vollzustimmung", revocationReason: "Widerrufsgrund",
    expiresAt: "Gültig bis", createdAt: "Erstellt am", revokedAt: "Widerrufen am", length: "Länge (Sekunden)", retryAfter: "Erneut möglich ab",
    clipId: "Clip-ID", tokenId: "Token-ID", login: "Login", displayName: "Anzeigename", leadSeconds: "Vorlaufzeit",
    name: "Objektname", value: "Wert", description: "Beschreibung", overlayId: "Overlay-ID", categoryId: "Kategorie-ID",
    timeZone: "Kanalzeitzone", locationName: "Standort", locationTimeZone: "Standortzeitzone", latitude: "Breitengrad", longitude: "Längengrad",
    width: "Breite", height: "Höhe", revision: "Revision", elementCount: "Elemente",
  },
  en: {
    role: "Role", enabled: "Enabled", fullConsent: "Full consent", revocationReason: "Revocation reason",
    expiresAt: "Valid until", createdAt: "Created at", revokedAt: "Revoked at", length: "Length (seconds)", retryAfter: "Retry after",
    clipId: "Clip ID", tokenId: "Token ID", login: "Login", displayName: "Display name", leadSeconds: "lead time",
    name: "Object name", value: "Value", description: "Description", overlayId: "Overlay ID", categoryId: "Category ID",
    timeZone: "Channel time zone", locationName: "Location", locationTimeZone: "Location time zone", latitude: "Latitude", longitude: "Longitude",
    width: "Width", height: "Height", revision: "Revision", elementCount: "Elements",
  },
};

export const auditFieldLabel = (
  key: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const knownLabel = catalogString(auditFieldLabels[language], key);
  if (knownLabel !== undefined) return knownLabel;
  return language === "de" ? "Unbekanntes Feld" : "Unknown field";
};

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
    variable_rename_template_too_long: "Die Umbenennung würde mindestens eine verwendete Vorlage über 500 Zeichen verlängern.",
    variable_management_denied: "Nur Broadcaster und Verwalter dürfen Variablen anlegen, umbenennen oder löschen.",
    variable_value_change_denied: "Du darfst den Variablenwert nicht ändern.",
    ad_schedule_read_failed: "Der Werbezeitplan konnte nicht gelesen werden.",
    ad_snooze_denied: "Nur Broadcaster und Verwalter dürfen Werbepausen verschieben.",
    ad_snooze_failed: "Die nächste Werbepause konnte nicht verschoben werden.",
    commercial_length_invalid: "Die Werbedauer ist ungültig.",
    commercial_start_denied: "Nur Broadcaster und Verwalter dürfen Werbung starten.",
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
    variable_rename_template_too_long: "Renaming this variable would make at least one referencing template longer than 500 characters.",
    variable_management_denied: "Only broadcasters and managers may create, rename, or delete variables.",
    variable_value_change_denied: "You may not change the variable value.",
    ad_schedule_read_failed: "The ad schedule could not be read.",
    ad_snooze_denied: "Only broadcasters and managers can snooze ads.",
    ad_snooze_failed: "The next ad break could not be postponed.",
    commercial_length_invalid: "The commercial length is invalid.",
    commercial_start_denied: "Only broadcasters and managers can start ads.",
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

export const dashboardTexts = (language: DashboardLanguage = dashboardLanguage()): DashboardTexts => dashboardTextsCatalog[language];

export const immediateActionUnavailableReasonText = (
  reason: ImmediateActionUnavailableReason,
  language: DashboardLanguage = dashboardLanguage(),
): string => dashboardTextsCatalog[language].streamManager.availabilityReasons[reason];

const formatDashboardDate = (
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

export const formatNumber = (value: number, language: DashboardLanguage = dashboardLanguage()): string =>
  new Intl.NumberFormat(language).format(value);
