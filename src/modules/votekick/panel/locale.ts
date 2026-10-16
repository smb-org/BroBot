import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; Twitch lehnt Nachrichten über ${String(maximum)} Zeichen ab.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; Twitch rejects messages over ${String(maximum)} characters.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
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
    { name: "votekick.window", label: "Abstimmungsfenster", description: "Formatierte Dauer der Abstimmung", sample: "2 Min." },
  ],
  en: [
    { name: "votekick.target", label: "Target", description: "Target login", sample: "sampleviewer" },
    { name: "votekick.yes", label: "Yes votes", description: "Number of yes votes", sample: "6" },
    { name: "votekick.no", label: "No votes", description: "Number of no votes", sample: "1" },
    { name: "votekick.threshold", label: "Threshold", description: "Required net yes votes", sample: "5" },
    { name: "votekick.seconds", label: "Seconds", description: "Timeout duration in seconds", sample: "120" },
    { name: "votekick.duration", label: "Duration", description: "Readable timeout duration", sample: "2 min" },
    { name: "votekick.window", label: "Voting window", description: "Formatted duration of the ballot", sample: "2 min" },
  ],
} as const;

const makeSettingsCatalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  const words = de ? {
    title: "Votekick", readOnly: "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern.",
    save: "Einstellungen speichern", saved: "Einstellungen gespeichert.", pending: "Wird gespeichert …",
    invalid: "Bitte korrigiere die markierten Felder.", error: "Einstellungen konnten nicht gespeichert werden.",
    conflict: "Einstellungen wurden inzwischen geändert.", reload: "Serverstand laden",
    starter: "Wer darf starten?", threshold: "Wann gilt er als bestanden?", messages: "Nachrichten im Chat",
    minVotes: "Mindest-Netto-Ja-Stimmen", percent: "Aktive Chatter in Prozent", window: "Abstimmungsfenster",
    starterRole: "Mindestrolle", duration: "Timeout-Dauer", minimum: "Mindestens", maximum: "Höchstens",
    cooldown: "Kanalpause", targetCooldown: "Pause für dasselbe Ziel", target: "Chat-Ausgabeziel",
    targetHint: "Wirkt nur während eines Shared Chats.", seconds: "Sekunden", percentUnit: "%",
    rangeHint: "Gleiche Werte bedeuten eine feste Dauer. Erlaubt sind 1 bis 3.600 Sekunden.",
    preview: "Vorschau", bot: "Bot", all: "Alle Chats", source: "Nur unser Chat",
    start: "Startnachricht", pass: "Erfolgsnachricht", fail: "Fehler beim Timeout", expired: "Abstimmung abgelaufen",
    protected: "Geschütztes Ziel", busy: "Abstimmung läuft bereits", messageBody: "Nachrichtentext",
    messageOff: "Nachricht ausschalten.",
    startHint: "Wird gesendet, wenn ein Votekick startet.", passHint: "Wird gesendet, wenn Twitch den Timeout bestätigt.",
    failHint: "Wird gesendet, wenn Twitch den Timeout ablehnt.", expiredHint: "Wird gesendet, wenn die Abstimmung abläuft.",
    protectedHint: "Wird gesendet, wenn das Ziel geschützt ist.", busyHint: "Wird gesendet, wenn bereits eine Abstimmung läuft.",
    roleViewer: "Zuschauer und höher", roleViewerHelp: "Alle Chatnutzer:innen dürfen !votekick starten.",
    roleSubscriber: "Abonnent und höher", roleSubscriberHelp: "Abonnent:innen, VIPs, Moderator:innen und Broadcaster dürfen starten.",
    roleVip: "VIP und höher", roleVipHelp: "VIPs, Moderator:innen und Broadcaster dürfen starten.",
    roleModerator: "Moderator und höher", roleModeratorHelp: "Moderator:innen und Broadcaster dürfen starten.",
    roleBroadcaster: "Nur Broadcaster", roleBroadcasterHelp: "Nur Broadcaster dürfen starten.",
    summaryRule: "Die Schwelle ist der größere Wert aus Mindest-Netto-Ja-Stimmen und dem aufgerundeten Anteil aktiver Chatter.",
    minVotesHint: "Mindestwert für den Netto-Vorsprung aus Ja- minus Nein-Stimmen.",
    percentHint: "Beitrag in den letzten 10 Minuten; der Prozentwert wird aufgerundet.",
    windowHint: "Wie lange die Chat-Abstimmung offen bleibt.", cooldownHint: "Zeit nach dem Ende bis zum nächsten Votekick.",
    targetCooldownHint: "Zeit, bis dasselbe Ziel erneut gewählt werden kann.",
  } : {
    title: "Votekick", readOnly: "Only broadcasters and managers may change these settings.",
    save: "Save settings", saved: "Settings saved.", pending: "Saving …",
    invalid: "Please correct the marked fields.", error: "Settings could not be saved.",
    conflict: "Settings have changed since they were loaded.", reload: "Load server version",
    starter: "Who can start one?", threshold: "When does it pass?", messages: "Chat messages",
    minVotes: "Minimum net yes votes", percent: "Active chatters percent", window: "Voting window",
    starterRole: "Minimum role", duration: "Timeout duration", minimum: "Minimum", maximum: "Maximum",
    cooldown: "Channel cooldown", targetCooldown: "Same target cooldown", target: "Chat output target",
    targetHint: "Only affects output during Shared Chat.", seconds: "seconds", percentUnit: "%",
    rangeHint: "Equal values mean a fixed duration. Allowed values are 1 to 3,600 seconds.",
    preview: "Preview", bot: "Bot", all: "All chats", source: "Only our chat",
    start: "Start message", pass: "Success message", fail: "Timeout failure", expired: "Ballot expired",
    protected: "Protected target", busy: "Ballot already running", messageBody: "Message text",
    messageOff: "Turn this message off.",
    startHint: "Sent when a votekick starts.", passHint: "Sent when Twitch confirms the timeout.",
    failHint: "Sent when Twitch rejects the timeout.", expiredHint: "Sent when the ballot expires.",
    protectedHint: "Sent when the target is protected.", busyHint: "Sent when another ballot is already running.",
    roleViewer: "Viewer and higher", roleViewerHelp: "Everyone in chat may start !votekick.",
    roleSubscriber: "Subscriber and higher", roleSubscriberHelp: "Subscribers, VIPs, moderators, and broadcasters may start.",
    roleVip: "VIP and higher", roleVipHelp: "VIPs, moderators, and broadcasters may start.",
    roleModerator: "Moderator and higher", roleModeratorHelp: "Moderators and broadcasters may start.",
    roleBroadcaster: "Broadcaster only", roleBroadcasterHelp: "Only broadcasters may start.",
    summaryRule: "The threshold is the larger of the minimum net yes votes and the rounded-up share of active chatters.",
    minVotesHint: "Minimum net lead of yes votes over no votes.",
    percentHint: "Chat activity in the last 10 minutes; the percentage is rounded up.",
    windowHint: "How long the chat ballot stays open.", cooldownHint: "Wait after a ballot ends before another votekick.",
    targetCooldownHint: "Wait before the same target can be selected again.",
  };
  const variables = variableCopies[language];
  const templateField = (hint: string) => ({
    label: words.messageBody,
    hint,
    optionalHint: words.messageOff,
    previewLabel: words.preview,
    previewSpeaker: words.bot,
    variables: variables.map(({ name, label, description, sample }) => ({ name, label, description, sample })),
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
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Warning" },
    saveError: words.error,
    conflictMessage: words.conflict,
    reloadLabel: words.reload,
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    templateMessages: templateMessages[language],
    sections: { starter: words.starter, thresholds: words.threshold, messages: words.messages },
    notes: { thresholdRule: words.summaryRule },
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variable(n)" : "Unknown variable(s)"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `${de ? "Ungültige Variablenparameter" : "Invalid variable parameters"}: ${warning.invalidVariables.join(", ")}`
        : `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`,
    fields: {
      starterMinRole: {
        label: words.starterRole,
        hint: de ? "Diese Chatrolle und höhere Rollen dürfen !votekick starten." : "This chat role and higher roles may start !votekick.",
        options: {
          viewer: { label: words.roleViewer, description: words.roleViewerHelp },
          subscriber: { label: words.roleSubscriber, description: words.roleSubscriberHelp },
          vip: { label: words.roleVip, description: words.roleVipHelp },
          moderator: { label: words.roleModerator, description: words.roleModeratorHelp },
          broadcaster: { label: words.roleBroadcaster, description: words.roleBroadcasterHelp },
        },
      },
      minNetVotes: { label: words.minVotes, hint: words.minVotesHint },
      percent: { label: words.percent, hint: words.percentHint, unit: words.percentUnit },
      windowSeconds: { label: words.window, hint: words.windowHint, unit: words.seconds },
      duration: { label: words.duration, hint: words.rangeHint, unit: "s", minimumLabel: words.minimum, maximumLabel: words.maximum },
      channelCooldownSeconds: { label: words.cooldown, hint: words.cooldownHint, unit: words.seconds },
      targetCooldownSeconds: { label: words.targetCooldown, hint: words.targetCooldownHint, unit: words.seconds },
      chatTarget: { label: words.target, hint: words.targetHint, options: { all_chats: { label: words.all }, source_only: { label: words.source } } },
      startTextEnabled: { label: words.start, hint: words.startHint, description: words.startHint },
      passTextEnabled: { label: words.pass, hint: words.passHint, description: words.passHint },
      failTextEnabled: { label: words.fail, hint: words.failHint, description: words.failHint },
      expiredTextEnabled: { label: words.expired, hint: words.expiredHint, description: words.expiredHint },
      protectedTextEnabled: { label: words.protected, hint: words.protectedHint, description: words.protectedHint },
      busyTextEnabled: { label: words.busy, hint: words.busyHint, description: words.busyHint },
      startText: templateField(words.startHint),
      passText: templateField(words.passHint),
      failText: templateField(words.failHint),
      expiredText: templateField(words.expiredHint),
      protectedText: templateField(words.protectedHint),
      busyText: templateField(words.busyHint),
    },
  };
};

const settingsCatalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: makeSettingsCatalog("de"),
  en: makeSettingsCatalog("en"),
};

export const votekickSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => settingsCatalog[language];
