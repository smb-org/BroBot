import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { ChatVotePreset } from "../contracts";

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
  voteType: string;
  presetGroups: { twoOptions: string; scale: string; multipleOptions: string; freeText: string };
  presetDescriptions: Record<ChatVotePreset, string>;
  presetHints: Record<ChatVotePreset, string>;
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
  yesNo: string;
  zeroOne: string;
  oneTwo: string;
  scale: string;
  freeText: string;
  textMode: string;
  firstWord: string;
  wholeMessage: string;
  freeTextHint: string;
  optionCount: string;
  options: string;
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
    noVote: "Noch keine Abstimmung in diesem Kanal.",
    loading: "Abstimmung wird geladen …",
    loadError: "Die Abstimmung konnte nicht geladen werden.",
    voteType: "Abstimmungstyp",
    presetGroups: { twoOptions: "Zwei Optionen", scale: "Skala", multipleOptions: "Mehrere Optionen", freeText: "Freitext" },
    presetDescriptions: {
      yes_no: "Chat tippt 1 = Ja, 2 = Nein",
      digit_01: "Chat tippt 0 = Nein, 1 = Ja",
      digit_12: "Chat tippt 1 oder 2",
      scale_5: "Chat tippt eine Zahl von 1 bis 5",
      options_n: "Chat tippt die Nummer der Option",
      free_text: "Chat schreibt ein Wort · die Top 5 zählen",
    },
    presetHints: {
      yes_no: "Chat tippt 1 = Ja, 2 = Nein. Pro Person zählt die letzte Stimme.",
      digit_01: "Chat tippt 0 = Nein, 1 = Ja. Pro Person zählt die letzte Stimme.",
      digit_12: "Chat tippt 1 oder 2. Pro Person zählt die letzte Stimme.",
      scale_5: "Chat tippt eine Zahl von 1 bis 5.",
      options_n: "Chat tippt die Nummer der Option.",
      free_text: "Chat schreibt ein Wort; die Top 5 Begriffe zählen.",
    },
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
    yesNo: "Ja / Nein",
    zeroOne: "0 / 1",
    oneTwo: "1 / 2",
    scale: "Skala 1–5",
    freeText: "Freitext",
    textMode: "Zählweise",
    firstWord: "Erstes Wort",
    wholeMessage: "Ganze Nachricht",
    freeTextHint: "Ganze Nachricht: bis 25 Zeichen. Neue Begriffe erscheinen erst nach Freigabe.",
    optionCount: "Anzahl",
    options: "Optionen 2–9",
    optionCountHint: "Zwei bis neun Optionen",
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
    invalidOptionCount: "Gib eine Zahl von 2 bis 9 ein.",
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
    noVote: "No vote in this channel yet.",
    loading: "Loading the vote …",
    loadError: "The vote could not be loaded.",
    voteType: "Vote type",
    presetGroups: { twoOptions: "Two options", scale: "Scale", multipleOptions: "Multiple options", freeText: "Free text" },
    presetDescriptions: {
      yes_no: "Chat types 1 = yes, 2 = no",
      digit_01: "Chat types 0 = no, 1 = yes",
      digit_12: "Chat types 1 or 2",
      scale_5: "Chat types a number from 1 to 5",
      options_n: "Chat types the option number",
      free_text: "Chat types a word · top 5 are counted",
    },
    presetHints: {
      yes_no: "Chat types 1 = yes, 2 = no. Each person’s latest vote counts.",
      digit_01: "Chat types 0 = no, 1 = yes. Each person’s latest vote counts.",
      digit_12: "Chat types 1 or 2. Each person’s latest vote counts.",
      scale_5: "Chat types a number from 1 to 5.",
      options_n: "Chat types the option number.",
      free_text: "Chat types a word; the top 5 terms count.",
    },
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
    yesNo: "Yes / No",
    zeroOne: "0 / 1",
    oneTwo: "1 / 2",
    scale: "Scale 1–5",
    freeText: "Free text",
    textMode: "Counting mode",
    firstWord: "First word",
    wholeMessage: "Whole message",
    freeTextHint: "Whole messages count up to 25 characters; new terms appear after approval.",
    optionCount: "Number of options",
    options: "Options 2–9",
    optionCountHint: "Two to nine options",
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
    invalidOptionCount: "Enter a number from 2 to 9.",
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
