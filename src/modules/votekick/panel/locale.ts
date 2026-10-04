import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";
import type { VotekickStatus } from "../contracts";

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    unknownVariable: (name) => `Unbekannte Variable {${name}}. Nutze den Variablen-Picker.`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; Twitch lehnt Nachrichten über ${String(maximum)} Zeichen ab.`,
    variablePicker: {
      triggerLabel: "Variable einfügen", title: "Variable auswählen", searchLabel: "Variablen suchen", closeLabel: "Variablenauswahl schließen",
      noResults: "Keine Variablen gefunden.", createVariableLabel: "Variable anlegen …", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { context: "Kontext", stream: "Stream", person: "Person", command: "Befehl", time_random: "Zeit & Zufall", event: "Ereignis", channel: "Kanalvariablen", text_blocks: "Textblöcke" },
      textBlockSample: "Textblock", keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} characters`,
    unknownVariable: (name) => `Unknown variable {${name}}. Use the variable picker.`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; Twitch rejects messages over ${String(maximum)} characters.`,
    variablePicker: {
      triggerLabel: "Insert variable", title: "Choose a variable", searchLabel: "Search variables", closeLabel: "Close variable picker",
      noResults: "No variables found.", createVariableLabel: "Create variable …", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { context: "Context", stream: "Stream", person: "Person", command: "Command", time_random: "Time and random", event: "Event", channel: "Channel variables", text_blocks: "Text blocks" },
      textBlockSample: "Text block", keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

const variableCopies = {
  de: [
    { name: "votekick.target", label: "Ziel", description: "Login des Ziels", sample: "sampleviewer" },
    { name: "votekick.yes", label: "Ja-Stimmen", description: "Anzahl der Ja-Stimmen", sample: "6" },
    { name: "votekick.no", label: "Nein-Stimmen", description: "Anzahl der Nein-Stimmen", sample: "1" },
    { name: "votekick.threshold", label: "Schwelle", description: "Benötigte Netto-Ja-Stimmen", sample: "5" },
    { name: "votekick.seconds", label: "Sekunden", description: "Timeout-Dauer in Sekunden", sample: "120" },
    { name: "votekick.duration", label: "Dauer", description: "Lesbare Timeout-Dauer", sample: "2 Min." },
  ],
  en: [
    { name: "votekick.target", label: "Target", description: "Target login", sample: "sampleviewer" },
    { name: "votekick.yes", label: "Yes votes", description: "Number of yes votes", sample: "6" },
    { name: "votekick.no", label: "No votes", description: "Number of no votes", sample: "1" },
    { name: "votekick.threshold", label: "Threshold", description: "Required net yes votes", sample: "5" },
    { name: "votekick.seconds", label: "Seconds", description: "Timeout duration in seconds", sample: "120" },
    { name: "votekick.duration", label: "Duration", description: "Readable timeout duration", sample: "2 min" },
  ],
} as const;

const makeSettingsCatalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  const words = de ? {
    title: "Votekick-Einstellungen", readOnly: "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern.",
    save: "Votekick-Einstellungen speichern", saved: "Einstellungen gespeichert.", pending: "Wird gespeichert …",
    invalid: "Bitte korrigiere die markierten Felder.", load: "Einstellungen konnten nicht geladen werden.", error: "Einstellungen konnten nicht gespeichert werden.",
    conflict: "Einstellungen wurden inzwischen geändert.", reload: "Serverstand laden", settings: "Schwelle und Zeit", messages: "Chat-Nachrichten",
    minVotes: "Mindest-Netto-Ja-Stimmen", percent: "Aktive Chatter in Prozent", window: "Abstimmungsfenster",
    duration: "Timeout-Dauer", minimum: "Mindestens", maximum: "Höchstens", cooldown: "Kanal-Abkühlzeit", targetCooldown: "Ziel-Abkühlzeit",
    target: "Chat-Ausgabeziel", targetHint: "Wirkt nur während eines Shared Chats.", start: "Startnachricht", pass: "Erfolgsnachricht", fail: "Fehlernachricht",
    expired: "Ablaufnachricht", protected: "Geschütztes Ziel", busy: "Laufende Abstimmung", seconds: "Sekunden", percentUnit: "%",
    rangeHint: "Gleiche Werte bedeuten eine feste Dauer. Erlaubt sind 1 bis 3.600 Sekunden.",
    startHint: "Wird nach dem Start direkt im Chat gesendet.", passHint: "Wird gesendet, wenn Twitch den Timeout bestätigt.", failHint: "Wird gesendet, wenn Twitch den Timeout sicher ablehnt.",
    expiredHint: "Optional; leer lassen, um beim Ablauf keine Chat-Nachricht zu senden.", protectedHint: "Wird für Broadcaster, Moderatoren und den Bot verwendet.", busyHint: "Wird gesendet, wenn bereits ein Ballot läuft.",
    preview: "Vorschau", bot: "Bot", all: "Alle Chats", source: "Nur unser Chat",
  } : {
    title: "Votekick settings", readOnly: "Only broadcasters and managers may change these settings.",
    save: "Save votekick settings", saved: "Settings saved.", pending: "Saving …",
    invalid: "Please correct the marked fields.", load: "Settings could not be loaded.", error: "Settings could not be saved.",
    conflict: "Settings have changed since they were loaded.", reload: "Load server version", settings: "Threshold and timing", messages: "Chat messages",
    minVotes: "Minimum net yes votes", percent: "Active chatters percent", window: "Voting window",
    duration: "Timeout duration", minimum: "Minimum", maximum: "Maximum", cooldown: "Channel cooldown", targetCooldown: "Target cooldown",
    target: "Chat output target", targetHint: "Only affects output during Shared Chat.", start: "Start message", pass: "Success message", fail: "Failure message",
    expired: "Expiry message", protected: "Protected target", busy: "Ballot already running", seconds: "seconds", percentUnit: "%",
    rangeHint: "Equal values use a fixed duration. Allowed values are 1 to 3,600 seconds.",
    startHint: "Sent directly to chat after the vote starts.", passHint: "Sent when Twitch confirms the timeout.", failHint: "Sent when Twitch safely rejects the timeout.",
    expiredHint: "Optional; leave empty to send no chat message when the vote expires.", protectedHint: "Used for broadcasters, moderators, and the bot.", busyHint: "Sent when another ballot is already open.",
    preview: "Preview", bot: "Bot", all: "All chats", source: "Only our chat",
  };
  const variableList = variableCopies[language];
  const templateField = (label: string, hint: string) => ({
    label, hint, previewLabel: words.preview, previewSpeaker: words.bot,
    variables: variableList.map(({ name, label: variableLabel, description, sample }) => ({ name, label: variableLabel, description, sample })),
  });
  return {
    title: words.title,
    ariaLabel: words.title,
    readOnlyReason: words.readOnly,
    saveLabel: words.save,
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: words.saved,
    pendingLabel: words.pending,
    invalidMessage: words.invalid,
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    loadError: words.load,
    saveError: words.error,
    conflictMessage: words.conflict,
    reloadLabel: words.reload,
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    templateMessages: templateMessages[language],
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variable(n)" : "Unknown variable(s)"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `${de ? "Ungültige Variablenparameter" : "Invalid variable parameters"}: ${warning.invalidVariables.join(", ")}`
        : `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`,
    sections: { thresholds: words.settings, messages: words.messages },
    fields: {
      minNetVotes: { label: words.minVotes, hint: de ? "Die Netto-Schwelle fällt nie unter diesen Wert." : "The net threshold never falls below this value." },
      percent: { label: words.percent, hint: de ? "Wird auf die nächste ganze Stimme aufgerundet." : "Rounded up to the next whole vote.", unit: words.percentUnit },
      windowSeconds: { label: words.window, hint: de ? "Das Panel zeigt die verbleibende Zeit." : "The panel shows the remaining time.", unit: words.seconds },
      duration: { label: words.duration, hint: words.rangeHint, unit: "s", minimumLabel: words.minimum, maximumLabel: words.maximum },
      channelCooldownSeconds: { label: words.cooldown, hint: de ? "Zeit nach dem Ende bis zum nächsten Votekick." : "Wait after a votekick ends before starting another.", unit: words.seconds },
      targetCooldownSeconds: { label: words.targetCooldown, hint: de ? "Zeit bis dasselbe Ziel erneut gewählt werden kann." : "Wait before the same target can be selected again.", unit: words.seconds },
      chatTarget: { label: words.target, hint: words.targetHint, options: { all_chats: { label: words.all }, source_only: { label: words.source } } },
      startText: templateField(words.start, words.startHint),
      passText: templateField(words.pass, words.passHint),
      failText: templateField(words.fail, words.failHint),
      expiredText: templateField(words.expired, words.expiredHint),
      protectedText: templateField(words.protected, words.protectedHint),
      busyText: templateField(words.busy, words.busyHint),
    },
  };
};

const settingsCatalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: makeSettingsCatalog("de"),
  en: makeSettingsCatalog("en"),
};

export const votekickSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => settingsCatalog[language];

const panelCopy: LocaleCatalog<{
  ariaLabel: string;
  running: string;
  history: string;
  emptyRunning: string;
  emptyHistory: string;
  target: string;
  votes: (yes: number, no: number, threshold: number) => string;
  remaining: (seconds: number) => string;
  cancel: string;
  cancelDialogCancel: string;
  cancelTitle: string;
  cancelDescription: string;
  confirmCancel: string;
  lift: string;
  liftDialogCancel: string;
  liftTitle: string;
  liftDescription: string;
  confirmLift: string;
  loadError: string;
  actionError: string;
  lifted: string;
  status: Record<VotekickStatus, string>;
  duration: (seconds: number | null) => string;
  started: (value: string) => string;
}> = {
  de: {
    ariaLabel: "Votekick-Betrieb", running: "Laufender Votekick", history: "Letzte Votekicks",
    emptyRunning: "Kein Votekick läuft.", emptyHistory: "In den letzten 14 Tagen gab es keine Votekicks.",
    target: "Ziel", votes: (yes, no, threshold) => `${String(yes)} Ja · ${String(no)} Nein · Schwelle ${String(threshold)}`,
    remaining: (seconds) => `Noch ${String(seconds)} s`, cancel: "Abbrechen", cancelTitle: "Votekick abbrechen?",
    cancelDescription: "Die laufende Abstimmung wird geschlossen.", confirmCancel: "Votekick abbrechen", cancelDialogCancel: "Zurück",
    lift: "Timeout aufheben", liftDialogCancel: "Zurück",
    liftTitle: "Timeout aufheben?", liftDescription: "Der Timeout für dieses Ziel wird bei Twitch aufgehoben.", confirmLift: "Timeout aufheben",
    loadError: "Votekicks konnten nicht geladen werden.", actionError: "Die Aktion konnte nicht abgeschlossen werden.", lifted: "Timeout aufgehoben.",
    status: { running: "Läuft", passed: "Bestanden", expired: "Abgelaufen", cancelled: "Abgebrochen", failed: "Fehlgeschlagen" },
    duration: (seconds) => seconds === null ? "—" : `${String(seconds)} s`,
    started: (value) => `Gestartet ${value}`,
  },
  en: {
    ariaLabel: "Votekick operations", running: "Running votekick", history: "Recent votekicks",
    emptyRunning: "No votekick is running.", emptyHistory: "There have been no votekicks in the last 14 days.",
    target: "Target", votes: (yes, no, threshold) => `${String(yes)} yes · ${String(no)} no · threshold ${String(threshold)}`,
    remaining: (seconds) => `${String(seconds)} s remaining`, cancel: "Cancel", cancelTitle: "Cancel this votekick?",
    cancelDescription: "The running ballot will be closed.", confirmCancel: "Cancel votekick", cancelDialogCancel: "Keep running",
    lift: "Lift timeout", liftDialogCancel: "Cancel",
    liftTitle: "Lift timeout?", liftDescription: "This target's timeout will be lifted at Twitch.", confirmLift: "Lift timeout",
    loadError: "Votekicks could not be loaded.", actionError: "The action could not be completed.", lifted: "Timeout lifted.",
    status: { running: "Running", passed: "Passed", expired: "Expired", cancelled: "Cancelled", failed: "Failed" },
    duration: (seconds) => seconds === null ? "—" : `${String(seconds)} s`,
    started: (value) => `Started ${value}`,
  },
};

export const votekickPanelTexts = (language: DashboardLanguage) => panelCopy[language];
