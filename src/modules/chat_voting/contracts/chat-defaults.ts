import type { ModuleLanguage } from "../../contract";

type ChatTextKey = "help" | "busy" | "started" | "startFailed" | "noOpenVote" | "closing";
type ChatTextCatalog = Readonly<Record<Exclude<ChatTextKey, "started">, string>> & {
  started: (count: number) => string;
};

const catalog: Readonly<Record<ModuleLanguage, ChatTextCatalog>> = {
  de: {
    help: "Nutze !vote yesno, !vote scale, !vote 2–9 oder !vote end.",
    busy: "Es läuft bereits eine Abstimmung.",
    started: (count) => `Abstimmung gestartet. Stimme mit einer Zahl von 1 bis ${String(count)} ab.`,
    startFailed: "Die Abstimmung konnte nicht gestartet werden.",
    noOpenVote: "Es läuft gerade keine Abstimmung.",
    closing: "Die Abstimmung wird geschlossen.",
  },
  en: {
    help: "Use !vote yesno, !vote scale, !vote 2–9, or !vote end.",
    busy: "A vote is already in progress.",
    started: (count) => `Voting started. Type a number from 1 to ${String(count)} to vote.`,
    startFailed: "The vote could not be started.",
    noOpenVote: "There is no vote in progress.",
    closing: "The vote is closing.",
  },
};

export const chatVotingChatText = (language: ModuleLanguage, message: ChatTextKey, optionCount?: number): string =>
  message === "started" ? catalog[language].started(optionCount ?? 2) : catalog[language][message];
