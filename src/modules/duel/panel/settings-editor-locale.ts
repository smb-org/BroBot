import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { DashboardLanguage } from "../../../dashboard/locale";
import type { PanelTemplateWarning } from "../../contract";
import { duelCatalog, duelPanelCopy } from "../locale";

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
  const copy = duelPanelCopy[language];
  const text = duelCatalog[language];
  return {
    title: text.title,
    ariaLabel: text.title,
    readOnlyReason: de ? "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern." : "Only broadcasters and managers may change these settings.",
    saveLabel: de ? "Speichern" : "Save",
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: copy.saved,
    pendingLabel: de ? "Wird gespeichert …" : "Saving …",
    invalidMessage: copy.invalid,
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    saveError: copy.saveError,
    conflictMessage: de ? "Einstellungen wurden inzwischen geändert." : "Settings have changed since they were loaded.",
    reloadLabel: de ? "Serverstand laden" : "Load server version",
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    templateMessages: templateMessages[language],
    sections: {
      commands: de ? "Befehle" : "Commands",
      stakes: de ? "Einsätze" : "Stakes",
      rules: de ? "Rundenregeln" : "Round rules",
      chat: de ? "Chat" : "Chat",
      texts: de ? "Chat-Texte" : "Chat texts",
    },
    fields: {
      challengeCommand: { label: text.challengeCommand, hint: de ? "Befehl zum Erstellen eines Duells." : "Command used to create a duel.", invalidError: de ? "Befehl muss mit ! beginnen und 2–24 Kleinbuchstaben, Zahlen oder _ enthalten." : "Use ! followed by 2–24 lowercase letters, numbers, or underscores." },
      acceptCommand: { label: text.acceptCommand, hint: de ? "Befehl zum Annehmen eines Duells." : "Command used to accept a duel.", invalidError: copy.commandsDiffer },
      defaultStake: { label: text.defaultStake, hint: de ? "Wird verwendet, wenn kein Einsatz angegeben ist." : "Used when no stake is supplied.", unit: de ? "Punkte" : "points", invalidError: copy.bounds },
      minStake: { label: text.minStake, hint: de ? "Kleinster erlaubter Einsatz." : "Smallest allowed stake.", unit: de ? "Punkte" : "points", invalidError: copy.bounds },
      maxStake: { label: text.maxStake, hint: de ? "Größter erlaubter Einsatz." : "Largest allowed stake.", unit: de ? "Punkte" : "points", invalidError: copy.bounds },
      acceptWindowSeconds: { label: text.acceptWindowSeconds, hint: de ? "Die Frist beginnt nach der gesendeten Ansage." : "The clock starts when the announcement is delivered.", unit: "s" },
      cooldownSeconds: { label: text.cooldownSeconds, hint: de ? "Gilt nur nach einer erfolgreichen Herausforderung." : "Applies after a successful challenge only.", unit: "s" },
      botAcceptsOpenDuels: { label: text.botAcceptsOpenDuels, hint: de ? "Der Bot spielt bei offenen Duellen nach Ablauf mit." : "The bot accepts open duels after the window expires." },
      broadcasterModsMayPlay: { label: text.broadcasterModsMayPlay, hint: de ? "Erlaubt Broadcastern und Mods mitzuspielen." : "Allows broadcasters and moderators to play." },
      chatTarget: { label: text.chatTarget, hint: de ? "Legt fest, in welchen Chat der Bot schreibt.": "Chooses which chat receives bot messages.", options: {
        all_chats: { label: de ? "Alle Chats" : "All chats" },
        source_only: { label: de ? "Quellkanal" : "Source channel" },
        where_asked: { label: de ? "Wo gefragt wurde" : "Where asked" },
      } },
      texts: { label: text.texts, hint: de ? "Vorlagen und Fehlermeldungen für Duelle." : "Templates and errors used by duels." },
    },
    warningLabel: (warning: PanelTemplateWarning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variablen" : "Unknown variables"}: ${warning.unknownVariables.join(", ")}`
      : warning.code === "template_worst_case_too_long"
        ? `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`
        : `${de ? "Ungültige Variablen" : "Invalid variables"}: ${warning.invalidVariables.join(", ")}`,
  };
};

export const duelSettingsEditorCatalog = { de: catalog("de"), en: catalog("en") } as const;
