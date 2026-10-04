import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";

export interface ChatVotingPanelTexts {
  currentVote: string;
  runningTitle: string;
  closedTitle: string;
  runningStatus: string;
  closedStatus: string;
  noVote: string;
  loading: string;
  loadError: string;
  startSection: string;
  yesNo: string;
  scale: string;
  optionCount: string;
  options: string;
  startOptions: string;
  increaseOptionCount: string;
  decreaseOptionCount: string;
  close: string;
  starts: (timestamp: string) => string;
  ends: (timestamp: string) => string;
  startError: string;
  busy: string;
  closeError: string;
  startDisabledReason: string;
  invalidOptionCount: string;
  voterCount: (count: number) => string;
  resultBar: (label: string, count: number, percent: number) => string;
  count: string;
  percent: string;
}

const catalog: LocaleCatalog<ChatVotingPanelTexts> = {
  de: {
    currentVote: "Laufende oder letzte Abstimmung",
    runningTitle: "Laufende Abstimmung",
    closedTitle: "Abstimmungsergebnis",
    runningStatus: "Läuft live",
    closedStatus: "Beendet",
    noVote: "Es läuft gerade keine Abstimmung.",
    loading: "Abstimmung wird geladen …",
    loadError: "Die Abstimmung konnte nicht geladen werden.",
    startSection: "Abstimmung starten",
    yesNo: "Ja/Nein",
    scale: "Skala 1–5",
    optionCount: "Anzahl der Optionen",
    options: "Optionen",
    startOptions: "Optionen starten",
    increaseOptionCount: "Optionszahl erhöhen",
    decreaseOptionCount: "Optionszahl verringern",
    close: "Abstimmung schließen",
    starts: (timestamp) => `Gestartet ${timestamp}`,
    ends: (timestamp) => `Endet ${timestamp}`,
    startError: "Die Abstimmung konnte nicht gestartet werden.",
    busy: "In diesem Kanal läuft bereits eine Abstimmung.",
    closeError: "Die Abstimmung konnte nicht geschlossen werden.",
    startDisabledReason: "Eine Abstimmung oder ein Votekick läuft bereits. Starte eine neue, wenn der aktuelle beendet ist.",
    invalidOptionCount: "Gib eine Zahl von 2 bis 9 ein.",
    voterCount: (count) => `${String(count)} Stimmen`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} Stimmen, ${String(percent)} Prozent`,
    count: "Stimmen",
    percent: "Anteil",
  },
  en: {
    currentVote: "Current or last vote",
    runningTitle: "Vote in progress",
    closedTitle: "Vote results",
    runningStatus: "Live",
    closedStatus: "Closed",
    noVote: "There is no vote in progress.",
    loading: "Loading the vote …",
    loadError: "The vote could not be loaded.",
    startSection: "Start a vote",
    yesNo: "Yes / No",
    scale: "Scale 1–5",
    optionCount: "Number of options",
    options: "Options",
    startOptions: "Start options vote",
    increaseOptionCount: "Increase option count",
    decreaseOptionCount: "Decrease option count",
    close: "Close vote",
    starts: (timestamp) => `Started ${timestamp}`,
    ends: (timestamp) => `Ends ${timestamp}`,
    startError: "The vote could not be started.",
    busy: "A vote is already in progress in this channel.",
    closeError: "The vote could not be closed.",
    startDisabledReason: "A vote or votekick is already in progress. Start another after it ends.",
    invalidOptionCount: "Enter a number from 2 to 9.",
    voterCount: (count) => `${String(count)} votes`,
    resultBar: (label, count, percent) => `${label}: ${String(count)} votes, ${String(percent)} percent`,
    count: "Votes",
    percent: "Share",
  },
};

export const chatVotingPanelTexts = (language: DashboardLanguage): ChatVotingPanelTexts => catalog[language];
