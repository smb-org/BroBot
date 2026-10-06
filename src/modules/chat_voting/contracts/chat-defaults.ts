import type { ModuleLanguage } from "../../contract";
import type { ChatVotePreset, ChatVotingTextMode } from "./index";

type ChatTextKey = "help" | "busy" | "started" | "startFailed" | "noOpenVote" | "closing";
type ChatTextCatalog = Readonly<Record<Exclude<ChatTextKey, "started">, string>> & {
  started: (preset: ChatVotePreset, count: number, textMode: ChatVotingTextMode | null) => string;
};

const catalog: Readonly<Record<ModuleLanguage, ChatTextCatalog>> = {
  de: {
    help: "Nutze !vote yesno, !vote scale, !vote 01, !vote 12, !vote 2–9, !vote text [word|message] oder !vote end.",
    busy: "Es läuft bereits eine Abstimmung.",
    started: (preset, count, mode) => preset === "digit_01" ? "Abstimmung gestartet. Stimme mit 0 oder 1 ab."
      : preset === "digit_12" ? "Abstimmung gestartet. Stimme mit 1 oder 2 ab."
        : preset === "free_text" ? `Freitext-Abstimmung gestartet. ${mode === "whole_message" ? "Stimme mit einer Nachricht" : "Stimme mit dem ersten Wort"} ab.`
          : `Abstimmung gestartet. Stimme mit einer Zahl von 1 bis ${String(count)} ab.`,
    startFailed: "Die Abstimmung konnte nicht gestartet werden.",
    noOpenVote: "Es läuft gerade keine Abstimmung.",
    closing: "Die Abstimmung wird geschlossen.",
  },
  en: {
    help: "Use !vote yesno, !vote scale, !vote 01, !vote 12, !vote 2–9, !vote text [word|message], or !vote end.",
    busy: "A vote is already in progress.",
    started: (preset, count, mode) => preset === "digit_01" ? "Voting started. Type 0 or 1 to vote."
      : preset === "digit_12" ? "Voting started. Type 1 or 2 to vote."
        : preset === "free_text" ? `Free-text voting started. Vote with ${mode === "whole_message" ? "a message" : "the first word"}.`
          : `Voting started. Type a number from 1 to ${String(count)} to vote.`,
    startFailed: "The vote could not be started.",
    noOpenVote: "There is no vote in progress.",
    closing: "The vote is closing.",
  },
};

export const chatVotingChatText = (
  language: ModuleLanguage,
  message: ChatTextKey,
  optionCount?: number,
  preset?: ChatVotePreset,
  textMode?: ChatVotingTextMode | null,
): string => message === "started"
  ? catalog[language].started(preset ?? "yes_no", optionCount ?? 2, textMode ?? null)
  : catalog[language][message];
