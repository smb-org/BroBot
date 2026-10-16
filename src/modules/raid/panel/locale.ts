import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages = {
  de: {
    countLabel: (count: number, maxLength: number) => `${String(count)} von ${String(maxLength)} Zeichen`,
    previewCountLabel: (count: number) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unbekannte Variable {${name}}.`
      : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name: string) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length: number, maxLength: number) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maxLength)} ab.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn der Befehl ausgeführt wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count: number, maxLength: number) => `${String(count)} of ${String(maxLength)} characters`,
    previewCountLabel: (count: number) => `${String(count)} characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unknown variable {${name}}.`
      : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name: string) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length: number, maxLength: number) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maxLength)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the command runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
} satisfies LocaleCatalog<SettingsEditorCatalog["templateMessages"]>;

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    title: "Raid-Einstellungen",
    ariaLabel: "Raid-Einstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.",
    saveLabel: "Speichern",
    discardLabel: "Verwerfen",
    savedLabel: "Raid-Einstellungen gespeichert.",
    pendingLabel: "Wird gespeichert …",
    invalidMessage: "Bitte korrigiere die markierten Felder.",
    numberMissing: "Zahl eingeben.",
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    saveError: "Die Raid-Einstellungen konnten nicht gespeichert werden.",
    conflictMessage: "Raid-Einstellungen wurden inzwischen geändert.",
    reloadLabel: "Serverstand laden",
    enabledLabel: "An",
    disabledLabel: "Aus",
    templateMessages: templateMessages.de,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Ungültige Variablenparameter: ${warning.invalidVariables.join(", ")}`
        : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    sections: { messages: "Nachrichten", shoutout: "Shoutout & Dankestext" },
    fields: {
      textThreshold: { label: "Text-Schwelle", hint: "Ab dieser Zahl wird der volle Text gesendet, darunter der kurze.", unit: "Zuschauer" },
      textLong: {
        label: "Voller Raid-Text", hint: "Geht raus ab der Text-Schwelle. Leer lassen, um diese Nachricht auszuschalten.", previewLabel: "Vorschau", previewSpeaker: "Bot",
        optionalHint: "Leer lassen, um diese Nachricht auszuschalten.",
        previewEmptyText: "Nachricht ausgeschaltet",
        variables: [{ name: "channel", description: "Anzeigename des raidenden Kanals", sample: "beispielkanal" }, { name: "viewers", description: "Zahl der Zuschauer im Raid", sample: "42" }],
      },
      textLongTarget: { label: "Ziel für vollen Raid-Text", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" }, channel_default: { label: "Kanaleinstellung verwenden" } } },
      textShort: {
        label: "Kurzer Dankestext", hint: "Geht raus bei kleineren Raids. Leer lassen, um diese Nachricht auszuschalten.", previewLabel: "Vorschau", previewSpeaker: "Bot",
        optionalHint: "Leer lassen, um diese Nachricht auszuschalten.",
        previewEmptyText: "Nachricht ausgeschaltet",
        variables: [{ name: "channel", description: "Anzeigename des raidenden Kanals", sample: "beispielkanal" }, { name: "viewers", description: "Zahl der Zuschauer im Raid", sample: "42" }],
      },
      textShortTarget: { label: "Ziel für kurzen Dankestext", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" }, channel_default: { label: "Kanaleinstellung verwenden" } } },
      shoutoutEnabled: { label: "Shoutout automatisch senden", hint: "Der Bot schickt nach einem Raid einen Shoutout, damit andere den Kanal entdecken.", description: "Der Bot schickt nach einem Raid einen Shoutout, damit andere den Kanal entdecken." },
      shoutoutThreshold: { label: "Shoutout-Schwelle", hint: "Ab dieser Zahl sendet der Bot den Shoutout.", unit: "Zuschauer", disabledReason: "Shoutout ist ausgeschaltet." },
    },
  },
  en: {
    title: "Raid settings",
    ariaLabel: "Raid settings",
    readOnlyReason: "Only broadcasters and managers may change raid settings.",
    saveLabel: "Save",
    discardLabel: "Discard",
    savedLabel: "Raid settings saved.",
    pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.",
    numberMissing: "Enter a number.",
    issueLabels: { error: "Error", warning: "Warning" },
    saveError: "Raid settings could not be saved.",
    conflictMessage: "Raid settings have changed since they were loaded.",
    reloadLabel: "Load server version",
    enabledLabel: "On",
    disabledLabel: "Off",
    templateMessages: templateMessages.en,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Invalid variable parameters: ${warning.invalidVariables.join(", ")}`
        : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    sections: { messages: "Messages", shoutout: "Shoutout & thank-you text" },
    fields: {
      textThreshold: { label: "Text threshold", hint: "At this number the full text is sent; smaller raids use the short one.", unit: "viewers" },
      textLong: {
        label: "Full raid text", hint: "Sent at or above the text threshold. Leave blank to turn this message off.", previewLabel: "Preview", previewSpeaker: "Bot",
        optionalHint: "Leave blank to turn this message off.",
        previewEmptyText: "Message is off",
        variables: [{ name: "channel", description: "Display name of the raiding channel", sample: "samplechannel" }, { name: "viewers", description: "Number of viewers in the raid", sample: "42" }],
      },
      textLongTarget: { label: "Full raid text target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" }, channel_default: { label: "Use channel default" } } },
      textShort: {
        label: "Short thank-you text", hint: "Sent for smaller raids. Leave blank to turn this message off.", previewLabel: "Preview", previewSpeaker: "Bot",
        optionalHint: "Leave blank to turn this message off.",
        previewEmptyText: "Message is off",
        variables: [{ name: "channel", description: "Display name of the raiding channel", sample: "samplechannel" }, { name: "viewers", description: "Number of viewers in the raid", sample: "42" }],
      },
      textShortTarget: { label: "Short thank-you target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" }, channel_default: { label: "Use channel default" } } },
      shoutoutEnabled: { label: "Send automatic shoutouts", hint: "After a raid, the bot sends a shoutout so viewers can discover that channel.", description: "After a raid, the bot sends a shoutout so viewers can discover that channel." },
      shoutoutThreshold: { label: "Shoutout threshold", hint: "The bot sends the shoutout at or above this number.", unit: "viewers", disabledReason: "Shoutouts are turned off." },
    },
  },
};

export const raidSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
