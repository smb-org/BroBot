import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { DashboardLanguage } from "../../../dashboard/locale";

const templateMessages: Readonly<Record<DashboardLanguage, TemplateTextFieldMessages>> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name) => `Unbekannte Variable {${name}}.`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; Twitch lehnt Nachrichten über ${String(maximum)} Zeichen ab.`,
    picker: { title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "", groupLabels: { channel: "Kanal", module: "Modul", own: "Eigene", text_blocks: "Textbausteine" }, keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" } },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name) => `Unknown variable {${name}}.`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; Twitch rejects messages over ${String(maximum)} characters.`,
    picker: { title: "Choose a variable", noResults: "No variables found.", externalHelp: "", groupLabels: { channel: "Channel", module: "Module", own: "Own", text_blocks: "Text blocks" }, keyHints: { navigate: "select", insert: "insert", close: "close" } },
  },
};

const catalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  return {
    title: de ? "Quiz-Einstellungen" : "Quiz settings",
    ariaLabel: de ? "Quiz-Einstellungen" : "Quiz settings",
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
    sections: {
      rules: de ? "Ablauf" : "Timing",
      reward: de ? "Punkte" : "Points",
      chat: de ? "Chat" : "Chat",
    },
    fields: {
      answerSeconds: {
        label: de ? "Antwortzeit" : "Answer window",
        hint: de ? "Zeit zum Antworten auf jede Frage." : "Time viewers have to answer each question.",
        unit: "s",
        invalidError: de ? "Wähle 5 bis 300 Sekunden." : "Choose 5 to 300 seconds.",
      },
      revealSeconds: {
        label: de ? "Lösungszeit" : "Reveal time",
        hint: de ? "Wie lange die Lösung vor der nächsten Frage angezeigt wird." : "How long the answer is shown before the next question.",
        unit: "s",
        invalidError: de ? "Wähle 1 bis 60 Sekunden." : "Choose 1 to 60 seconds.",
      },
      pot: {
        label: de ? "Punktepott" : "Points pot",
        hint: de ? "Wird anhand der richtigen Antworten aus dem Hauskonto verteilt." : "Paid from the house account in proportion to correct answers.",
        unit: de ? "Punkte" : "points",
        zeroValueLabel: de ? "Nur Rangliste" : "Ranking only",
        invalidError: de ? "Wähle 0 bis 100.000 Punkte." : "Choose 0 to 100,000 points.",
      },
      chatQuestions: {
        label: de ? "Quiznachrichten im Chat" : "Quiz messages in chat",
        hint: de ? "Start, Fragen mit Optionen und Ergebnis mit den besten drei werden gesendet." : "Send the start, questions with options, and the top-three result.",
      },
    },
  };
};

export const quizSettingsEditorCatalog = { de: catalog("de"), en: catalog("en") } as const;
