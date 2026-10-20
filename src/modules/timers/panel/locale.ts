import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { TemplateTextFieldMessages } from "../../../dashboard/ui";

export interface TimersTexts {
  title: string;
  add: string;
  general: string;
  name: string;
  message: string;
  messageHint: string;
  trigger: string;
  chatTarget: string;
  chatTargetLabels: Record<"all_chats" | "source_only", string>;
  chatTargetInherited: (target: string) => string;
  automatic: string;
  interval: string;
  streamStart: string;
  timeOfDay: string;
  beforeEvent: string;
  live: string;
  offline: string;
  liveOff: string;
  offlineOff: string;
  minutes: string;
  minutesUnit: string;
  liveEvery: (minutes: number) => string;
  offlineEvery: (minutes: number) => string;
  afterMessages: (count: number) => string;
  minutesBeforeEvent: (minutes: number) => string;
  messageCount: string;
  minimumMessagesHint: string;
  minimumMessagesPlaceholder: string;
  time: string;
  weekdays: string;
  everyDay: string;
  alsoOffline: string;
  eventSource: string;
  before: string;
  nextRun: string;
  nextRunLive: string;
  nextRunOffline: string;
  disabled: string;
  enabled: string;
  create: string;
  edit: string;
  save: string;
  delete: string;
  deleteOperatorReason: string;
  deleteConfirm: string;
  deleteNeedsSaved: string;
  preview: string;
  previewLoading: string;
  previewBot: string;
  characterCount: (count: number) => string;
  empty: string;
  loadError: string;
  saveError: string;
  deleteError: string;
  missingTextBlock: string;
  inputDependentText: string;
  limitReached: string;
  templateMessages: TemplateTextFieldMessages;
  roleLocked: string;
  noNextRun: string;
  weekdaysNames: readonly string[];
  timerCount: (count: number) => string;
  emptyTitle: string;
  selectTimer: string;
  selectTimerDescription: string;
  back: string;
  when: string;
  lastRun: string;
  neverRun: string;
  nameRequired: string;
  messageRequired: string;
  liveRule: string;
  offlineRule: string;
  messagesUnit: string;
  draftGuardTitle: string;
  draftGuardDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
  conflict: string;
  reload: string;
  search: string;
  noSearchResults: string;
}

const catalog: LocaleCatalog<TimersTexts> = {
  de: {
    title: "Timer",
    add: "Timer anlegen",
    general: "Allgemein",
    name: "Name",
    message: "Nachricht",
    messageHint: "Freitext mit Variablen und Textbausteinen im Format {text.name}.",
    trigger: "Auslöser",
    chatTarget: "Chat-Ziel",
    chatTargetLabels: { all_chats: "Alle Chats", source_only: "Nur unser Chat" },
    chatTargetInherited: (target) => `Kanalstandard (${target})`,
    automatic: "Automatisch",
    interval: "Intervall",
    streamStart: "Nach Streamstart",
    timeOfDay: "Uhrzeit",
    beforeEvent: "Vor einem Ereignis",
    live: "Live",
    offline: "Offline",
    liveOff: "Live aus",
    offlineOff: "Offline aus",
    minutes: "Minuten",
    minutesUnit: "Min.",
    liveEvery: (minutes) => `Live alle ${String(minutes)} Min.`,
    offlineEvery: (minutes) => `Offline alle ${String(minutes)} Min.`,
    afterMessages: (count) => `ab ${String(count)} ${count === 1 ? "Nachricht" : "Nachrichten"}`,
    minutesBeforeEvent: (minutes) => `${String(minutes)} Min. vor einem Ereignis`,
    messageCount: "Mindestanzahl Chatnachrichten",
    minimumMessagesHint: "Leer bedeutet: keine Mindestzahl.",
    minimumMessagesPlaceholder: "keine",
    time: "Uhrzeit im Kanal",
    weekdays: "Wochentage",
    everyDay: "Täglich",
    alsoOffline: "Auch senden, wenn der Stream offline ist",
    eventSource: "Ereigniszeit",
    before: "Vorlauf",
    nextRun: "Nächster Lauf",
    nextRunLive: "Nächster Lauf (live)",
    nextRunOffline: "Nächster Lauf (offline)",
    disabled: "Deaktiviert",
    enabled: "Aktiviert",
    create: "Anlegen",
    edit: "Bearbeiten",
    save: "Speichern",
    delete: "Löschen",
    deleteOperatorReason: "Nur Broadcaster und Verwalter dürfen löschen.",
    deleteConfirm: "Diesen Timer wirklich entfernen?",
    deleteNeedsSaved: "Speichere oder verwerfe deine Änderungen, bevor du den Timer entfernst.",
    preview: "Vorschau",
    previewLoading: "Vorschau wird aktualisiert …",
    previewBot: "Bot",
    characterCount: (count) => `${String(count)} Zeichen`,
    empty: "Noch keine Timer angelegt.",
    loadError: "Timer konnten nicht geladen werden.",
    saveError: "Der Timer konnte nicht gespeichert werden.",
    deleteError: "Der Timer konnte nicht entfernt werden.",
    missingTextBlock: "Ein verwendeter Textbaustein existiert nicht mehr.",
    inputDependentText: "Geplante Nachrichten können keine Eingaben aus einem Chatbefehl verwenden.",
    limitReached: "Ein Kanal kann höchstens 50 Timer haben.",
    templateMessages: {
      countLabel: (count, max) => `${String(count)} von ${String(max)} Zeichen`,
      previewCountLabel: (count) => count,
      openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
      unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
      insertSuggestionLabel: (name) => `${name} einfügen`,
      insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
      worstCaseLength: (length, maximum) => `${String(length)} Zeichen, höchstens ${String(maximum)}.`,
      picker: {
        title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
        groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
        keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
      },
    },
    roleLocked: "Nur Broadcaster und Verwalter dürfen Timer bearbeiten.",
    noNextRun: "Kein Lauf geplant",
    weekdaysNames: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
    timerCount: () => "Timer",
    emptyTitle: "Noch keine Timer",
    selectTimer: "Timer auswählen",
    selectTimerDescription: "Wähle links einen Timer aus oder lege einen neuen an.",
    back: "Zur Timerübersicht",
    when: "Zeitplan",
    lastRun: "Zuletzt",
    neverRun: "Noch nie ausgeführt",
    nameRequired: "Gib einen Namen ein.",
    messageRequired: "Gib eine Nachricht ein.",
    liveRule: "Timer-Intervalle laufen nur während der Live-Übertragung. Wird die Mindestzahl an Chatnachrichten nicht erreicht, entfällt dieser Lauf.",
    offlineRule: "Ein aktiviertes Offline-Intervall läuft separat, solange der Stream offline ist.",
    messagesUnit: "Nachrichten",
    draftGuardTitle: "Ungespeicherte Änderungen",
    draftGuardDescription: "Dieser Timer hat ungespeicherte Änderungen. Was möchtest du tun?",
    continueEditing: "Weiter bearbeiten",
    discardAndSwitch: "Verwerfen und wechseln",
    saveAndSwitch: "Speichern und wechseln",
    conflict: "Dieser Timer wurde geändert. Lade den aktuellen Stand, bevor du weiterarbeitest.",
    reload: "Neu laden",
    search: "Timer suchen",
    noSearchResults: "Keine Timer passen zur Suche.",
  },
  en: {
    title: "Timers",
    add: "Create timer",
    general: "General",
    name: "Name",
    message: "Message",
    messageHint: "Free text with variables and text blocks in the {text.name} format.",
    trigger: "Trigger",
    chatTarget: "Chat target",
    chatTargetLabels: { all_chats: "All chats", source_only: "Only our chat" },
    chatTargetInherited: (target) => `Channel default (${target})`,
    automatic: "Automatic",
    interval: "Interval",
    streamStart: "After stream start",
    timeOfDay: "Time of day",
    beforeEvent: "Before an event",
    live: "Live",
    offline: "Offline",
    liveOff: "Live off",
    offlineOff: "Offline off",
    minutes: "Minutes",
    minutesUnit: "min",
    liveEvery: (minutes) => `Live every ${String(minutes)} min`,
    offlineEvery: (minutes) => `Offline every ${String(minutes)} min`,
    afterMessages: (count) => `after ${String(count)} ${count === 1 ? "message" : "messages"}`,
    minutesBeforeEvent: (minutes) => `${String(minutes)} min before an event`,
    messageCount: "Minimum chat messages",
    minimumMessagesHint: "Leave blank to set no minimum.",
    minimumMessagesPlaceholder: "none",
    time: "Time in channel time zone",
    weekdays: "Weekdays",
    everyDay: "Every day",
    alsoOffline: "Also send while the stream is offline",
    eventSource: "Event time",
    before: "Lead time",
    nextRun: "Next run",
    nextRunLive: "Next run (live)",
    nextRunOffline: "Next run (offline)",
    disabled: "Disabled",
    enabled: "Enabled",
    create: "Create",
    edit: "Edit",
    save: "Save",
    delete: "Delete",
    deleteOperatorReason: "Only broadcasters and managers may delete.",
    deleteConfirm: "Remove this timer?",
    deleteNeedsSaved: "Save or discard your changes before deleting this timer.",
    preview: "Preview",
    previewLoading: "Updating preview …",
    previewBot: "Bot",
    characterCount: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    empty: "No timers yet.",
    loadError: "Timers could not be loaded.",
    saveError: "The timer could not be saved.",
    deleteError: "The timer could not be removed.",
    missingTextBlock: "A referenced text block no longer exists.",
    inputDependentText: "Scheduled messages cannot use input from a chat command.",
    limitReached: "A channel can have up to 50 timers.",
    templateMessages: {
      countLabel: (count, max) => `${String(count)} of ${String(max)} characters`,
      previewCountLabel: (count) => count,
      openBrace: "Unclosed variable: add a closing brace }.",
      unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
      insertSuggestionLabel: (name) => `Insert ${name}`,
      insertionLimit: "This insertion would exceed the character limit.",
      worstCaseLength: (length, maximum) => `${String(length)} characters, maximum ${String(maximum)}.`,
      picker: {
        title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
        groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
        keyHints: { navigate: "select", insert: "insert", close: "close" },
      },
    },
    roleLocked: "Only broadcasters and managers can edit timers.",
    noNextRun: "No run scheduled",
    weekdaysNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    timerCount: (count) => count === 1 ? "timer" : "timers",
    emptyTitle: "No timers yet",
    selectTimer: "Select a timer",
    selectTimerDescription: "Choose a timer on the left or create a new one.",
    back: "Back to timers",
    when: "Schedule",
    lastRun: "Last run",
    neverRun: "Never run",
    nameRequired: "Enter a name.",
    messageRequired: "Enter a message.",
    liveRule: "Timer intervals run only while the stream is live. If the minimum number of chat messages is not reached, that run is skipped.",
    offlineRule: "An enabled offline interval runs separately while the stream is offline.",
    messagesUnit: "messages",
    draftGuardTitle: "Unsaved changes",
    draftGuardDescription: "This timer has unsaved changes. What would you like to do?",
    continueEditing: "Continue editing",
    discardAndSwitch: "Discard and switch",
    saveAndSwitch: "Save and switch",
    conflict: "This timer has changed. Reload the current version before continuing.",
    reload: "Reload",
    search: "Search timers",
    noSearchResults: "No timers match your search.",
  },
};

export const timersTexts = (language?: DashboardLanguage): TimersTexts => catalog[language ?? dashboardLanguage()];
