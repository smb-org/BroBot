import type { DashboardLanguage } from "../../../dashboard/locale";
import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";

const templateMessages: Readonly<Record<DashboardLanguage, TemplateTextFieldMessages>> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name) => `Unbekannte Variable {${name}}.`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; höchstens ${String(maximum)}.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "",
      groupLabels: { channel: "Kanal", module: "Modul", own: "Eigene", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einsetzen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name) => `Unknown variable {${name}}.`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; at most ${String(maximum)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "",
      groupLabels: { channel: "Channel", module: "Module", own: "Own", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

export const tempVipsSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  return {
    title: de ? "Einstellungen für temporäre VIPs" : "Temporary VIP settings",
    ariaLabel: de ? "Einstellungen für temporäre VIPs" : "Temporary VIP settings",
    readOnlyReason: de ? "Du kannst diese Einstellungen nicht ändern." : "You cannot change these settings.",
    saveLabel: de ? "Speichern" : "Save",
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: de ? "Gespeichert" : "Saved",
    pendingLabel: de ? "Wird gespeichert …" : "Saving …",
    invalidMessage: de ? "Prüfe die Einstellungen." : "Check the settings.",
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    saveError: de ? "Die Einstellungen konnten nicht gespeichert werden." : "The settings could not be saved.",
    conflictMessage: de ? "Die Einstellungen wurden inzwischen geändert." : "The settings changed while you were editing them.",
    reloadLabel: de ? "Neu laden" : "Reload",
    enabledLabel: de ? "Aktiviert" : "Enabled",
    disabledLabel: de ? "Deaktiviert" : "Disabled",
    templateMessages: templateMessages[language],
    warningLabel: () => de ? "Prüfe den Hinweis." : "Check the notice.",
    sections: { settings: de ? "Ablauf" : "Timing" },
    notes: {
      ownershipCaveat: de
        ? "Hinweis: Verliert Twitch eine Meldung über ein von Hand entzogenes VIP, kann der Bot ein später dauerhaft vergebenes VIP beim Ablauf entfernen. Dafür gibt es „Verwaltung abgeben“."
        : "Note: If Twitch loses an event about a manually removed VIP, the bot may remove a VIP you later granted permanently when it expires. Use “Release management” for that.",
    },
    fields: {
      defaultDurationDays: {
        label: de ? "Standarddauer" : "Default duration",
        hint: de ? "Wird verwendet, wenn beim Vergeben keine Dauer angegeben ist." : "Used when a grant does not specify a duration.",
        unit: de ? "Tage" : "days",
      },
      maximumDurationDays: {
        label: de ? "Höchstdauer" : "Maximum duration",
        hint: de ? "Begrenzt die gesamte verbleibende VIP-Zeit." : "Limits the total remaining VIP time.",
        unit: de ? "Tage" : "days",
      },
      announceExpiry: {
        label: de ? "Ablauf im Chat melden" : "Announce expiry in chat",
        hint: de ? "Meldet im Chat, wenn ein temporäres VIP abläuft." : "Post a chat message when a temporary VIP expires.",
      },
    },
  };
};
