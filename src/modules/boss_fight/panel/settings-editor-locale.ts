import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { DashboardLanguage } from "../../../dashboard/locale";
import type { PanelTemplateWarning } from "../../contract";
import { bossFightCatalog } from "../locale";

const templateMessages: Readonly<Record<DashboardLanguage, TemplateTextFieldMessages>> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; Twitch lehnt Nachrichten über ${String(maximum)} Zeichen ab.`,
    picker: { title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "", groupLabels: { channel: "Kanal", module: "Modul", own: "Eigene", text_blocks: "Textbausteine" }, keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" } },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; Twitch rejects messages over ${String(maximum)} characters.`,
    picker: { title: "Choose a variable", noResults: "No variables found.", externalHelp: "", groupLabels: { channel: "Channel", module: "Module", own: "Own", text_blocks: "Text blocks" }, keyHints: { navigate: "select", insert: "insert", close: "close" } },
  },
};

const catalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  const text = bossFightCatalog[language];
  return {
    title: text.title,
    ariaLabel: text.title,
    readOnlyReason: text.readOnlyReason,
    saveLabel: text.save,
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: text.saved,
    pendingLabel: de ? "Wird gespeichert …" : "Saving …",
    invalidMessage: text.invalid,
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    saveError: text.saveError,
    conflictMessage: de ? "Einstellungen wurden inzwischen geändert." : "Settings have changed since they were loaded.",
    reloadLabel: de ? "Serverstand laden" : "Load server version",
    messageEnabledLabel: text.messageEnabled,
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    templateMessages: templateMessages[language],
    sections: { rules: text.rules, reward: text.reward, chat: "Chat", messages: text.messages },
    fields: {
      durationSeconds: { label: text.durationSeconds, hint: de ? "Wie lange der Chat angreifen kann." : "How long chat can attack.", unit: text.seconds, invalidError: text.bounds },
      attackCooldownSeconds: { label: text.attackCooldownSeconds, hint: de ? "Jede Person kann in dieser Zeit einmal angreifen." : "Each viewer can attack once during this interval.", unit: text.seconds, invalidError: text.bounds },
      damageMinimum: { label: text.damageMinimum, hint: de ? "Untergrenze des zufälligen Schadens je Angriff." : "Lower end of random damage per attack.", unit: text.points, invalidError: text.bounds },
      damageMaximum: { label: text.damageMaximum, hint: text.minimumExceedsMaximum, unit: text.points, invalidError: text.minimumExceedsMaximum },
      lootPool: { label: text.lootPool, hint: de ? "Wird nur bei einem Sieg aus dem Hauskonto ausgezahlt." : "Paid from the house account only if the boss is defeated.", unit: text.points, invalidError: text.bounds },
      chatTarget: { label: text.chatOutput, hint: de ? "Legt fest, in welchen Chat die Rundennachrichten gehen." : "Chooses which chat receives round messages.", options: {
        all_chats: { label: de ? "Alle Chats" : "All chats" },
        source_only: { label: de ? "Quellkanal" : "Source channel" },
        where_asked: { label: de ? "Wo gefragt wurde" : "Where asked" },
      } },
      startText: { label: text.startMessageField, hint: text.messageHint, previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", previewEmptyText: de ? "Keine Vorschau." : "No preview.", requiredError: de ? "Text fehlt." : "Text is required." },
      defeatedText: { label: text.defeatedMessageField, hint: text.messageHint, previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", previewEmptyText: de ? "Keine Vorschau." : "No preview.", requiredError: de ? "Text fehlt." : "Text is required." },
      timeoutText: { label: text.timeoutMessageField, hint: text.messageHint, previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", previewEmptyText: de ? "Keine Vorschau." : "No preview.", requiredError: de ? "Text fehlt." : "Text is required." },
    },
    warningLabel: (warning: PanelTemplateWarning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variablen" : "Unknown variables"}: ${warning.unknownVariables.join(", ")}`
      : warning.code === "template_worst_case_too_long"
        ? `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`
        : `${de ? "Ungültige Variablen" : "Invalid variables"}: ${warning.invalidVariables.join(", ")}`,
  };
};

export const bossFightSettingsEditorCatalog = { de: catalog("de"), en: catalog("en") } as const;
