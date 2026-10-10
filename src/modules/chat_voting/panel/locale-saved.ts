import type { ModuleLanguage } from "../../contract";

const catalog = {
  de: {
    title: "Abstimmung", running: "Läuft", ended: "Beendet", idle: "Keine Abstimmung läuft",
    votes: (count: number, ending: string) => `${String(count)} Stimmen · endet ${ending}`,
    endedVotes: (count: number) => `${String(count)} Stimmen`, end: "Beenden", noVoteYet: "Keine Abstimmung bisher",
    voteCountAria: (answer: string, count: number, percent: number) => `${answer}: ${String(count)} Stimmen, ${String(percent)} Prozent`,
    approve: "Freigeben", approved: "Freigegeben", approveTerm: (term: string) => `Freigeben: ${term}`, voteWord: "Stimmen",
    liveLoadError: "Die Abstimmung konnte nicht geladen werden.", retry: "Erneut versuchen",
    saved: "Gespeichert", recent: "Zuletzt", create: "Abstimmung anlegen", emptySaved: "Noch keine gespeicherten Abstimmungen",
    emptySavedDescription: "Lege eine Abstimmung an, um sie hier zu speichern.", emptyRecent: "Noch keine Abstimmung gelaufen",
    loading: "Lädt …", templatesError: "Gespeicherte Abstimmungen konnten nicht geladen werden.",
    recentError: "Zuletzt gelaufene Abstimmungen konnten nicht geladen werden.", templateCount: (count: number) => `${String(count)}/100`,
    runningLocked: "Eine Abstimmung läuft", votekickLocked: "Votekick läuft",
    noTemplatesLocked: "Keine gespeicherten Abstimmungen – im Abstimmungs-Panel anlegen",
    operatorLocked: "Keine Berechtigung zum Bearbeiten oder Starten.", untitled: "Ohne Titel", incomplete: "Unvollständig", startAction: "Abstimmung starten",
    start: (title: string) => `„${title}“ starten`, shortcutMeta: (shortcut: string) => `!vote ${shortcut}`,
    templateMeta: (count: number, duration: string) => `${String(count)} Antworten · ${duration}`,
    problem: (problem: "answers" | "duration") => problem === "answers" ? "Es braucht zwei bis neun eindeutige Antworten." : "Die Dauer muss zwischen einer Sekunde und vier Stunden liegen.",
    templateLimit: "Es können höchstens 100 Abstimmungen gespeichert werden.",
    startError: "Die Abstimmung konnte nicht gestartet werden.", endError: "Die Abstimmung konnte nicht beendet werden.",
    approvalSaved: "Antwort freigegeben.", approvalFailed: "Die Antwort konnte nicht freigegeben werden.", termsUnavailable: "Gesperrte Begriffe sind gerade nicht verfügbar.",
    question: "Frage", answers: "Antworten", answer: (number: number) => `Antwort ${String(number)}`,
    editTitle: (title: string) => `Bearbeiten: ${title}`, increase: "Dauer erhöhen", decrease: "Dauer verringern",
    answerPlaceholder: "Antwort", answerRequired: "Antwort darf nicht leer sein.", answerDuplicate: "Antwort muss eindeutig sein.",
    removeAnswer: (number: number) => `Antwort ${String(number)} entfernen`, addAnswer: "Antwort",
    maxAnswers: "Es sind höchstens neun Antworten möglich.", ghostYes: "Ja", ghostNo: "Nein", quickTemplates: "Schnellvorlagen",
    yesNo: "Ja/Nein", scale: "1–5",
    freeText: "Chat antwortet frei", freeTextHint: "Antworten werden als Freitext gesammelt.",
    firstWord: "Erstes Wort", wholeMessage: "Ganze Nachricht", textMode: "Antwortmodus", duration: "Dauer",
    oneMinute: "1 Min", twoMinutes: "2 Min", fiveMinutes: "5 Min", open: "Offen", custom: "Eigene", seconds: "Sekunden",
    durationMinutes: (count: number) => `${String(count)} Min`, durationSeconds: (count: number) => `${String(count)} s`, nextDay: "(+1)",
    durationHint: "0 oder eine Dauer von 1 bis 14.400 Sekunden.", shortcut: "Kürzel", shortcutHint: "Leer = nur im Panel startbar",
    shortcutPrefix: "!vote", shortcutInvalid: "Kürzel: a–z, danach a–z, 0–9, _ oder - (maximal 24 Zeichen).",
    shortcutReserved: "Dieses Kürzel ist für einen Chat-Befehl reserviert.", shortcutDuplicate: "Dieses Kürzel wird bereits verwendet.",
    shortcutUnavailable: "Kürzel konnte nicht gespeichert werden.",
    chatHint: "„1“ oder „Pizza“ zählt · umentscheiden per Nummer", chatHintYesNo: "Nummer 1 oder 2", infoNextStart: "Änderungen gelten ab dem nächsten Start.",
    save: "Speichern", discard: "Verwerfen", unsaved: "Änderungen ausstehend", saving: "Speichert …", saveError: "Nicht gespeichert – erneut versuchen",
    emptyDraftError: "Fülle die Abstimmung aus, bevor du sie speicherst.", saveConflict: "Woanders geändert – neu laden",
    conflictReload: "Neu laden", conflictReloadMissing: "Diese Abstimmung wurde gelöscht.", conflictReloadError: "Die aktuelle Fassung konnte nicht geladen werden.",
    discardChangesTitle: "Änderungen verwerfen?", discardChangesDescription: "Nicht gespeicherte Änderungen an dieser Abstimmung gehen verloren.",
    continueEditing: "Weiter bearbeiten", discardAndSwitch: "Änderungen verwerfen",
    delete: "Abstimmung löschen", deleteTitle: (title: string) => `„${title}“ löschen?`,
    deleteDescription: (title: string, running: boolean, legacy: boolean) => `${title} wird aus den gespeicherten Abstimmungen entfernt.${running ? " Die laufende Abstimmung nutzt weiterhin ihre Momentaufnahme." : ""}${legacy ? " Das Chat-Alias startet danach die Sprach-Standardeinstellung." : ""}`,
    confirmDelete: "Abstimmung löschen", cancel: "Abbrechen", deleteError: "Die Abstimmung konnte nicht gelöscht werden.",
    recentMeta: (time: string, count: number, winner: string) => `${time} · ${String(count)} Stimmen · ${winner}`,
    winner: (label: string, percent: number) => `${label} (${String(percent)} %)`, noWinner: "Kein Gewinner", repeat: "Nochmal",
    closeReason: (reason: string) => `Beendet: ${reason}`, startAnnouncement: (title: string) => `Abstimmung gestartet: ${title}`,
    endAnnouncement: (title: string) => `Abstimmung beendet: ${title}`,
  },
  en: {
    title: "Voting", running: "Running", ended: "Ended", idle: "No vote is running",
    votes: (count: number, ending: string) => `${String(count)} votes · ends ${ending}`,
    endedVotes: (count: number) => `${String(count)} votes`, end: "End vote", noVoteYet: "No vote yet",
    voteCountAria: (answer: string, count: number, percent: number) => `${answer}: ${String(count)} votes, ${String(percent)} percent`,
    approve: "Approve", approved: "Approved", approveTerm: (term: string) => `Approve: ${term}`, voteWord: "votes",
    liveLoadError: "The vote could not be loaded.", retry: "Retry", saved: "Saved", recent: "Recent", create: "Create vote",
    emptySaved: "No saved votes yet", emptySavedDescription: "Create a vote to save it here.", emptyRecent: "No vote has run yet",
    loading: "Loading …", templatesError: "Saved votes could not be loaded.", recentError: "Recent votes could not be loaded.",
    templateCount: (count: number) => `${String(count)}/100`, runningLocked: "A vote is running", votekickLocked: "A votekick is running",
    noTemplatesLocked: "No saved votes – create one in the voting panel", operatorLocked: "You cannot edit or start votes.",
    untitled: "Untitled", incomplete: "Incomplete", start: (title: string) => `Start “${title}”`, startAction: "Start vote",
    shortcutMeta: (shortcut: string) => `!vote ${shortcut}`, templateMeta: (count: number, duration: string) => `${String(count)} answers · ${duration}`,
    problem: (problem: "answers" | "duration") => problem === "answers" ? "Add two to nine unique answers." : "Duration must be from one second to four hours.",
    templateLimit: "You can save up to 100 votes.",
    startError: "The vote could not be started.", endError: "The vote could not be ended.", approvalSaved: "Answer approved.",
    approvalFailed: "The answer could not be approved.", termsUnavailable: "Blocked terms are unavailable right now.",
    question: "Question", answers: "Answers", answer: (number: number) => `Answer ${String(number)}`,
    editTitle: (title: string) => `Edit: ${title}`, increase: "Increase duration", decrease: "Decrease duration",
    answerPlaceholder: "Answer", answerRequired: "Answer cannot be empty.", answerDuplicate: "Answers must be unique.",
    removeAnswer: (number: number) => `Remove answer ${String(number)}`, addAnswer: "Answer",
    maxAnswers: "You can add up to nine answers.", ghostYes: "Yes", ghostNo: "No", quickTemplates: "Quick templates",
    yesNo: "Yes/No", scale: "1–5", freeText: "Chat replies freely",
    freeTextHint: "Collect answers as free text.", firstWord: "First word", wholeMessage: "Whole message", textMode: "Reply mode",
    duration: "Duration", oneMinute: "1 min", twoMinutes: "2 min", fiveMinutes: "5 min", open: "Open", custom: "Custom", seconds: "Seconds",
    durationMinutes: (count: number) => `${String(count)} min`, durationSeconds: (count: number) => `${String(count)} sec`, nextDay: "(+1)",
    durationHint: "Use 0 or a duration from 1 to 14,400 seconds.", shortcut: "Shortcut", shortcutHint: "Empty = panel only", shortcutPrefix: "!vote",
    shortcutInvalid: "Use a–z first, then a–z, 0–9, _ or - (up to 24 characters).",
    shortcutReserved: "This shortcut is reserved for a chat command.", shortcutDuplicate: "This shortcut is already in use.",
    shortcutUnavailable: "The shortcut could not be saved.", chatHint: "“1” or “Pizza” counts · change your vote by number", chatHintYesNo: "Number 1 or 2",
    infoNextStart: "Changes apply from the next start.", save: "Save", discard: "Discard", unsaved: "Unsaved changes", saving: "Saving …",
    emptyDraftError: "Add vote details before saving it.", saveError: "Not saved – retry", saveConflict: "Changed elsewhere – reload",
    conflictReload: "Reload", conflictReloadMissing: "This vote was deleted.", conflictReloadError: "The current version could not be loaded.",
    discardChangesTitle: "Discard changes?", discardChangesDescription: "Unsaved changes to this vote will be lost.",
    continueEditing: "Continue editing", discardAndSwitch: "Discard changes",
    delete: "Delete vote", deleteTitle: (title: string) => `Delete “${title}”?`,
    deleteDescription: (title: string, running: boolean, legacy: boolean) => `${title} will be removed from saved votes.${running ? " The running vote keeps its snapshot." : ""}${legacy ? " Its chat alias will use the language default afterward." : ""}`,
    confirmDelete: "Delete vote", cancel: "Cancel", deleteError: "The vote could not be deleted.",
    recentMeta: (time: string, count: number, winner: string) => `${time} · ${String(count)} votes · ${winner}`,
    winner: (label: string, percent: number) => `${label} (${String(percent)}%)`, noWinner: "No winner", repeat: "Again",
    closeReason: (reason: string) => `Ended: ${reason}`, startAnnouncement: (title: string) => `Vote started: ${title}`,
    endAnnouncement: (title: string) => `Vote ended: ${title}`,
  },
} as const;

export const chatVotingSavedPanelTexts = (language: ModuleLanguage) => catalog[language];

export const chatVoteDurationText = (seconds: number, language: ModuleLanguage): string => {
  const labels = chatVotingSavedPanelTexts(language);
  if (seconds === 0) return labels.open;
  if (seconds === 60) return labels.oneMinute;
  if (seconds === 120) return labels.twoMinutes;
  if (seconds === 300) return labels.fiveMinutes;

  const minutes = Math.trunc(seconds / 60);
  const remainder = Math.abs(seconds % 60);
  const parts = [
    ...(minutes === 0 ? [] : [labels.durationMinutes(minutes)]),
    ...(remainder === 0 ? [] : [labels.durationSeconds(remainder)]),
  ];
  return parts.length === 0 ? labels.durationSeconds(seconds) : parts.join(" ");
};
