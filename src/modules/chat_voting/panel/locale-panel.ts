import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";

export interface ChatVotingPanelTexts {
  title: string;
  results: string;
  runningStatus: string;
  closedStatus: string;
  readyStatus: string;
  openStatus: string;
  noVote: string;
  loading: string;
  loadError: string;
  voteType: string;
  duration: string;
  openDuration: string;
  oneMinute: string;
  twoMinutes: string;
  fiveMinutes: string;
  customDuration: string;
  customDurationSeconds: string;
  increaseDuration: string;
  decreaseDuration: string;
  yesNo: string;
  scale: string;
  optionCount: string;
  options: string;
  increaseOptionCount: string;
  decreaseOptionCount: string;
  start: string;
  stop: string;
  starts: (timestamp: string) => string;
  ends: (timestamp: string) => string;
  startError: string;
  busy: string;
  closeError: string;
  startDisabledReason: string;
  roleDisabledReason: string;
  invalidDuration: string;
  invalidOptionCount: string;
  voterCount: (count: number) => string;
  resultBar: (label: string, count: number, percent: number) => string;
  count: string;
  percent: string;
}

const catalog: LocaleCatalog<ChatVotingPanelTexts> = {
  de: {
    title: "Abstimmung",
    results: "Abstimmungsergebnis",
    runningStatus: "Läuft",
    closedStatus: "Beendet",
    readyStatus: "Bereit",
    openStatus: "offen",
    noVote: "Es läuft gerade keine Abstimmung.",
    loading: "Abstimmung wird geladen …",
    loadError: "Die Abstimmung konnte nicht geladen werden.",
    voteType: "Abstimmungstyp",
    duration: "Dauer",
    openDuration: "Offen",
    oneMinute: "1 Min.",
    twoMinutes: "2 Min.",
    fiveMinutes: "5 Min.",
    customDuration: "Eigene",
    customDurationSeconds: "Eigene Dauer",
    increaseDuration: "Dauer erhöhen",
    decreaseDuration: "Dauer verringern",
    yesNo: "Ja/Nein",
    scale: "Skala 1–5",
    optionCount: "Anzahl der Optionen",
    options: "Optionen 2–9",
    increaseOptionCount: "Optionszahl erhöhen",
    decreaseOptionCount: "Optionszahl verringern",
    start: "Starten",
    stop: "Stoppen",
    starts: (timestamp) => `Gestartet ${timestamp}`,
    ends: (timestamp) => `endet ${timestamp}`,
    startError: "Die Abstimmung konnte nicht gestartet werden.",
    busy: "In diesem Kanal läuft bereits eine Abstimmung.",
    closeError: "Die Abstimmung konnte nicht geschlossen werden.",
    startDisabledReason: "Die Konfiguration ist gesperrt, solange eine Abstimmung oder ein Votekick läuft.",
    roleDisabledReason: "Deine Kanalrolle darf Abstimmungen nur ansehen.",
    invalidDuration: "Gib eine Dauer von 1 bis 14.400 Sekunden ein.",
    invalidOptionCount: "Gib eine Zahl von 2 bis 9 ein.",
    voterCount: (count) => `${String(count)} Stimmen`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} Stimmen, ${String(percent)} Prozent`,
    count: "Stimmen",
    percent: "Anteil",
  },
  en: {
    title: "Voting",
    results: "Vote results",
    runningStatus: "Running",
    closedStatus: "Closed",
    readyStatus: "Ready",
    openStatus: "open",
    noVote: "There is no vote in progress.",
    loading: "Loading the vote …",
    loadError: "The vote could not be loaded.",
    voteType: "Vote type",
    duration: "Duration",
    openDuration: "Open",
    oneMinute: "1 min",
    twoMinutes: "2 min",
    fiveMinutes: "5 min",
    customDuration: "Custom",
    customDurationSeconds: "Custom duration",
    increaseDuration: "Increase duration",
    decreaseDuration: "Decrease duration",
    yesNo: "Yes / No",
    scale: "Scale 1–5",
    optionCount: "Number of options",
    options: "Options 2–9",
    increaseOptionCount: "Increase option count",
    decreaseOptionCount: "Decrease option count",
    start: "Start",
    stop: "Stop",
    starts: (timestamp) => `Started ${timestamp}`,
    ends: (timestamp) => `ends ${timestamp}`,
    startError: "The vote could not be started.",
    busy: "A vote is already in progress in this channel.",
    closeError: "The vote could not be closed.",
    startDisabledReason: "Configuration is locked while a vote or votekick is running.",
    roleDisabledReason: "Your channel role can only view votes.",
    invalidDuration: "Enter a duration from 1 to 14,400 seconds.",
    invalidOptionCount: "Enter a number from 2 to 9.",
    voterCount: (count) => `${String(count)} votes`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} votes, ${String(percent)} percent`,
    count: "Votes",
    percent: "Share",
  },
};

export const chatVotingPanelTexts = (language: DashboardLanguage): ChatVotingPanelTexts => catalog[language];
