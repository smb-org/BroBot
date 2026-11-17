import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { DashboardLanguage } from "../../../dashboard/locale";
import type { PanelTemplateWarning } from "../../contract";
import { songRequestsSettingsTexts } from "./settings-locale";

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
  const text = songRequestsSettingsTexts[language];
  const field = (label: string, hint: string) => ({ label, hint });
  const typePreviewVariable = {
    name: "song.type",
    label: de ? "Wunschtyp" : "Request type",
    description: de ? "Lokalisierte Bezeichnung der Wunschquelle." : "Localized label for the request source.",
    sample: de ? "Kostenloser Wunsch" : "Free request",
  };
  return {
    title: de ? "Song-Wünsche" : "Song requests",
    ariaLabel: de ? "Song-Wunsch-Einstellungen" : "Song request settings",
    readOnlyReason: de ? "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern." : "Only broadcasters and managers may change these settings.",
    saveLabel: text.save,
    discardLabel: text.discard,
    savedLabel: text.saved,
    pendingLabel: text.saving,
    invalidMessage: de ? "Bitte die markierten Felder prüfen." : "Please check the highlighted fields.",
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    saveError: text.saveError,
    conflictMessage: text.conflict,
    reloadLabel: de ? "Serverstand laden" : "Load server version",
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    messageEnabledLabel: de ? "Nachricht senden" : "Send message",
    templateMessages: templateMessages[language],
    sections: {
      admission: text.admission,
      rules: text.rules,
      skipVote: text.skipVote,
      alert: text.requestAlert,
      overlay: text.overlay,
      messages: de ? "Nachrichten" : "Messages",
    },
    fields: {
      mode: { label: text.mode, hint: de ? "Song-Wünsche werden sofort eingereiht oder erst moderiert." : "Requests are queued right away or reviewed first.", options: {
        automatic: { label: text.automatic }, moderated: { label: text.moderated },
      } },
      paymentMode: { label: text.payment, hint: de ? "Legt fest, wie ein Song-Wunsch bezahlt wird." : "Chooses how song requests are paid for.", options: {
        bot_points: { label: text.botPoints }, free: { label: text.free },
      } },
      botPointsCost: field(text.cost, de ? "Preis eines einzelnen Song-Wunsches." : "Cost of a single song request."),
      freeRoleThreshold: { label: text.freeRole, hint: de ? "Mindestens diese Twitch-Rolle ist für kostenlose Wünsche nötig." : "At least this Twitch role is required for free requests.", options: Object.fromEntries(text.roles.map(({ value, label, inclusion }) => [value, { label, description: inclusion }])) },
      alsoOffline: field(text.alsoOffline, text.alsoOfflineDescription),
      rules: field(text.rules, de ? "Regeln für automatisch angenommene Song-Wünsche." : "Rules for automatically accepted song requests."),
      skipVote: field(text.skipVote, de ? "Abstimmung zum Überspringen des laufenden Songs." : "Vote to skip the currently playing track."),
      requestAlert: field(text.requestAlert, de ? "Overlay-Alarm für Song-Wünsche." : "Overlay alert for song requests."),
      queueOverlayRows: field(text.overlayRows, de ? "Anzahl der reservierten Zeilen im Queue-Overlay." : "Number of reserved rows in the queue overlay."),
      emptyText: field(text.emptyText, de ? "Wird angezeigt, wenn gerade kein Song läuft." : "Shown when no track is playing."),
      queuedText: { label: de ? "Eingereiht" : "Queued result", hint: de ? "Eine Nachricht nach der Antwort von Spotify." : "One message after Spotify returns the result.", previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", variables: [typePreviewVariable] },
      waitingText: { label: de ? "Wartet auf Freigabe" : "Waiting for approval", hint: de ? "Sofortige Antwort bei moderierten Song-Wünschen." : "Immediate reply for moderated requests.", previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", variables: [typePreviewVariable] },
      requestAlertText: { label: de ? "Song-Wunsch-Alarm" : "Song request alert", hint: de ? "Text für den Overlay-Alarm." : "Text shown in the overlay alert.", previewLabel: de ? "Vorschau" : "Preview", previewSpeaker: "BroBot", variables: [typePreviewVariable] },
      skipVoteEnabled: field(text.skipVoteEnabled, de ? "Aktiviert die Abstimmung über den aktuellen Song." : "Turns on votes for the current track."),
      skipThreshold: field(text.skipThreshold, de ? "Benötigte Ja-Stimmen." : "Required yes votes."),
      skipCooldown: field(text.skipCooldown, de ? "Pause nach Ende einer Abstimmung." : "Wait time after a vote closes."),
      requestAlertEnabled: field(text.requestAlertEnabled, de ? "Song-Wunsch-Alarm im Overlay anzeigen." : "Show song request alerts in the overlay."),
    },
    warningLabel: (warning: PanelTemplateWarning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variablen" : "Unknown variables"}: ${warning.unknownVariables.join(", ")}`
      : warning.code === "template_worst_case_too_long"
        ? `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`
        : `${de ? "Ungültige Variablen" : "Invalid variables"}: ${warning.invalidVariables.join(", ")}`,
  };
};

export const songRequestSettingsEditorCatalog = {
  locales: { de: catalog("de"), en: catalog("en") },
} as const;
