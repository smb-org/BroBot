import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
export interface ChatVotingPanelTexts {
  title: string;
  newVote: string;
  result: string;
  results: string;
  runningStatus: string;
  closedStatus: string;
  readyStatus: string;
  openStatus: string;
  noVote: string;
  loading: string;
  loadError: string;
  question: string;
  questionCount: (count: number, maximum: number) => string;
  yesNoDefaultHint: string;
  labelsHeading: string;
  labelFieldName: (key: string) => string;
  labelCount: (count: number, maximum: number) => string;
  duration: string;
  openDuration: string;
  openDurationHint: string;
  oneMinute: string;
  twoMinutes: string;
  fiveMinutes: string;
  customDuration: string;
  customDurationSeconds: string;
  durationRange: string;
  increaseDuration: string;
  decreaseDuration: string;
  freeText: string;
  textMode: string;
  firstWord: string;
  wholeMessage: string;
  freeTextHint: string;
  optionCount: string;
  optionCountHint: string;
  increaseOptionCount: string;
  decreaseOptionCount: string;
  start: string;
  stop: string;
  ends: (timestamp: string) => string;
  startError: string;
  busy: string;
  closeError: string;
  startDisabledReason: string;
  roleDisabledReason: string;
  invalidDuration: string;
  invalidOptionCount: string;
  invalidLabels: string;
  nextDay: string;
  resultMeta: (count: number, from: string, to: string | null, moreTerms?: number) => string;
  resultBar: (label: string, count: number, percent: number) => string;
  emptySlot: string;
  approve: string;
  approveTerm: (term: string) => string;
  termHidden: string;
  approved: string;
  approvedShort: string;
  termsUnavailable: string;
  approvalFailed: string;
  approvalSaved: string;
  moreTerms: (count: number) => string;
}

const catalog: LocaleCatalog<ChatVotingPanelTexts> = {
  de: {
    title: "Abstimmung",
    newVote: "Neue Abstimmung",
    result: "Ergebnis",
    results: "Abstimmungsergebnis",
    runningStatus: "Läuft",
    closedStatus: "Beendet",
    readyStatus: "Bereit",
    openStatus: "offen",
    noVote: "Noch keine Abstimmung. Starte eine im Chat mit !vote yesno [question].",
    loading: "Abstimmung wird geladen …",
    loadError: "Die Abstimmung konnte nicht geladen werden.",
    question: "Frage",
    questionCount: (count, maximum) => `${String(count)}/${String(maximum)}`,
    yesNoDefaultHint: "Ohne Antworten stimmt der Chat mit 1 für Ja und 2 für Nein ab.",
    labelsHeading: "Beschriftungen",
    labelFieldName: (key) => `Beschriftung für Option ${key}`,
    labelCount: (count, maximum) => `${String(count)}/${String(maximum)}`,
    duration: "Dauer",
    openDuration: "Offen",
    openDurationHint: "Ohne Timer endet die Abstimmung nach vier Stunden.",
    oneMinute: "1 Min.",
    twoMinutes: "2 Min.",
    fiveMinutes: "5 Min.",
    customDuration: "Eigene …",
    customDurationSeconds: "Sekunden",
    durationRange: "1 bis 14.400 Sekunden",
    increaseDuration: "Dauer erhöhen",
    decreaseDuration: "Dauer verringern",
    freeText: "Freitext",
    textMode: "Zählweise",
    firstWord: "Erstes Wort",
    wholeMessage: "Ganze Nachricht",
    freeTextHint: "Ganze Nachricht: bis 25 Zeichen. Neue Begriffe erscheinen erst nach Freigabe.",
    optionCount: "Anzahl der Antworten",
    optionCountHint: "Keine Antwort für Ja/Nein oder zwei bis neun Antworten",
    increaseOptionCount: "Optionszahl erhöhen",
    decreaseOptionCount: "Optionszahl verringern",
    start: "Abstimmung starten",
    stop: "Abstimmung beenden",
    ends: (timestamp) => `endet ${timestamp}`,
    startError: "Die Abstimmung konnte nicht gestartet werden.",
    busy: "In diesem Kanal läuft bereits eine Abstimmung.",
    closeError: "Die Abstimmung konnte nicht geschlossen werden.",
    startDisabledReason: "Gesperrt, solange eine Abstimmung oder ein Votekick läuft.",
    roleDisabledReason: "Deine Kanalrolle darf Abstimmungen nur ansehen.",
    invalidDuration: "Gib eine Dauer von 1 bis 14.400 Sekunden ein.",
    invalidOptionCount: "Gib 0 oder eine Zahl von 2 bis 9 ein.",
    invalidLabels: "Antworten müssen eindeutig und nicht leer sein.",
    nextDay: "(+1)",
    resultMeta: (count, from, to, moreTerms) => `${String(count)} Stimmen · ${to === null ? `seit ${from}` : `${from}–${to}`}${moreTerms ? ` · ${String(moreTerms)} weitere` : ""}`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} Stimmen, ${String(percent)} Prozent`,
    emptySlot: "—",
    approve: "Freigeben",
    approveTerm: (term) => `„${term}“ freigeben`,
    termHidden: "Im Overlay verborgen bis zur Freigabe.",
    approved: "Freigegeben",
    approvedShort: "Frei",
    termsUnavailable: "Die Twitch-Sperrliste ist nicht verfügbar. Begriffe bleiben verborgen, bis sie geprüft werden können.",
    approvalFailed: "Der Begriff konnte nicht freigegeben werden.",
    approvalSaved: "Begriff für diese Abstimmung freigegeben.",
    moreTerms: (count) => count === 0 ? "Weitere Begriffe: —" : `Weitere Begriffe: ${String(count)}`,
  },
  en: {
    title: "Voting",
    newVote: "New vote",
    result: "Result",
    results: "Vote result",
    runningStatus: "Running",
    closedStatus: "Closed",
    readyStatus: "Ready",
    openStatus: "open",
    noVote: "No vote yet. Start one in chat with !vote yesno [question].",
    loading: "Loading the vote …",
    loadError: "The vote could not be loaded.",
    question: "Question",
    questionCount: (count, maximum) => `${String(count)}/${String(maximum)}`,
    yesNoDefaultHint: "With no answers, chat votes with 1 for yes and 2 for no.",
    labelsHeading: "Labels",
    labelFieldName: (key) => `Label for option ${key}`,
    labelCount: (count, maximum) => `${String(count)}/${String(maximum)}`,
    duration: "Duration",
    openDuration: "Open",
    openDurationHint: "Without a timer, the vote ends after four hours.",
    oneMinute: "1 min",
    twoMinutes: "2 min",
    fiveMinutes: "5 min",
    customDuration: "Custom …",
    customDurationSeconds: "Seconds",
    durationRange: "1 to 14,400 seconds",
    increaseDuration: "Increase duration",
    decreaseDuration: "Decrease duration",
    freeText: "Free text",
    textMode: "Counting mode",
    firstWord: "First word",
    wholeMessage: "Whole message",
    freeTextHint: "Whole messages count up to 25 characters; new terms appear after approval.",
    optionCount: "Number of answers",
    optionCountHint: "No answers for yes/no, or two to nine answers",
    increaseOptionCount: "Increase option count",
    decreaseOptionCount: "Decrease option count",
    start: "Start vote",
    stop: "End vote",
    ends: (timestamp) => `ends ${timestamp}`,
    startError: "The vote could not be started.",
    busy: "A vote is already in progress in this channel.",
    closeError: "The vote could not be closed.",
    startDisabledReason: "Locked while a vote or votekick is running.",
    roleDisabledReason: "Your channel role can only view votes.",
    invalidDuration: "Enter a duration from 1 to 14,400 seconds.",
    invalidOptionCount: "Enter 0 or a number from 2 to 9.",
    invalidLabels: "Answers must be unique and nonempty.",
    nextDay: "(+1)",
    resultMeta: (count, from, to, moreTerms) => `${String(count)} votes · ${to === null ? `since ${from}` : `${from}–${to}`}${moreTerms ? ` · ${String(moreTerms)} more` : ""}`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} votes, ${String(percent)} percent`,
    emptySlot: "—",
    approve: "Approve",
    approveTerm: (term) => `Approve “${term}”`,
    termHidden: "Hidden from the overlay until approved.",
    approved: "Approved",
    approvedShort: "Approved",
    termsUnavailable: "Twitch’s blocked-term list is unavailable. Terms stay hidden until they can be checked.",
    approvalFailed: "The term could not be approved.",
    approvalSaved: "Term approved for this vote.",
    moreTerms: (count) => count === 0 ? "More terms: —" : `More terms: ${String(count)}`,
  },
};

export const chatVotingPanelTexts = (language: DashboardLanguage): ChatVotingPanelTexts => catalog[language];
