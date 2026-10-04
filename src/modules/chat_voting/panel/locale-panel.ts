import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";

export interface ChatVotingPanelTexts {
  liveSection: string;
  noVote: string;
  loading: string;
  loadError: string;
  startSection: string;
  option: string;
  yesNo: string;
  scale: string;
  options: (count: number) => string;
  close: string;
  closing: string;
  open: string;
  closed: string;
  starts: (timestamp: string) => string;
  ends: (timestamp: string) => string;
  startError: string;
  busy: string;
  closeError: string;
  voterCount: (count: number) => string;
  voters: string;
}

const catalog: LocaleCatalog<ChatVotingPanelTexts> = {
  de: {
    liveSection: "Laufende Abstimmung",
    noVote: "Es läuft gerade keine Abstimmung.",
    loading: "Abstimmung wird geladen …",
    loadError: "Die Abstimmung konnte nicht geladen werden.",
    startSection: "Abstimmung starten",
    option: "Option",
    yesNo: "Ja / Nein",
    scale: "Skala 1–5",
    options: (count) => `${String(count)} Optionen`,
    close: "Abstimmung schließen",
    closing: "Wird geschlossen …",
    open: "Läuft",
    closed: "Beendet",
    starts: (timestamp) => `Gestartet ${timestamp}`,
    ends: (timestamp) => `Endet ${timestamp}`,
    startError: "Die Abstimmung konnte nicht gestartet werden.",
    busy: "In diesem Kanal läuft bereits eine Abstimmung.",
    closeError: "Die Abstimmung konnte nicht geschlossen werden.",
    voterCount: (count) => `${String(count)} Stimmen`,
    voters: "Stimmen",
  },
  en: {
    liveSection: "Current vote",
    noVote: "There is no vote in progress.",
    loading: "Loading the vote …",
    loadError: "The vote could not be loaded.",
    startSection: "Start a vote",
    option: "Option",
    yesNo: "Yes / No",
    scale: "Scale 1–5",
    options: (count) => `${String(count)} options`,
    close: "Close vote",
    closing: "Closing …",
    open: "Open",
    closed: "Closed",
    starts: (timestamp) => `Started ${timestamp}`,
    ends: (timestamp) => `Ends ${timestamp}`,
    startError: "The vote could not be started.",
    busy: "A vote is already in progress in this channel.",
    closeError: "The vote could not be closed.",
    voterCount: (count) => `${String(count)} votes`,
    voters: "Votes",
  },
};

export const chatVotingPanelTexts = (language: DashboardLanguage): ChatVotingPanelTexts => catalog[language];
