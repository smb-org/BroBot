import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { ModuleChatStatus } from "../contract";
import type { TextCommandKind, TextCommandMinimumTier, TextCommandResponseType, TextCommandStreamCondition } from "../contracts";
import type { TagInputMessages, TextAreaMessages } from "../../../dashboard/ui";
import type { PanelTemplateWarning } from "../contract";

export interface TextCommandsTexts {
  title: string;
  tabs: { settings: string; advanced: string };
  list: string;
  details: (name: string) => string;
  add: string;
  empty: string;
  load: string;
  loadError: string;
  saveError: string;
  deleteError: string;
  name: string;
  aliases: string;
  templateFieldLabels: { usageText: string };
  createVariable: string;
  shoutoutCooldownHint: string;
  kind: string;
  kindLabels: Record<TextCommandKind, string>;
  kindHints: Record<TextCommandKind, string>;
  response: string;
  responseHint: string;
  responseMissing: string;
  minimumTier: string;
  minimumTierLocked: string;
  tierLabels: Record<TextCommandMinimumTier, string>;
  tierSubjects: Record<ModuleChatStatus, string>;
  tierDescription: (tier: TextCommandMinimumTier, subjects: readonly string[]) => string;
  tierHelp: string;
  responseType: string;
  responseTypeLabels: Record<TextCommandResponseType, string>;
  responseTypeHints: Record<TextCommandResponseType, string>;
  announcementWarning: string;
  botIsModerator: string;
  streamCondition: string;
  streamLabels: Record<TextCommandStreamCondition, string>;
  streamHints: Record<TextCommandStreamCondition, string>;
  cooldown: string;
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
  aliasHint: string;
  aliasCount: (count: number, max: number) => string;
  aliasAtLimit: string;
  aliasDuplicate: (alias: string) => string;
  aliasRemove: (alias: string) => string;
  aliasList: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteConfirmation: (name: string, aliases: readonly string[]) => string;
  deleteConfirm: (name: string) => string;
  deleteCancel: string;
  draftGuardTitle: string;
  draftGuardDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
  close: string;
  save: string;
  create: string;
  discard: string;
  saved: string;
  saving: string;
  pending: string;
  invalid: string;
  issueError: string;
  issueWarning: string;
  conflictMessage: string;
  reload: string;
  managementLocked: string;
  active: string;
  activeImmediately: string;
  enabled: string;
  disabled: string;
  noAliases: string;
  never: string;
  secondsAgo: (count: number) => string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  createdAt: string;
  updatedAt: string;
  lastUsed: string;
  previewLabel: string;
  previewSpeaker: string;
  statusLabels: Record<ModuleChatStatus, string>;
  streamAny: string;
  streamOnline: string;
  streamOffline: string;
  cooldownOff: string;
  notModerator: string;
  textAreaMessages: TextAreaMessages;
  variableAction: string;
  variableSelect: string;
  variableSelectHint: string;
  variableNone: string;
  variableOperations: Record<"add" | "subtract" | "set" | "set_argument", string>;
  variableOperationHelp: Record<"add" | "subtract" | "set" | "set_argument", string>;
  variableAmount: string;
  variableSilentHint: string;
  variableEveryoneWarning: string;
  actionResponse: (name: string, operation: "add" | "subtract" | "set" | "set_argument", amount: number | null) => string;
  externalCooldownWarning: string;
  argsEveryoneWarning: string;
  tagInputMessages: TagInputMessages;
  warningLabel: (warning: PanelTemplateWarning) => string;
  columns: { name: string; kind: string; response: string; minimumTier: string; active: string };
}

const templateMessages: LocaleCatalog<TextAreaMessages> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    unknownVariable: (name, suggestion, available) => suggestion === null
      ? `Unbekannte Variable {${name}} — wird wörtlich gesendet. Verfügbar: ${available.map((item) => `{${item}}`).join(", ")}`
      : `Unbekannte Variable {${name}} — wird wörtlich gesendet. Meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    worstCaseLength: (length, maximum) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maximum)} ab.`,
    variablePicker: {
      triggerLabel: "Variable einfügen", title: "Variable auswählen", searchLabel: "Variablen suchen", closeLabel: "Variablenauswahl schließen",
      noResults: "Keine Variablen gefunden.", createVariableLabel: "Variable anlegen …", externalHelp: "Fragt Twitch live ab, wenn der Befehl ausgeführt wird",
      groupLabels: { context: "Kontext", stream: "Stream", person: "Person", command: "Befehl", time_random: "Zeit & Zufall", event: "Ereignis", channel: "Kanalvariablen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} characters`,
    unknownVariable: (name, suggestion, available) => suggestion === null
      ? `Unknown variable {${name}} — it will be sent literally. Available: ${available.map((item) => `{${item}}`).join(", ")}`
      : `Unknown variable {${name}} — it will be sent literally. Did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    worstCaseLength: (length, maximum) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maximum)}.`,
    variablePicker: {
      triggerLabel: "Insert variable", title: "Choose a variable", searchLabel: "Search variables", closeLabel: "Close variable picker",
      noResults: "No variables found.", createVariableLabel: "Create variable …", externalHelp: "Looks up live data from Twitch when the command runs",
      groupLabels: { context: "Context", stream: "Stream", person: "Person", command: "Command", time_random: "Time & random", event: "Event", channel: "Channel variables" },
    },
  },
};

const catalog: LocaleCatalog<TextCommandsTexts> = {
  de: {
    title: "Textbefehle", tabs: { settings: "Einstellungen", advanced: "Erweitert" }, list: "Befehle", details: (name) => `Eigenschaften von !${name}`, add: "Befehl anlegen", empty: "Noch keine Textbefehle angelegt.",
    load: "Textbefehle werden geladen …", loadError: "Die Textbefehle konnten nicht geladen werden.",
    saveError: "Der Textbefehl konnte nicht gespeichert werden.", deleteError: "Der Textbefehl konnte nicht gelöscht werden.",
    name: "Name", aliases: "Aliase", templateFieldLabels: { usageText: "Nutzungshinweis" }, createVariable: "Variable anlegen",
    shoutoutCooldownHint: "Twitch begrenzt Shoutouts selbst: 2 Minuten pro Kanal und 60 Minuten pro Ziel.",
    kind: "Art", kindLabels: { text: "Antworttext", list: "Befehlsliste", shoutout: "Shoutout" },
    kindHints: {
      text: "Antwortet mit dem Text unten.", list: "Zählt alle eingeschalteten Befehle auf (ohne Aliase).",
      shoutout: "!so <name> empfiehlt einen Twitch-Kanal im Chat.",
    },
    response: "Antwort", responseHint: "Was der Bot schreibt. { öffnet die Variablen.", responseMissing: "Antworttext ausfüllen.",
    minimumTier: "Wer darf auslösen", minimumTierLocked: "Nur Broadcaster und Verwalter dürfen Mindeststufen ändern.",
    tierLabels: { everyone: "Alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    tierSubjects: { viewer: "Zuschauer", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    tierDescription: (tier, subjects) => {
      const joined = subjects.length < 2 ? subjects[0] ?? "" : `${subjects.slice(0, -1).join(", ")} und ${subjects[subjects.length - 1] ?? ""}`;
      const excluded = tier === "subscriber" ? " VIPs nicht." : tier === "vip" ? " Abonnenten nicht." : "";
      return `${joined}.${excluded}`;
    },
    tierHelp: "Moderatoren und Broadcaster dürfen immer.",
    responseType: "Antwortart", responseTypeLabels: { say: "Nachricht", reply: "Antwort", announcement: "Ankündigung" },
    responseTypeHints: {
      say: "Schreibt eine normale Nachricht in den Chat.",
      reply: "Antwortet sichtbar auf die Nachricht, die den Befehl ausgelöst hat.",
      announcement: "Hebt die Nachricht als Ankündigung hervor. Der Bot muss Moderator sein.",
    },
    announcementWarning: "Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.",
    botIsModerator: "Der Bot muss Moderator im Kanal sein.",
    streamCondition: "Stream", streamLabels: { any: "Immer", online: "Online", offline: "Offline" },
    streamHints: { any: "Wirkt unabhängig vom Stream.", online: "Wirkt nur, während der Stream läuft.", offline: "Wirkt nur, während der Stream aus ist." },
    cooldown: "Abkühlzeit", userCooldown: "Je Nutzer", cooldownHint: "Für den ganzen Kanal. 0 bis 86 400.", userCooldownHint: "Für jeden Zuschauer einzeln. 0 = aus.", numberMissing: "Zahl eingeben.",
    nameHint: "a–z, 0–9, - und _",
    nameInvalid: "Nur Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.", nameMissing: "Namen ausfüllen.", nameExists: "Der Befehl existiert bereits.",
    nameAliasConflict: (trigger, command) => `!${trigger} ist schon ein Alias von !${command}.`,
    aliasConflict: (trigger, command) => trigger === command ? `!${trigger} ist schon der Befehl !${command}.` : `!${trigger} ist schon ein Alias von !${command}.`,
    aliasInvalid: (trigger) => `!${trigger} — nur Kleinbuchstaben, Zahlen, - und _.`,
    aliasIsName: "Das ist schon der Name.", aliasHint: "Weitere Namen für denselben Befehl. Enter, Komma oder Leerzeichen trennt.",
    aliasCount: (count, max) => `${String(count)} von ${String(max)}`, aliasAtLimit: "Höchstens 10 Aliase.",
    aliasDuplicate: (alias) => `${alias} steht schon in der Liste.`, aliasRemove: (alias) => `Alias ${alias} entfernen`, aliasList: "Aliase",
    delete: "Befehl löschen", deleteTitle: (name) => `Befehl !${name} löschen?`,
    deleteConfirmation: (name, aliases) => aliases.length === 0
      ? `Der Textbefehl !${name} wird dauerhaft gelöscht. Diese Handlung kann nicht rückgängig gemacht werden.`
      : `Der Textbefehl !${name} wird dauerhaft gelöscht. Löscht auch die Aliase ${aliases.map((alias) => `!${alias}`).join(", ")}.`,
    deleteConfirm: (name) => `Befehl !${name} endgültig löschen`, deleteCancel: "Abbrechen",
    draftGuardTitle: "Ungespeicherte Änderungen",
    draftGuardDescription: "Du hast Änderungen an diesem Befehl. Was möchtest du tun?",
    continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln", close: "Schließen",
    save: "Änderungen speichern", create: "Anlegen", discard: "Verwerfen", saved: "Gespeichert.", saving: "Wird gespeichert …",
    pending: "Wird gespeichert …", invalid: "Bitte korrigiere die markierten Felder.", issueError: "Fehler", issueWarning: "Hinweis",
    conflictMessage: "Inzwischen von jemand anderem geändert.", reload: "Serverstand laden",
    managementLocked: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.",
    active: "Aktiv", activeImmediately: "wirkt sofort", enabled: "eingeschaltet", disabled: "ausgeschaltet", noAliases: "keine",
    never: "noch nie", secondsAgo: (count) => `vor ${String(count)} s`, minutesAgo: (count) => `vor ${String(count)} min`, hoursAgo: (count) => `vor ${String(count)} h`,
    createdAt: "Angelegt", updatedAt: "Geändert", lastUsed: "Zuletzt verwendet",
    previewLabel: "Vorschau", previewSpeaker: "Bot",
    statusLabels: { viewer: "Zuschauer", subscriber: "Abonnent", vip: "VIP", moderator: "Moderator", broadcaster: "Broadcaster" },
    streamAny: "immer", streamOnline: "nur online", streamOffline: "nur offline", cooldownOff: "aus", notModerator: "kein Moderator",
    textAreaMessages: templateMessages.de,
    tagInputMessages: { countLabel: (count, max) => `${String(count)} von ${String(max)}`, atLimitHint: "Höchstens 10 Aliase.", duplicateWarning: (alias) => `${alias} steht schon in der Liste.` },
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Ungültiger Parameter: ${warning.invalidVariables.join(", ")}`
        : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    columns: { name: "!Name", kind: "Art", response: "Antwort", minimumTier: "Mindeststufe", active: "Aktiv" },
    variableAction: "Kanalvariable ändern", variableSelect: "Variable", variableSelectHint: "Wird atomar mit dem Befehl geändert.", variableNone: "Keine Kanalvariablen angelegt.",
    variableOperations: { add: "+", subtract: "−", set: "=", set_argument: "Argument" },
    variableOperationHelp: { add: "Zählt hoch.", subtract: "Zählt herunter.", set: "Setzt auf den Wert.", set_argument: "Setzt auf das erste Argument. Ungültige Zahlen zeigen den Nutzungshinweis." },
    variableAmount: "Betrag", variableSilentHint: "Antwort leer lassen, um still zu zählen.", variableEveryoneWarning: "Jeder im Chat kann diese Variable ändern.",
    actionResponse: (name, operation, amount) => operation === "add" ? `Ändert ${name} um +${String(amount ?? 1)}`
      : operation === "subtract" ? `Ändert ${name} um −${String(amount ?? 1)}`
        : operation === "set" ? `Setzt ${name} auf ${String(amount ?? 0)}` : `Setzt ${name} auf das erste Argument`,
    externalCooldownWarning: "Fragt Twitch bei jedem Auslösen. Eine Abkühlzeit von mindestens 5 Sekunden wird empfohlen.",
    argsEveryoneWarning: "Mit {args} kann jede Person im Chat Text an den Bot übergeben.",
  },
  en: {
    title: "Text commands", tabs: { settings: "Settings", advanced: "Advanced" }, list: "Commands", details: (name) => `Properties for !${name}`, add: "Add command", empty: "No text commands yet.",
    load: "Loading text commands …", loadError: "The text commands could not be loaded.",
    saveError: "The text command could not be saved.", deleteError: "The text command could not be deleted.",
    name: "Name", aliases: "Aliases", templateFieldLabels: { usageText: "Usage response" }, createVariable: "Create variable",
    shoutoutCooldownHint: "Twitch enforces shoutout cooldowns: 2 minutes per channel and 60 minutes per target.",
    kind: "Type", kindLabels: { text: "Response text", list: "Command list", shoutout: "Shoutout" },
    kindHints: {
      text: "Replies with the text below.", list: "Lists all enabled commands (without aliases).",
      shoutout: "!so <name> recommends a Twitch channel in chat.",
    },
    response: "Response", responseHint: "What the bot says. Type { to open variables.", responseMissing: "Enter a response.",
    minimumTier: "Who can use it", minimumTierLocked: "Only broadcasters and managers may change minimum levels.",
    tierLabels: { everyone: "Everyone", subscriber: "Subscribers", vip: "VIPs", moderator: "Moderators", broadcaster: "Broadcaster" },
    tierSubjects: { viewer: "viewers", subscriber: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcasters" },
    tierDescription: (tier, subjects) => {
      const joined = subjects.length < 2 ? subjects[0] ?? "" : `${subjects.slice(0, -1).join(", ")}, and ${subjects[subjects.length - 1] ?? ""}`;
      const excluded = tier === "subscriber" ? " VIPs are excluded." : tier === "vip" ? " Subscribers are excluded." : "";
      return `${joined}.${excluded}`;
    },
    tierHelp: "Moderators and broadcasters can always use it.",
    responseType: "Response type", responseTypeLabels: { say: "Message", reply: "Reply", announcement: "Announcement" },
    responseTypeHints: {
      say: "Sends a normal chat message.",
      reply: "Visibly replies to the message that triggered the command.",
      announcement: "Highlights the message as an announcement. The bot must be a moderator.",
    },
    announcementWarning: "The bot is not a moderator here — the text will be sent as a normal message.",
    botIsModerator: "The bot must be a channel moderator.",
    streamCondition: "Stream", streamLabels: { any: "Always", online: "Online", offline: "Offline" },
    streamHints: { any: "Works regardless of stream status.", online: "Works only while the stream is live.", offline: "Works only while the stream is offline." },
    cooldown: "Cooldown", userCooldown: "Per user", cooldownHint: "For the whole channel. 0 to 86,400.", userCooldownHint: "For each viewer separately. 0 = off.", numberMissing: "Enter a number.",
    nameHint: "a–z, 0–9, - and _",
    nameInvalid: "Use lowercase letters, numbers, hyphen, and underscore.", nameMissing: "Enter a name.", nameExists: "This command already exists.",
    nameAliasConflict: (trigger, command) => `!${trigger} is already an alias for !${command}.`,
    aliasConflict: (trigger, command) => trigger === command ? `!${trigger} is already the command !${command}.` : `!${trigger} is already an alias for !${command}.`,
    aliasInvalid: (trigger) => `!${trigger} — use lowercase letters, numbers, - and _.`,
    aliasIsName: "This is already the command name.", aliasHint: "Other names for the same command. Enter, comma, or space separates them.",
    aliasCount: (count, max) => `${String(count)} of ${String(max)}`, aliasAtLimit: "Up to 10 aliases.",
    aliasDuplicate: (alias) => `${alias} is already in the list.`, aliasRemove: (alias) => `Remove alias ${alias}`, aliasList: "Aliases",
    delete: "Delete command", deleteTitle: (name) => `Delete !${name}?`,
    deleteConfirmation: (name, aliases) => aliases.length === 0
      ? `The text command !${name} will be deleted permanently. This action cannot be undone.`
      : `The text command !${name} will be deleted permanently. This also deletes aliases ${aliases.map((alias) => `!${alias}`).join(", ")}.`,
    deleteConfirm: (name) => `Delete !${name} permanently`, deleteCancel: "Cancel",
    draftGuardTitle: "Unsaved changes",
    draftGuardDescription: "This command has unsaved changes. What would you like to do?",
    continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch", close: "Close",
    save: "Save changes", create: "Create", discard: "Discard", saved: "Saved.", saving: "Saving …",
    pending: "Saving …", invalid: "Please correct the marked fields.", issueError: "Error", issueWarning: "Warning",
    conflictMessage: "This command was changed by someone else.", reload: "Load server version",
    managementLocked: "Only broadcasters and managers may add, edit, or delete commands.",
    active: "Active", activeImmediately: "takes effect immediately", enabled: "enabled", disabled: "disabled", noAliases: "none",
    never: "never", secondsAgo: (count) => `${String(count)} s ago`, minutesAgo: (count) => `${String(count)} min ago`, hoursAgo: (count) => `${String(count)} h ago`,
    createdAt: "Created", updatedAt: "Updated", lastUsed: "Last used",
    previewLabel: "Preview", previewSpeaker: "Bot",
    statusLabels: { viewer: "Viewer", subscriber: "Subscriber", vip: "VIP", moderator: "Moderator", broadcaster: "Broadcaster" },
    streamAny: "always", streamOnline: "online only", streamOffline: "offline only", cooldownOff: "off", notModerator: "not a moderator",
    textAreaMessages: templateMessages.en,
    tagInputMessages: { countLabel: (count, max) => `${String(count)} of ${String(max)}`, atLimitHint: "Up to 10 aliases.", duplicateWarning: (alias) => `${alias} is already in the list.` },
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Invalid parameter: ${warning.invalidVariables.join(", ")}`
        : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    columns: { name: "!Name", kind: "Type", response: "Response", minimumTier: "Minimum level", active: "Active" },
    variableAction: "Change channel variable", variableSelect: "Variable", variableSelectHint: "Applied atomically with the command.", variableNone: "No channel variables have been created.",
    variableOperations: { add: "+", subtract: "−", set: "=", set_argument: "Argument" },
    variableOperationHelp: { add: "Increase the value.", subtract: "Decrease the value.", set: "Set the value directly.", set_argument: "Set from the first argument. Invalid numbers show the usage response." },
    variableAmount: "Amount", variableSilentHint: "Leave the response empty to count silently.", variableEveryoneWarning: "Everyone in chat can change this variable.",
    actionResponse: (name, operation, amount) => operation === "add" ? `Changes ${name} by +${String(amount ?? 1)}`
      : operation === "subtract" ? `Changes ${name} by −${String(amount ?? 1)}`
        : operation === "set" ? `Sets ${name} to ${String(amount ?? 0)}` : `Sets ${name} from the first argument`,
    externalCooldownWarning: "Requests Twitch every time the command runs. A cooldown of at least 5 seconds is recommended.",
    argsEveryoneWarning: "With {args}, anyone in chat can pass text to the bot.",
  },
};

export const textCommandsTexts = (language: DashboardLanguage = dashboardLanguage()): TextCommandsTexts => catalog[language];
