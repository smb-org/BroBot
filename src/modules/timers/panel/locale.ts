import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { TemplateTextFieldMessages } from "../../../dashboard/ui";

export interface TimersTexts {
  title: string;
  add: string;
  name: string;
  message: string;
  messageHint: string;
  trigger: string;
  chatTarget: string;
  chatTargetDefault: string;
  chatTargetLabels: Record<"all_chats" | "source_only", string>;
  interval: string;
  streamStart: string;
  timeOfDay: string;
  beforeEvent: string;
  minutes: string;
  minimumMessages: string;
  minimumMessagesHint: string;
  messageCount: string;
  time: string;
  weekdays: string;
  everyDay: string;
  alsoOffline: string;
  eventSource: string;
  before: string;
  nextRun: string;
  disabled: string;
  enabled: string;
  create: string;
  edit: string;
  save: string;
  cancel: string;
  delete: string;
  deleteConfirm: string;
  preview: string;
  previewTitle: string;
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
}

const catalog: LocaleCatalog<TimersTexts> = {
  de: {
    title: "Timer",
    add: "Timer anlegen",
    name: "Name",
    message: "Nachricht",
    messageHint: "Freitext mit Variablen und Textbausteinen im Format {text.name}.",
    trigger: "Auslöser",
    chatTarget: "Chat-Ziel",
    chatTargetDefault: "Kanaleinstellung",
    chatTargetLabels: { all_chats: "Alle Chats", source_only: "Nur unser Chat" },
    interval: "Intervall",
    streamStart: "Nach Streamstart",
    timeOfDay: "Uhrzeit",
    beforeEvent: "Vor einem Ereignis",
    minutes: "Minuten",
    minimumMessages: "Nur senden, wenn genug Chatnachrichten eingegangen sind",
    minimumMessagesHint: "Lege eine Mindestanzahl fest, bevor der Timer eine Nachricht sendet.",
    messageCount: "Mindestanzahl Chatnachrichten",
    time: "Uhrzeit im Kanal",
    weekdays: "Wochentage",
    everyDay: "Täglich",
    alsoOffline: "Auch senden, wenn der Stream offline ist",
    eventSource: "Ereigniszeit",
    before: "Vorlauf",
    nextRun: "Nächster Lauf",
    disabled: "Deaktiviert",
    enabled: "Aktiviert",
    create: "Anlegen",
    edit: "Bearbeiten",
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Entfernen",
    deleteConfirm: "Diesen Timer wirklich entfernen?",
    preview: "Vorschau",
    previewTitle: "Chatvorschau",
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
      countLabel: (count, max) => `${String(count)}/${String(max)}`,
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
  },
  en: {
    title: "Timers",
    add: "Create timer",
    name: "Name",
    message: "Message",
    messageHint: "Free text with variables and text blocks in the {text.name} format.",
    trigger: "Trigger",
    chatTarget: "Chat target",
    chatTargetDefault: "Channel default",
    chatTargetLabels: { all_chats: "All chats", source_only: "Only our chat" },
    interval: "Interval",
    streamStart: "After stream start",
    timeOfDay: "Time of day",
    beforeEvent: "Before an event",
    minutes: "Minutes",
    minimumMessages: "Only send after enough chat messages have arrived",
    minimumMessagesHint: "Set a minimum count before the timer sends a message.",
    messageCount: "Minimum chat messages",
    time: "Time in channel time zone",
    weekdays: "Weekdays",
    everyDay: "Every day",
    alsoOffline: "Also send while the stream is offline",
    eventSource: "Event time",
    before: "Lead time",
    nextRun: "Next run",
    disabled: "Disabled",
    enabled: "Enabled",
    create: "Create",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    deleteConfirm: "Remove this timer?",
    preview: "Preview",
    previewTitle: "Chat preview",
    previewBot: "Bot",
    characterCount: (count) => `${String(count)} characters`,
    empty: "No timers yet.",
    loadError: "Timers could not be loaded.",
    saveError: "The timer could not be saved.",
    deleteError: "The timer could not be removed.",
    missingTextBlock: "A referenced text block no longer exists.",
    inputDependentText: "Scheduled messages cannot use input from a chat command.",
    limitReached: "A channel can have up to 50 timers.",
    templateMessages: {
      countLabel: (count, max) => `${String(count)}/${String(max)}`,
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
  },
};

export const timersTexts = (language?: DashboardLanguage): TimersTexts => catalog[language ?? dashboardLanguage()];
