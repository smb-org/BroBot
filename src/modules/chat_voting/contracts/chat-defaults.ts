import type { ModuleLanguage } from "../../contract";
import type { ChatVotePreset, ChatVotingTextMode } from "./index";

export const DEFAULT_CHAT_VOTING_START_TEXT = "Abstimmung gestartet: {vote.title} – {vote.options} – läuft {vote.duration}";
export const DEFAULT_CHAT_VOTING_START_TEXT_EN = "Vote started: {vote.title} – {vote.options} – runs for {vote.duration}";
export const LEGACY_CHAT_VOTING_START_TEXT = "Abstimmung gestartet: {vote.title} – {vote.options}";
export const LEGACY_CHAT_VOTING_START_TEXT_EN = "Vote started: {vote.title} – {vote.options}";
export const DEFAULT_CHAT_VOTING_START_DURATION_SUFFIX = {
  de: " – läuft {vote.duration}",
  en: " – runs for {vote.duration}",
} as const satisfies Readonly<Record<ModuleLanguage, string>>;

const durationCatalog = {
  de: { second: "Sekunde", seconds: "Sekunden", minute: "Minute", minutes: "Minuten" },
  en: { second: "second", seconds: "seconds", minute: "minute", minutes: "minutes" },
} as const satisfies Readonly<Record<ModuleLanguage, { second: string; seconds: string; minute: string; minutes: string }>>;

export const chatVotingDurationText = (language: ModuleLanguage, seconds: number | null): string => {
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0) return "";
  const useMinutes = seconds % 60 === 0;
  const amount = useMinutes ? seconds / 60 : seconds;
  const unit = useMinutes
    ? amount === 1 ? durationCatalog[language].minute : durationCatalog[language].minutes
    : amount === 1 ? durationCatalog[language].second : durationCatalog[language].seconds;
  return `${String(amount)} ${unit}`;
};

const freeTextOptionCatalog = {
  de: { firstWord: "schreib ein Wort", wholeMessage: "schreib deine Antwort" },
  en: { firstWord: "type one word", wholeMessage: "type your answer" },
} as const satisfies Readonly<Record<ModuleLanguage, { firstWord: string; wholeMessage: string }>>;

export const chatVotingFreeTextOptionText = (language: ModuleLanguage, mode: ChatVotingTextMode | null | undefined): string =>
  mode === "whole_message" ? freeTextOptionCatalog[language].wholeMessage : freeTextOptionCatalog[language].firstWord;

type ChatTextKey = "help" | "busy" | "started" | "result" | "startFailed" | "noOpenVote" | "closing" |
  "noPreviousVote" | "invalidQuestion" | "invalidQuestionTooLong" | "invalidAnswerCount" | "invalidLabels" | "invalidDuration" |
  "unknownShortcut" | "templateStartProblem";
type ChatTextCatalog = Readonly<Record<Exclude<ChatTextKey, "started" | "result" | "unknownShortcut" | "templateStartProblem">, string>> & {
  started: (preset: ChatVotePreset, count: number, textMode: ChatVotingTextMode | null, title: string | null) => string;
  result: (title: string | null, result: string) => string;
  unknownShortcut: (shortcut: string) => string;
  templateStartProblem: (title: string, problem: "answers" | "duration") => string;
};

const catalog: Readonly<Record<ModuleLanguage, ChatTextCatalog>> = {
  de: {
    help: "Nutze !vote <Kürzel> für gespeicherte Abstimmungen, !vote yesno|scale|01|12 [Frage], !vote 2–9 [Frage], !vote text [word|message] [Frage], !vote Frage? | Antwort 1 | Antwort 2 [| Dauer], !vote again oder !vote end.",
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
    noPreviousVote: "Es gibt keine vorherige Abstimmung zum Wiederholen.",
    invalidQuestion: "Eine eigene Abstimmung braucht eine Frage mit abschließendem Fragezeichen.",
    invalidQuestionTooLong: "Die Frage darf höchstens 80 Zeichen lang sein.",
    invalidAnswerCount: "Eine Abstimmung braucht zwei bis neun Antworten.",
    invalidLabels: "Antworten müssen eindeutig, nicht leer und höchstens 32 Zeichen lang sein.",
    invalidDuration: "Die Dauer muss zwischen einer Sekunde und vier Stunden liegen.",
    unknownShortcut: (shortcut) => `Unbekanntes Abstimmungskürzel: !vote ${shortcut}.`,
    templateStartProblem: (title, problem) => `„${title || "Ohne Titel"}“ kann nicht starten: ${problem === "answers" ? "Es braucht zwei bis neun eindeutige Antworten." : "Die Dauer muss zwischen einer Sekunde und vier Stunden liegen."}`,
  },
  en: {
    help: "Use !vote <shortcut> for saved votes, !vote yesno|scale|01|12 [question], !vote 2–9 [question], !vote text [word|message] [question], !vote Question? | Answer 1 | Answer 2 [| duration], !vote again, or !vote end.",
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
    noPreviousVote: "There is no previous vote to repeat.",
    invalidQuestion: "A custom vote needs a question ending in a question mark.",
    invalidQuestionTooLong: "The question can be at most 80 characters long.",
    invalidAnswerCount: "A vote needs two to nine answers.",
    invalidLabels: "Answers must be unique, nonempty, and at most 32 characters long.",
    invalidDuration: "Duration must be from one second to four hours.",
    unknownShortcut: (shortcut) => `Unknown vote shortcut: !vote ${shortcut}.`,
    templateStartProblem: (title, problem) => `“${title || "Untitled"}” cannot start: ${problem === "answers" ? "It needs two to nine unique answers." : "Duration must be from one second to four hours."}`,
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
  problem?: "answers" | "duration",
): string => message === "started"
  ? catalog[language].started(preset ?? "yes_no", optionCount ?? 2, textMode ?? null, title ?? null)
  : message === "result"
    ? catalog[language].result(title ?? null, result ?? "")
    : message === "unknownShortcut"
      ? catalog[language].unknownShortcut(title ?? "")
      : message === "templateStartProblem"
        ? catalog[language].templateStartProblem(title ?? "", problem ?? "answers")
        : catalog[language][message];
