import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages = {
  de: {
    countLabel: (count: number, maxLength: number) => `${String(count)} von ${String(maxLength)} Zeichen`,
    previewCountLabel: (count: number) => `${String(count)} Zeichen`,
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unbekannte Variable {${name}} — wird wörtlich gesendet. Nutze den Variablen-Picker.`
      : `Unbekannte Variable {${name}} — wird wörtlich gesendet. Meintest du {${suggestion}}? Nutze den Variablen-Picker.`,
    insertSuggestionLabel: (name: string) => `{${name}} einsetzen`,
    worstCaseLength: (length: number, maxLength: number) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maxLength)} ab.`,
    variablePicker: {
      triggerLabel: "Variable einfügen", title: "Variable auswählen", searchLabel: "Variablen suchen", closeLabel: "Variablenauswahl schließen",
      noResults: "Keine Variablen gefunden.", createVariableLabel: "Variable anlegen …", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { context: "Kontext", stream: "Stream", person: "Person", command: "Befehl", time_random: "Zeit & Zufall", event: "Ereignis", channel: "Kanalvariablen" },
    },
  },
  en: {
    countLabel: (count: number, maxLength: number) => `${String(count)} of ${String(maxLength)} characters`,
    previewCountLabel: (count: number) => `${String(count)} characters`,
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unknown variable {${name}} — it will be sent literally. Use the variable picker.`
      : `Unknown variable {${name}} — it will be sent literally. Did you mean {${suggestion}}? Use the variable picker.`,
    insertSuggestionLabel: (name: string) => `Insert {${name}}`,
    worstCaseLength: (length: number, maxLength: number) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maxLength)}.`,
    variablePicker: {
      triggerLabel: "Insert variable", title: "Choose a variable", searchLabel: "Search variables", closeLabel: "Close variable picker",
      noResults: "No variables found.", createVariableLabel: "Create variable …", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { context: "Context", stream: "Stream", person: "Person", command: "Command", time_random: "Time & random", event: "Event", channel: "Channel variables" },
    },
  },
} satisfies LocaleCatalog<SettingsEditorCatalog["templateMessages"]>;

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    title: "Raid-Einstellungen",
    ariaLabel: "Raid-Einstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.",
    saveLabel: "Raid-Einstellungen speichern",
    discardLabel: "Verwerfen",
    savedLabel: "Raid-Einstellungen gespeichert.",
    pendingLabel: "Wird gespeichert …",
    invalidMessage: "Bitte korrigiere die markierten Felder.",
    numberMissing: "Zahl eingeben.",
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    loadError: "Die Raid-Einstellungen konnten nicht geladen werden.",
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
    sections: { messages: "Nachrichten", shoutout: "Shoutout" },
    fields: {
      textThreshold: { label: "Text-Schwelle", hint: "Ab dieser Zahl wird der volle Text gesendet, darunter der kurze.", unit: "Zuschauer", increaseLabel: "Text-Schwelle erhöhen", decreaseLabel: "Text-Schwelle verringern" },
      textLong: {
        label: "Voller Raid-Text", hint: "Geht raus ab der Text-Schwelle.", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "channel", description: "Anzeigename des raidenden Kanals", sample: "beispielkanal" }, { name: "viewers", description: "Zahl der Zuschauer im Raid", sample: "42" }],
      },
      textShort: {
        label: "Kurzer Dankestext", hint: "Geht raus bei kleineren Raids.", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "channel", description: "Anzeigename des raidenden Kanals", sample: "beispielkanal" }, { name: "viewers", description: "Zahl der Zuschauer im Raid", sample: "42" }],
      },
      shoutoutEnabled: { label: "Helix-Shoutout automatisch senden", hint: "Twitch zeigt den raidenden Kanal als Empfehlung im Chat.", description: "Twitch zeigt den raidenden Kanal als Empfehlung im Chat." },
      shoutoutThreshold: { label: "Shoutout-Schwelle", hint: "Ab dieser Zahl sendet der Bot den Shoutout.", unit: "Zuschauer", disabledReason: "Shoutout ist ausgeschaltet.", increaseLabel: "Shoutout-Schwelle erhöhen", decreaseLabel: "Shoutout-Schwelle verringern" },
    },
  },
  en: {
    title: "Raid settings",
    ariaLabel: "Raid settings",
    readOnlyReason: "Only broadcasters and managers may change raid settings.",
    saveLabel: "Save raid settings",
    discardLabel: "Discard",
    savedLabel: "Raid settings saved.",
    pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.",
    numberMissing: "Enter a number.",
    issueLabels: { error: "Error", warning: "Warning" },
    loadError: "Raid settings could not be loaded.",
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
    sections: { messages: "Messages", shoutout: "Shoutout" },
    fields: {
      textThreshold: { label: "Text threshold", hint: "At this number the full text is sent; smaller raids use the short one.", unit: "viewers", increaseLabel: "Increase text threshold", decreaseLabel: "Decrease text threshold" },
      textLong: {
        label: "Full raid text", hint: "Sent at or above the text threshold.", previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "channel", description: "Display name of the raiding channel", sample: "samplechannel" }, { name: "viewers", description: "Number of viewers in the raid", sample: "42" }],
      },
      textShort: {
        label: "Short thank-you text", hint: "Sent for smaller raids.", previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "channel", description: "Display name of the raiding channel", sample: "samplechannel" }, { name: "viewers", description: "Number of viewers in the raid", sample: "42" }],
      },
      shoutoutEnabled: { label: "Send automatic Helix shoutouts", hint: "Twitch shows the raiding channel as a recommendation in chat.", description: "Twitch shows the raiding channel as a recommendation in chat." },
      shoutoutThreshold: { label: "Shoutout threshold", hint: "The bot sends the shoutout at or above this number.", unit: "viewers", disabledReason: "Shoutouts are turned off.", increaseLabel: "Increase shoutout threshold", decreaseLabel: "Decrease shoutout threshold" },
    },
  },
};

export const raidSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
