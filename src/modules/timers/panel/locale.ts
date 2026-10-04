import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

export interface TimersTexts {
  title: string;
  add: string;
  name: string;
  trigger: string;
  block: string;
  chatTarget: string;
  chatTargetLabels: Record<"all_chats" | "source_only", string>;
  interval: string;
  streamStart: string;
  timeOfDay: string;
  beforeEvent: string;
  minutes: string;
  minimumMessages: string;
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
  blockMissing: string;
  inputDependentBlock: string;
  limitReached: string;
  noBlocks: string;
  roleLocked: string;
  noNextRun: string;
  weekdaysNames: readonly string[];
  triggerSummary: (timerType: string, detail: string) => string;
}

const catalog: LocaleCatalog<TimersTexts> = {
  de: {
    title: "Timer",
    add: "Timer anlegen",
    name: "Name",
    trigger: "Auslöser",
    block: "Textbaustein",
    chatTarget: "Chat-Ziel",
    chatTargetLabels: { all_chats: "Alle Chats", source_only: "Nur unser Chat" },
    interval: "Intervall",
    streamStart: "Nach Streamstart",
    timeOfDay: "Uhrzeit",
    beforeEvent: "Vor einem Ereignis",
    minutes: "Minuten",
    minimumMessages: "Nur senden, wenn genug Chatnachrichten eingegangen sind",
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
    blockMissing: "Der ausgewählte Textbaustein existiert nicht mehr.",
    inputDependentBlock: "Dieser Textbaustein benötigt Eingaben aus einem Chatbefehl und kann nicht geplant werden.",
    limitReached: "Ein Kanal kann höchstens 50 Timer haben.",
    noBlocks: "Lege zuerst einen Textbaustein in der Textbibliothek an.",
    roleLocked: "Nur Broadcaster und Verwalter dürfen Timer bearbeiten.",
    noNextRun: "Kein Lauf geplant",
    weekdaysNames: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
    triggerSummary: (timerType, detail) => `${timerType} · ${detail}`,
  },
  en: {
    title: "Timers",
    add: "Create timer",
    name: "Name",
    trigger: "Trigger",
    block: "Text block",
    chatTarget: "Chat target",
    chatTargetLabels: { all_chats: "All chats", source_only: "Only our chat" },
    interval: "Interval",
    streamStart: "After stream start",
    timeOfDay: "Time of day",
    beforeEvent: "Before an event",
    minutes: "Minutes",
    minimumMessages: "Only send after enough chat messages have arrived",
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
    blockMissing: "The selected text block no longer exists.",
    inputDependentBlock: "This text block needs input from a chat command and cannot be scheduled.",
    limitReached: "A channel can have up to 50 timers.",
    noBlocks: "Create a text block in the text library first.",
    roleLocked: "Only broadcasters and managers can edit timers.",
    noNextRun: "No run scheduled",
    weekdaysNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    triggerSummary: (timerType, detail) => `${timerType} · ${detail}`,
  },
};

export const timersTexts = (language?: DashboardLanguage): TimersTexts => catalog[language ?? dashboardLanguage()];
