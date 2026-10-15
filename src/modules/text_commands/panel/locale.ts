import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { ModuleChatStatus } from "../contract";
import type { ChatOutputTarget } from "../../contract";
import type { TextCommandKind, TextCommandMinimumTier, TextCommandResponseType, TextCommandStreamCondition } from "../contracts";
import type { ChipsInputMessages, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { PanelTemplateWarning } from "../contract";
import type { GameMultiSelectMessages } from "../../../dashboard/ui";
import { formatCharacterCount, formatCharacterTotal, formatCount } from "../../../dashboard/ui/text-length";

export interface TextCommandsTexts {
  title: string;
  search: string;
  statusFilter: string;
  filterAll: string;
  filterActive: string;
  filterInactive: string;
  allModules: string;
  usedModuleVariables: string;
  entryCount: (count: number) => string;
  triggerSection: string;
  selectionPrompt: string;
  selectionDescription: string;
  noResponse: string;
  useCount: (count: number) => string;
  details: (name: string) => string;
  add: string;
  newCommand: string;
  empty: string;
  loadError: string;
  templateVariablesLoadError: string;
  saveError: string;
  deleteError: string;
  name: string;
  aliases: string;
  aliasPlaceholder: string;
  templateFieldLabels: { usageText: string };
  usageAdvanced: string;
  usageTextHint: string;
  textBlockDescription: string;
  createVariable: string;
  shoutoutCooldownHint: string;
  kind: string;
  kindLabels: Record<TextCommandKind, string>;
  kindHints: Record<TextCommandKind, string>;
  slashCommands: Record<"timeout" | "announce" | "shoutout", { syntax: string; description: string }>;
  slashCommandHelp: string;
  slashUnsupportedWarning: string;
  slashSyntaxError: (command: "timeout" | "announce" | "shoutout") => string;
  slashTimeoutEffect: (minimum: number, maximum: number) => string;
  slashAnnouncementEffect: string;
  slashShoutoutEffect: string;
  response: string;
  insertVariable: string;
  currencyFrom: string;
  currencyTo: string;
  currencyToken: string;
  responseOptional: string;
  responseHint: string;
  responseMissing: string;
  fieldTooLong: string;
  minimumTier: string;
  minimumRole: string;
  tierLabels: Record<TextCommandMinimumTier, string>;
  tierSubjects: Record<ModuleChatStatus, string>;
  tierDescription: (tier: TextCommandMinimumTier, subjects: readonly string[]) => string;
  tierHelp: string;
  responseType: string;
  chatTarget: string;
  chatTargetDefault: string;
  chatTargetLabels: Record<ChatOutputTarget, string>;
  responseTypeLabels: Record<TextCommandResponseType, string>;
  responseTypeHints: Record<TextCommandResponseType, string>;
  announcementWarning: string;
  streamCondition: string;
  streamLabels: Record<TextCommandStreamCondition, string>;
  streamHints: Record<TextCommandStreamCondition, string>;
  gameFilter: string;
  gameFilterHint: string;
  availability: string;
  gameMultiSelect: GameMultiSelectMessages;
  cooldown: string;
  cooldownField: string;
  userCooldown: string;
  cooldownHint: string;
  userCooldownHint: string;
  numberMissing: string;
  nameHint: string;
  nameInvalid: string;
  nameMissing: string;
  nameExists: string;
  nameAliasConflict: (trigger: string, command: string) => string;
  aliasConflict: (trigger: string, command: string) => string;
  aliasInvalid: (trigger: string) => string;
  aliasIsName: string;
  aliasPendingInvalid: string;
  aliasRemove: (alias: string) => string;
  aliasList: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteConfirmation: (name: string, aliases: readonly string[]) => string;
  deleteConfirm: (name: string) => string;
  deleteCancel: string;
  back: string;
  draftGuardTitle: string;
  draftGuardDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
  save: string;
  create: string;
  discard: string;
  saved: string;
  pending: string;
  invalid: string;
  issueError: string;
  issueWarning: string;
  conflictMessage: string;
  reloadError: string;
  reload: string;
  managementLocked: string;
  active: string;
  ready: string;
  variableBadge: string;
  never: string;
  secondsAgo: (count: number) => string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  lastUsed: string;
  previewLabel: string;
  previewSpeaker: string;
  templateMessages: TemplateTextFieldMessages;
  variableAction: string;
  variableSelect: string;
  variableSelectHint: string;
  variableNone: string;
  variableOperations: Record<"add" | "subtract" | "set" | "set_argument", string>;
  variableOperationHelp: Record<"add" | "subtract" | "set" | "set_argument", string>;
  variableAmount: string;
  variableActionInvalid: string;
  variableSilentHint: string;
  variableEveryoneWarning: string;
  timeoutAction: string;
  timeoutMinSeconds: string;
  timeoutMaxSeconds: string;
  timeoutDuration: string;
  timeoutRangeHint: string;
  timeoutRangeInvalid: string;
  timeoutFallbackText: string;
  timeoutFallbackTextOptional: string;
  timeoutReason: string;
  timeoutReasonHint: string;
  timeoutBotWarning: string;
  timeoutNone: string;
  actionResponse: (name: string, operation: "add" | "subtract" | "set" | "set_argument", amount: number | null) => string;
  externalCooldownWarning: string;
  argsEveryoneWarning: string;
  chipsInputMessages: ChipsInputMessages;
  warningLabel: (warning: PanelTemplateWarning) => string;
}

const templateMessages: LocaleCatalog<TemplateTextFieldMessages> = {
  de: {
    countLabel: (count, maximum) => formatCharacterCount(count, maximum, "de"),
    previewCountLabel: (count) => formatCharacterTotal(count, "de"),
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unbekannte Variable {${name}}.`
      : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maximum)} ab.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn der Befehl ausgeführt wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => formatCharacterCount(count, maximum, "en"),
    previewCountLabel: (count) => formatCharacterTotal(count, "en"),
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unknown variable {${name}}.`
      : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maximum)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the command runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

const catalog: LocaleCatalog<TextCommandsTexts> = {
  de: {
    title: "Textbefehle", search: "Befehle suchen", statusFilter: "Status", filterAll: "Alle", filterActive: "Aktiv", filterInactive: "Inaktiv", allModules: "Alle Module", usedModuleVariables: "Verwendet Modul-Variablen", entryCount: (count) => `${String(count)} ${count === 1 ? "Eintrag" : "Einträge"}`, triggerSection: "Auslöser", selectionPrompt: "Textbefehl auswählen", selectionDescription: "Wähle links einen Textbefehl aus oder lege einen neuen an.", noResponse: "Kein Antworttext", useCount: (count) => `${String(count)}× benutzt`, details: (name) => `Eigenschaften von !${name}`, add: "Befehl anlegen", newCommand: "Neu", empty: "Noch keine Textbefehle angelegt.",
    loadError: "Die Textbefehle konnten nicht geladen werden.", templateVariablesLoadError: "Vorlagenvariablen konnten nicht geladen werden.",
    saveError: "Der Textbefehl konnte nicht gespeichert werden.", deleteError: "Der Textbefehl konnte nicht gelöscht werden.",
    name: "Befehlsname", aliases: "Weitere Auslöser", aliasPlaceholder: "Alias eingeben", templateFieldLabels: { usageText: "Antwort bei fehlenden oder ungültigen Argumenten" }, usageAdvanced: "Erweitert", usageTextHint: "Wird gesendet, wenn erforderliche Argumente fehlen oder ungültig sind.", textBlockDescription: "Textbaustein", createVariable: "Variable anlegen",
    shoutoutCooldownHint: "Twitch begrenzt Shoutouts selbst: 2 Minuten pro Kanal und 60 Minuten pro Ziel.",
    kind: "Art der Antwort", kindLabels: { text: "Antworttext", list: "Befehlsliste", shoutout: "Shoutout", timeout: "Timeout" },
    kindHints: {
      text: "Antwortet mit dem Text unten.", list: "Zählt alle eingeschalteten Befehle auf (ohne Aliase).",
      shoutout: "!so <name> empfiehlt einen Twitch-Kanal im Chat.",
      timeout: "Timeout für den Aufrufer; Antwort bei Erfolg und Ersatztext bei Ablehnung.",
    },
    slashCommands: {
      timeout: { syntax: "/timeout {user} <seconds|min-max> [reason]", description: "Timeoutet den Aufrufer; Dauer und Grund werden als Felder gespeichert." },
      announce: { syntax: "/announce <text>", description: "Sendet den folgenden Text als Twitch-Ankündigung." },
      shoutout: { syntax: "/shoutout {target}", description: "Erstellt einen Shoutout-Befehl; das Ziel kommt aus dem Befehlsargument." },
    },
    slashCommandHelp: "Twitch-Befehle am Anfang werden beim Speichern in strukturierte Felder umgewandelt.",
    slashUnsupportedWarning: "Dieser Slash-Befehl bleibt Antworttext.",
    slashSyntaxError: (command) => `Ungültige Syntax: ${({
      timeout: "/timeout {user} <seconds|min-max> [reason]",
      announce: "/announce <text>",
      shoutout: "/shoutout {target}",
    } as const)[command]}`,
    slashTimeoutEffect: (minimum, maximum) => `Timeout für den Aufrufer für ${minimum === maximum ? `${String(minimum)} s` : `${String(minimum)}–${String(maximum)} s`}.`,
    slashAnnouncementEffect: "Wird als Twitch-Ankündigung gesendet.",
    slashShoutoutEffect: "Shoutout-Ziel kommt aus dem Befehlsargument.",
    response: "Antworttext", insertVariable: "Variable einfügen", currencyToken: "Währungsvariable", currencyFrom: "Von", currencyTo: "Nach", responseOptional: "Antworttext (optional)", responseHint: "Was der Bot schreibt. { öffnet die Variablen.", responseMissing: "Antworttext ausfüllen.", fieldTooLong: "Höchstens 500 Zeichen.",
    minimumTier: "Wer darf auslösen", minimumRole: "Mindestrolle",
    tierLabels: { everyone: "Alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    tierSubjects: { viewer: "Zuschauer", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    tierDescription: (tier, subjects) => {
      if (tier === "everyone") return "Alle Chatzuschauer*innen dürfen auslösen.";
      const joined = subjects.length < 2 ? subjects[0] ?? "" : `${subjects.slice(0, -1).join(", ")} und ${subjects[subjects.length - 1] ?? ""}`;
      const excluded = tier === "subscriber" ? " VIPs nicht." : tier === "vip" ? " Abonnenten nicht." : "";
      return `${joined}.${excluded}`;
    },
    tierHelp: "Moderatoren und Broadcaster dürfen immer.",
    responseType: "Sendeform", responseTypeLabels: { say: "Nachricht", reply: "Antwort", announcement: "Ankündigung" },
    chatTarget: "Chat-Ziel", chatTargetDefault: "Kanaleinstellung", chatTargetLabels: { all_chats: "Alle Chats", source_only: "Nur unser Chat", where_asked: "Automatisch" },
    responseTypeHints: {
      say: "Schreibt eine normale Nachricht in den Chat.",
      reply: "Antwortet sichtbar auf die Nachricht, die den Befehl ausgelöst hat.",
      announcement: "Hebt die Nachricht als Ankündigung hervor. Der Bot muss Moderator sein.",
    },
    announcementWarning: "Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.",
    streamCondition: "Nur verfügbar", streamLabels: { any: "Immer", online: "Stream live", offline: "Stream nicht live" },
    streamHints: { any: "Wirkt unabhängig vom Stream.", online: "Wirkt nur, während der Stream läuft.", offline: "Wirkt nur, während der Stream aus ist." },
    gameFilter: "Nur bei Spielen",
    gameFilterHint: "Der Befehl antwortet nur, wenn gerade eines dieser Spiele läuft.",
    availability: "Weitere Einstellungen",
    gameMultiSelect: { label: "Twitch-Spiele", hint: "Spiele über Twitch-Kategorien suchen und auswählen.", search: "Spiel suchen", searchHint: "Mindestens zwei Zeichen eingeben.", loading: "Spiele werden gesucht …", empty: "Keine Spiele gefunden.", error: "Die Twitch-Spiele konnten nicht geladen werden.", suggestions: "Vorschläge", allGames: "Alle Spiele", limitReached: "10er-Limit erreicht; entferne eins zum Austauschen.", selectedCount: formatCount, remove: (name) => `${name} entfernen` },
    cooldown: "Abklingzeit", cooldownField: "Zwischen zwei Aufrufen", userCooldown: "Je Nutzer", cooldownHint: "Für den ganzen Kanal. 0 bis 86 400.", userCooldownHint: "Für jeden Zuschauer einzeln. 0 = aus.", numberMissing: "Zahl eingeben.",
    nameHint: "a–z, 0–9, - und _",
    nameInvalid: "Nur Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.", nameMissing: "Namen ausfüllen.", nameExists: "Der Befehl existiert bereits.",
    nameAliasConflict: (trigger, command) => `!${trigger} ist schon ein Alias von !${command}.`,
    aliasConflict: (trigger, command) => trigger === command ? `!${trigger} ist schon der Befehl !${command}.` : `!${trigger} ist schon ein Alias von !${command}.`,
    aliasInvalid: (trigger) => `!${trigger} — nur Kleinbuchstaben, Zahlen, - und _.`,
    aliasIsName: "Das ist schon der Name.", aliasPendingInvalid: "Alias-Eingabe erst bestätigen oder entfernen.",
    aliasRemove: (alias) => `Alias ${alias} entfernen`, aliasList: "Aliase",
    delete: "Befehl löschen", deleteTitle: (name) => `Befehl !${name} löschen?`,
    deleteConfirmation: (name, aliases) => aliases.length === 0
      ? `Der Befehl !${name} wird gelöscht und antwortet danach nicht mehr im Chat.`
      : `Der Befehl !${name} und seine Aliase ${aliases.map((alias) => `!${alias}`).join(", ")} sind danach im Chat nicht mehr verfügbar.`,
    deleteConfirm: (name) => `Befehl !${name} löschen`, deleteCancel: "Abbrechen", back: "Zurück",
    draftGuardTitle: "Ungespeicherte Änderungen",
    draftGuardDescription: "Du hast Änderungen an diesem Befehl. Was möchtest du tun?",
    continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln",
    save: "Speichern", create: "Anlegen", discard: "Verwerfen", saved: "Alle Änderungen gespeichert",
    pending: "Wird gespeichert …", invalid: "Markierte Felder prüfen.", issueError: "Fehler", issueWarning: "Hinweis",
    conflictMessage: "Inzwischen von jemand anderem geändert.", reloadError: "Der Serverstand konnte nicht geladen werden.", reload: "Serverstand laden",
    managementLocked: "Einstellungen ändern nur Broadcaster und Verwalter.",
    active: "Aktiv", ready: "Bereit", variableBadge: "Variable",
    never: "noch nie", secondsAgo: (count) => `vor ${String(count)} s`, minutesAgo: (count) => `vor ${String(count)} min`, hoursAgo: (count) => `vor ${String(count)} h`,
    lastUsed: "zuletzt",
    previewLabel: "Vorschau", previewSpeaker: "BroBot",
    templateMessages: templateMessages.de,
    chipsInputMessages: { countLabel: formatCount, atLimitHint: "Höchstens 10 Aliase.", duplicateWarning: (alias) => `${alias} steht schon in der Liste.` },
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Ungültiger Parameter: ${warning.invalidVariables.join(", ")}`
        : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    variableAction: "Kanalvariable ändern", variableSelect: "Variable", variableSelectHint: "Wird atomar mit dem Befehl geändert.", variableNone: "Keine Kanalvariablen angelegt.",
    variableOperations: { add: "+", subtract: "−", set: "=", set_argument: "Argument" },
    variableOperationHelp: { add: "Zählt hoch.", subtract: "Zählt herunter.", set: "Setzt auf den Wert.", set_argument: "Setzt auf das erste Argument. Ungültige Zahlen zeigen den Nutzungshinweis." },
    variableAmount: "Betrag", variableActionInvalid: "Kanalvariable und Betrag prüfen oder die Aktion ausschalten.", variableSilentHint: "Antwort leer lassen, um still zu zählen.", variableEveryoneWarning: "Jeder im Chat kann diese Variable ändern.",
    timeoutAction: "Timeoutaktion",
    timeoutMinSeconds: "Mindestens", timeoutMaxSeconds: "Höchstens", timeoutDuration: "Dauer", timeoutRangeHint: "1 s bis 14 Tage.", timeoutRangeInvalid: "Die Dauer muss zwischen 1 s und 14 Tagen liegen; das Minimum darf das Maximum nicht überschreiten.",
    timeoutFallbackText: "Ersatztext, wenn der Timeout abgelehnt wird", timeoutFallbackTextOptional: "Ersatztext bei Ablehnung (optional)", timeoutBotWarning: "Der Bot ist kein Moderator. Timeouts können nicht ausgeführt werden.", timeoutNone: "Aus",
    timeoutReason: "Timeout-Grund", timeoutReasonHint: "Optionaler Grund, der an Twitch gesendet wird.",
    actionResponse: (name, operation, amount) => operation === "add" ? `Ändert ${name} um +${String(amount ?? 1)}`
      : operation === "subtract" ? `Ändert ${name} um −${String(amount ?? 1)}`
        : operation === "set" ? `Setzt ${name} auf ${String(amount ?? 0)}` : `Setzt ${name} auf das erste Argument`,
    externalCooldownWarning: "Fragt Twitch bei jedem Auslösen. Eine Abkühlzeit von mindestens 5 Sekunden wird empfohlen.",
    argsEveryoneWarning: "Mit {args} kann jede Person im Chat Text an den Bot übergeben.",
  },
  en: {
    title: "Text commands", search: "Search commands", statusFilter: "Status", filterAll: "All", filterActive: "Active", filterInactive: "Inactive", allModules: "All modules", usedModuleVariables: "Uses module variables", entryCount: (count) => `${String(count)} ${count === 1 ? "entry" : "entries"}`, triggerSection: "Triggers", selectionPrompt: "Select a text command", selectionDescription: "Select a text command on the left or create a new one.", noResponse: "No response text", useCount: (count) => `${String(count)}× used`, details: (name) => `Properties for !${name}`, add: "Add command", newCommand: "New", empty: "No text commands yet.",
    loadError: "The text commands could not be loaded.", templateVariablesLoadError: "Template variables could not be loaded.",
    saveError: "The text command could not be saved.", deleteError: "The text command could not be deleted.",
    name: "Command name", aliases: "Other triggers", aliasPlaceholder: "Add alias", templateFieldLabels: { usageText: "Reply when arguments are missing or invalid" }, usageAdvanced: "Advanced", usageTextHint: "Sent when required arguments are missing or invalid.", textBlockDescription: "Text block", createVariable: "Create variable",
    shoutoutCooldownHint: "Twitch enforces shoutout cooldowns: 2 minutes per channel and 60 minutes per target.",
    kind: "Response type", kindLabels: { text: "Response text", list: "Command list", shoutout: "Shoutout", timeout: "Timeout" },
    kindHints: {
      text: "Replies with the text below.", list: "Lists all enabled commands (without aliases).",
      shoutout: "!so <name> recommends a Twitch channel in chat.",
      timeout: "Times out the caller; the response is sent on success and the fallback on rejection.",
    },
    slashCommands: {
      timeout: { syntax: "/timeout {user} <seconds|min-max> [reason]", description: "Times out the caller; duration and reason are saved as fields." },
      announce: { syntax: "/announce <text>", description: "Sends the following text as a Twitch announcement." },
      shoutout: { syntax: "/shoutout {target}", description: "Creates a shoutout command; the target comes from its command argument." },
    },
    slashCommandHelp: "Leading Twitch-style commands are converted to structured fields when saved.",
    slashUnsupportedWarning: "This slash command remains response text.",
    slashSyntaxError: (command) => `Invalid syntax: ${({
      timeout: "/timeout {user} <seconds|min-max> [reason]",
      announce: "/announce <text>",
      shoutout: "/shoutout {target}",
    } as const)[command]}`,
    slashTimeoutEffect: (minimum, maximum) => `Times out the caller for ${minimum === maximum ? `${String(minimum)} s` : `${String(minimum)}–${String(maximum)} s`}.`,
    slashAnnouncementEffect: "Sent as a Twitch announcement.",
    slashShoutoutEffect: "The shoutout target comes from the command argument.",
    response: "Response text", insertVariable: "Insert variable", currencyToken: "Currency variable", currencyFrom: "From", currencyTo: "To", responseOptional: "Response text (optional)", responseHint: "What the bot says. Type { to open variables.", responseMissing: "Enter a response.", fieldTooLong: "Use at most 500 characters.",
    minimumTier: "Who can use it", minimumRole: "Minimum role",
    tierLabels: { everyone: "Everyone", subscriber: "Subscribers", vip: "VIPs", moderator: "Moderators", broadcaster: "Broadcaster" },
    tierSubjects: { viewer: "viewers", subscriber: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcasters" },
    tierDescription: (tier, subjects) => {
      if (tier === "everyone") return "Everyone in chat can trigger this command.";
      const joined = subjects.length < 2 ? subjects[0] ?? "" : `${subjects.slice(0, -1).join(", ")}, and ${subjects[subjects.length - 1] ?? ""}`;
      const excluded = tier === "subscriber" ? " VIPs are excluded." : tier === "vip" ? " Subscribers are excluded." : "";
      return `${joined}.${excluded}`;
    },
    tierHelp: "Moderators and broadcasters can always use it.",
    responseType: "Send as", responseTypeLabels: { say: "Message", reply: "Reply", announcement: "Announcement" },
    chatTarget: "Chat target", chatTargetDefault: "Channel default", chatTargetLabels: { all_chats: "All chats", source_only: "Only our chat", where_asked: "Automatic" },
    responseTypeHints: {
      say: "Sends a normal chat message.",
      reply: "Visibly replies to the message that triggered the command.",
      announcement: "Highlights the message as an announcement. The bot must be a moderator.",
    },
    announcementWarning: "The bot is not a moderator here — the text will be sent as a normal message.",
    streamCondition: "Only available", streamLabels: { any: "Always", online: "Stream live", offline: "Stream offline" },
    streamHints: { any: "Works regardless of stream status.", online: "Works only while the stream is live.", offline: "Works only while the stream is offline." },
    gameFilter: "Only for games",
    gameFilterHint: "The command only replies while one of these games is current.",
    availability: "More settings",
    gameMultiSelect: { label: "Twitch games", hint: "Search and select games from Twitch categories.", search: "Search games", searchHint: "Enter at least two characters.", loading: "Searching games …", empty: "No games found.", error: "Twitch games could not be loaded.", suggestions: "Suggestions", allGames: "All games", limitReached: "10-game limit reached; remove one to add another.", selectedCount: formatCount, remove: (name) => `Remove ${name}` },
    cooldown: "Cooldown", cooldownField: "Between uses", userCooldown: "Per user", cooldownHint: "For the whole channel. 0 to 86,400.", userCooldownHint: "For each viewer separately. 0 = off.", numberMissing: "Enter a number.",
    nameHint: "a–z, 0–9, - and _",
    nameInvalid: "Use lowercase letters, numbers, hyphen, and underscore.", nameMissing: "Enter a name.", nameExists: "This command already exists.",
    nameAliasConflict: (trigger, command) => `!${trigger} is already an alias for !${command}.`,
    aliasConflict: (trigger, command) => trigger === command ? `!${trigger} is already the command !${command}.` : `!${trigger} is already an alias for !${command}.`,
    aliasInvalid: (trigger) => `!${trigger} — use lowercase letters, numbers, - and _.`,
    aliasIsName: "This is already the command name.", aliasPendingInvalid: "Commit or remove the pending alias first.",
    aliasRemove: (alias) => `Remove alias ${alias}`, aliasList: "Aliases",
    delete: "Delete command", deleteTitle: (name) => `Delete command !${name}?`,
    deleteConfirmation: (name, aliases) => aliases.length === 0
      ? `Command !${name} will be deleted and will no longer reply in chat.`
      : `Command !${name} and its aliases ${aliases.map((alias) => `!${alias}`).join(", ")} will no longer be available in chat.`,
    deleteConfirm: (name) => `Delete command !${name}`, deleteCancel: "Cancel", back: "Back",
    draftGuardTitle: "Unsaved changes",
    draftGuardDescription: "This command has unsaved changes. What would you like to do?",
    continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch",
    save: "Save", create: "Create", discard: "Discard", saved: "All changes saved",
    pending: "Saving …", invalid: "Check marked fields.", issueError: "Error", issueWarning: "Warning",
    conflictMessage: "This command was changed by someone else.", reloadError: "The server version could not be loaded.", reload: "Load server version",
    managementLocked: "Only broadcasters and managers can change settings.",
    active: "Active", ready: "Ready", variableBadge: "Variable",
    never: "never", secondsAgo: (count) => `${String(count)} s ago`, minutesAgo: (count) => `${String(count)} min ago`, hoursAgo: (count) => `${String(count)} h ago`,
    lastUsed: "last used",
    previewLabel: "Preview", previewSpeaker: "BroBot",
    templateMessages: templateMessages.en,
    chipsInputMessages: { countLabel: formatCount, atLimitHint: "Up to 10 aliases.", duplicateWarning: (alias) => `${alias} is already in the list.` },
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Invalid parameter: ${warning.invalidVariables.join(", ")}`
        : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    variableAction: "Change channel variable", variableSelect: "Variable", variableSelectHint: "Applied atomically with the command.", variableNone: "No channel variables have been created.",
    variableOperations: { add: "+", subtract: "−", set: "=", set_argument: "Argument" },
    variableOperationHelp: { add: "Increase the value.", subtract: "Decrease the value.", set: "Set the value directly.", set_argument: "Set from the first argument. Invalid numbers show the usage response." },
    variableAmount: "Amount", variableActionInvalid: "Choose a channel variable and valid amount, or turn this action off.", variableSilentHint: "Leave the response empty to count silently.", variableEveryoneWarning: "Everyone in chat can change this variable.",
    timeoutAction: "Timeout action",
    timeoutMinSeconds: "Minimum", timeoutMaxSeconds: "Maximum", timeoutDuration: "Duration", timeoutRangeHint: "1 s to 14 days.", timeoutRangeInvalid: "Duration must be 1 s to 14 days, and the minimum cannot exceed the maximum.",
    timeoutFallbackText: "Fallback text when the timeout is rejected", timeoutFallbackTextOptional: "Fallback text on rejection (optional)", timeoutBotWarning: "The bot is not a moderator. It cannot time out callers.", timeoutNone: "Off",
    timeoutReason: "Timeout reason", timeoutReasonHint: "Optional reason sent to Twitch.",
    actionResponse: (name, operation, amount) => operation === "add" ? `Changes ${name} by +${String(amount ?? 1)}`
      : operation === "subtract" ? `Changes ${name} by −${String(amount ?? 1)}`
        : operation === "set" ? `Sets ${name} to ${String(amount ?? 0)}` : `Sets ${name} from the first argument`,
    externalCooldownWarning: "Requests Twitch every time the command runs. A cooldown of at least 5 seconds is recommended.",
    argsEveryoneWarning: "With {args}, anyone in chat can pass text to the bot.",
  },
};

export const textCommandsTexts = (language: DashboardLanguage = dashboardLanguage()): TextCommandsTexts => catalog[language];
