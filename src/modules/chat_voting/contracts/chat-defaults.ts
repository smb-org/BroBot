import type { ModuleLanguage } from "../../contract";
import type { ChatVotePreset, ChatVotingTextMode } from "./index";

export const DEFAULT_CHAT_VOTING_START_TEXT = "Abstimmung gestartet: {vote.title} – {vote.options}";
export const DEFAULT_CHAT_VOTING_START_TEXT_EN = "Vote started: {vote.title} – {vote.options}";

const freeTextOptionCatalog = {
  de: { firstWord: "schreib ein Wort", wholeMessage: "schreib deine Antwort" },
  en: { firstWord: "type one word", wholeMessage: "type your answer" },
} as const satisfies Readonly<Record<ModuleLanguage, { firstWord: string; wholeMessage: string }>>;

export const chatVotingFreeTextOptionText = (language: ModuleLanguage, mode: ChatVotingTextMode | null | undefined): string =>
  mode === "whole_message" ? freeTextOptionCatalog[language].wholeMessage : freeTextOptionCatalog[language].firstWord;

type ChatTextKey = "help" | "busy" | "started" | "result" | "startFailed" | "noOpenVote" | "closing";
type ChatTextCatalog = Readonly<Record<Exclude<ChatTextKey, "started" | "result">, string>> & {
  started: (preset: ChatVotePreset, count: number, textMode: ChatVotingTextMode | null, title: string | null) => string;
  result: (title: string | null, result: string) => string;
};

const catalog: Readonly<Record<ModuleLanguage, ChatTextCatalog>> = {
  de: {
    help: "Nutze !vote yesno [Frage], !vote scale [Frage], !vote 01 [Frage], !vote 12 [Frage], !vote 2–9 [Frage], !vote text [word|message] [Frage] oder !vote end.",
    busy: "Es läuft bereits eine Abstimmung.",
    started: (preset, count, mode, title) => {
      const intro = title === null
        ? preset === "free_text" ? "Freitext-Abstimmung gestartet." : "Abstimmung gestartet."
        : `Abstimmung „${title}“ gestartet.`;
      const instruction = preset === "digit_01" ? "Stimme mit 0 oder 1 ab."
        : preset === "digit_12" ? "Stimme mit 1 oder 2 ab."
          : preset === "free_text" ? `${mode === "whole_message" ? "Stimme mit einer Nachricht" : "Stimme mit dem ersten Wort"} ab.`
            : `Stimme mit einer Zahl von 1 bis ${String(count)} ab.`;
      return `${intro} ${instruction}`;
    },
    result: (title, result) => title === null ? result : `Ergebnis „${title}“: ${result}`,
    startFailed: "Die Abstimmung konnte nicht gestartet werden.",
    noOpenVote: "Es läuft gerade keine Abstimmung.",
    closing: "Die Abstimmung wird geschlossen.",
  },
  en: {
    help: "Use !vote yesno [question], !vote scale [question], !vote 01 [question], !vote 12 [question], !vote 2–9 [question], !vote text [word|message] [question], or !vote end.",
    busy: "A vote is already in progress.",
    started: (preset, count, mode, title) => {
      const intro = title === null
        ? preset === "free_text" ? "Free-text voting started." : "Voting started."
        : `Voting “${title}” started.`;
      const instruction = preset === "digit_01" ? "Type 0 or 1 to vote."
        : preset === "digit_12" ? "Type 1 or 2 to vote."
          : preset === "free_text" ? `Vote with ${mode === "whole_message" ? "a message" : "the first word"}.`
            : `Type a number from 1 to ${String(count)} to vote.`;
      return `${intro} ${instruction}`;
    },
    result: (title, result) => title === null ? result : `Results for “${title}”: ${result}`,
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
  title?: string | null,
  result?: string,
): string => message === "started"
  ? catalog[language].started(preset ?? "yes_no", optionCount ?? 2, textMode ?? null, title ?? null)
  : message === "result"
    ? catalog[language].result(title ?? null, result ?? "")
    : catalog[language][message];
