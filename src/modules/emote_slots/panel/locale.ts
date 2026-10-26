import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { DashboardLanguage } from "../../../dashboard/locale";
import type { PanelTemplateWarning } from "../../contract";
import { emoteSlotsCatalog } from "../locale";

export const emoteSlotTemplateMessages: Readonly<Record<DashboardLanguage, TemplateTextFieldMessages>> = {
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

const variables = (language: DashboardLanguage) => {
  const copy = emoteSlotsCatalog[language].panel.variables;
  const samples = language === "de" ? {
    user: "nachtfalke", "slot.symbols": "🍒 | 🍒 | 💎", "slot.net": "+50", "slot.balance": "200",
    "slot.jackpot": "1.003", "slot.payout": "50", "slot.stake": "50",
  } : {
    user: "sampleviewer", "slot.symbols": "🍒 | 🍒 | 💎", "slot.net": "+50", "slot.balance": "200",
    "slot.jackpot": "1,003", "slot.payout": "50", "slot.stake": "50",
  };
  return ["user", "slot.symbols", "slot.net", "slot.balance", "slot.jackpot", "slot.payout", "slot.stake"].map((name) => {
    const key = name === "user" ? "user" : name.slice("slot.".length);
    return { name, label: copy[key as keyof typeof copy], description: copy[key as keyof typeof copy], sample: samples[name as keyof typeof samples] };
  });
};

const catalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  const copy = emoteSlotsCatalog[language].panel;
  const allChatOptions = {
    all_chats: { label: copy.allChats },
    source_only: { label: copy.sourceOnly },
    where_asked: { label: copy.whereAsked },
  };
  const templateVariables = variables(language);
  const save = de ? "Speichern" : "Save";
  const invalid = de ? "Bitte korrigiere die markierten Felder." : "Please correct the marked fields.";
  const error = de ? "Einstellungen konnten nicht gespeichert werden." : "Settings could not be saved.";
  return {
    title: copy.ariaLabel,
    ariaLabel: copy.ariaLabel,
    readOnlyReason: de ? "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern." : "Only broadcasters and managers may change these settings.",
    saveLabel: save,
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: de ? "Einstellungen gespeichert." : "Settings saved.",
    pendingLabel: de ? "Wird gespeichert …" : "Saving …",
    invalidMessage: invalid,
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Warning" },
    saveError: error,
    conflictMessage: de ? "Einstellungen wurden inzwischen geändert." : "Settings have changed since they were loaded.",
    reloadLabel: de ? "Serverstand laden" : "Load server version",
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    templateMessages: emoteSlotTemplateMessages[language],
    sections: {
      reels: copy.sections.reels,
      stakes: copy.sections.stakes,
      jackpot: copy.sections.jackpot,
      cooldown: copy.sections.cooldown,
      chat: copy.sections.chat,
      texts: copy.sections.texts,
    },
    warningLabel: (warning: PanelTemplateWarning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variable(n)" : "Unknown variable(s)"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_worst_case_too_long"
        ? `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`
        : `${de ? "Ungültige Variablenparameter" : "Invalid template parameters"}: ${warning.invalidVariables.map((name) => `{${name}}`).join(", ")}`,
    fields: {
      symbols: { label: copy.symbol, hint: copy.duplicateSymbol, invalidError: copy.duplicateSymbol },
      minStake: { label: copy.minStake, hint: de ? "Kleinster erlaubter Einsatz pro Dreh." : "Smallest allowed stake per spin.", unit: copy.points, invalidError: copy.minStakeError },
      defaultStake: { label: copy.defaultStake, hint: de ? "Wird verwendet, wenn !slot ohne Zahl geschrieben wird." : "Used when !slot is sent without a number.", unit: copy.points, invalidError: copy.defaultStakeError },
      maxStake: { label: copy.maxStake, hint: de ? "Obergrenze für einen Einsatz." : "Upper limit for one stake.", unit: copy.points, invalidError: copy.maxStakeError },
      jackpotSeed: { label: copy.seed, hint: de ? "Startet einen leeren Jackpot und füllt ihn nach einem Treffer." : "Funds an empty jackpot and reseeds after a hit.", unit: copy.points, invalidError: copy.seedError },
      jackpotShareBp: { label: copy.share, hint: de ? "Wird bei jedem Einsatz auf volle Punkte abgerundet." : "Rounded down to whole points on every stake.", invalidError: copy.shareError },
      pairPayoutBp: { label: copy.pairPayout, hint: copy.pairPayoutHint, invalidError: copy.pairPayoutError },
      announceJackpot: { label: copy.announce, hint: copy.announceHint, description: copy.announceHint },
      cooldownSeconds: { label: copy.cooldown, hint: de ? "Pause zwischen gebuchten Drehungen derselben Person." : "Wait between booked spins from the same person.", unit: copy.seconds, zeroValueLabel: de ? "aus" : "off", invalidError: copy.cooldownError },
      chatTarget: { label: copy.targetLabel, hint: de ? "Dort erscheint die Antwort auf den Dreh." : "Where the spin reply is sent.", options: allChatOptions },
      texts: { label: copy.sections.texts, hint: de ? "Vorlagen werden vor dem Senden mit dem Ergebnis gefüllt." : "Templates are filled with the result before sending.", requiredError: copy.messageMissing, variables: templateVariables },
    },
  };
};

export const emoteSlotSettingsEditorCatalog: Readonly<Record<DashboardLanguage, SettingsEditorCatalog>> = {
  de: catalog("de"),
  en: catalog("en"),
};
