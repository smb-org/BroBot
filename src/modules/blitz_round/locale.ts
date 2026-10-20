import type { DashboardLanguage, LocaleCatalog } from "../../dashboard/locale";
import { blitzRoundSettingsSchema, type BlitzQuestionValidationCode, type BlitzRoundSettings } from "./contracts";
import type { BlitzWinner } from "./domain/round";

export interface BlitzTexts {
  title: string;
  subtitle: string;
  description: string;
  actionName: string;
  roundRunning: string;
  questionPoolEmpty: string;
  startFailed: string;
  roundStarted: string;
  addQuestion: string;
  newQuestion: string;
  emptyHint: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  previousPage: string;
  nextPage: string;
  pageCount: (page: number, total: number) => string;
  questionCount: (count: number) => string;
  type: string;
  questionLimit: string;
  duplicateAnswer: (answer: string) => string;
  enabledHint: string;
  unsavedTitle: string;
  unsavedDescription: string;
  settingsUnsavedDescription: string;
  continueEditing: string;
  secondsUnit: string;
  minutesUnit: string;
  autoStartHint: string;
  scramble: string;
  quiz: string;
  word: string;
  prompt: string;
  acceptedAnswers: string;
  answerPlaceholder: string;
  enabled: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  saveError: string;
  conflict: string;
  reload: string;
  validationError: (code: BlitzQuestionValidationCode) => string;
  delete: string;
  deleteTitle: string;
  deleteConfirm: string;
  deleteError: string;
  cancel: string;
  back: string;
  settings: string;
  questions: string;
  settingsSection: string;
  prize: string;
  answerTime: string;
  autoStart: string;
  autoStartInterval: string;
  chatTarget: string;
  channelDefault: string;
  allChats: string;
  sourceOnly: string;
  whereAsked: string;
  startText: string;
  solvedText: string;
  timeoutText: string;
  roundTextHint: string;
  settingsSaved: string;
  settingsError: string;
  noSelection: string;
  loadError: string;
  retry: string;
  removeAnswer: (answer: string) => string;
  invalidAnswer: string;
  roleLocked: string;
  startTextDefault: string;
  solvedTextDefault: string;
  timeoutTextDefault: string;
  timeoutAnswer: (answer: string) => string;
  solvedAnswer: (answer: string, winners: readonly BlitzWinner[], share: number) => string;
  winnerNames: (winners: readonly BlitzWinner[]) => string;
  roundTypeVariableLabel: string;
  roundTypeVariableDescription: string;
  promptVariableLabel: string;
  promptVariableDescription: string;
  answerVariableLabel: string;
  answerVariableDescription: string;
  prizeVariableLabel: string;
  prizeVariableDescription: string;
  secondsVariableLabel: string;
  secondsVariableDescription: string;
  winnersVariableLabel: string;
  winnersVariableDescription: string;
  shareVariableLabel: string;
  shareVariableDescription: string;
}

const catalog: LocaleCatalog<BlitzTexts> = {
  de: {
    title: "Blitzrunde",
    subtitle: "Fragenpool und Rundeneinstellungen",
    description: "Kurze Chat-Rätsel für Punktegewinne",
    actionName: "Blitzrunde starten",
    roundRunning: "Runde läuft",
    questionPoolEmpty: "Keine Fragen im Pool",
    startFailed: "Die Blitzrunde konnte nicht gestartet werden.",
    roundStarted: "Blitzrunde gestartet.",
    addQuestion: "Neue Frage",
    newQuestion: "Neue Frage",
    emptyHint: "Lege eine Wortsalat- oder Quizfrage an, damit der Chat mitraten kann.",
    search: "Fragen suchen",
    searchPlaceholder: "Frage oder Lösung suchen",
    clearSearch: "Suche löschen",
    previousPage: "Vorherige Seite",
    nextPage: "Nächste Seite",
    pageCount: (page, total) => `Seite ${String(page)} von ${String(total)}`,
    questionCount: (count) => `${String(count)} Fragen`,
    type: "Fragetyp",
    questionLimit: "Der Fragenpool ist voll.",
    duplicateAnswer: (answer) => `${answer} ist bereits eingetragen.`,
    enabledHint: "Aktive Fragen können in einer Runde erscheinen.",
    unsavedTitle: "Änderungen speichern?",
    unsavedDescription: "Du hast ungespeicherte Änderungen an dieser Frage.",
    settingsUnsavedDescription: "Du hast ungespeicherte Rundeneinstellungen.",
    continueEditing: "Weiter bearbeiten",
    secondsUnit: "Sekunden",
    minutesUnit: "Minuten",
    autoStartHint: "Starte Runden nur, wenn der Kanal live ist.",
    scramble: "Wortsalat",
    quiz: "Quiz",
    word: "Wort",
    prompt: "Frage",
    acceptedAnswers: "Akzeptierte Antworten",
    answerPlaceholder: "Antwort eingeben und Enter drücken",
    enabled: "Frage aktiv",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert",
    saving: "Wird gespeichert …",
    saveError: "Die Frage konnte nicht gespeichert werden.",
    conflict: "Die Frage wurde in der Zwischenzeit geändert. Lade sie neu, bevor du weiterarbeitest.",
    reload: "Frage neu laden",
    validationError: (code) => ({
      invalid_question: "Prüfe die Angaben zur Frage.",
      invalid_kind: "Wähle Wortsalat oder Quiz.",
      prompt_required: "Gib eine Frage oder ein Wort ein.",
      prompt_too_long: "Der Text darf höchstens 120 Zeichen lang sein.",
      answer_count_invalid: "Füge zwischen einer und zehn Antworten hinzu.",
      answer_invalid: "Jede Antwort muss 1 bis 60 Zeichen lang sein und darf nicht doppelt vorkommen.",
      scramble_word_invalid: "Das Wort muss aus 4 bis 16 Buchstaben bestehen.",
      scramble_word_repeated: "Das Wort braucht mindestens zwei verschiedene Buchstaben.",
    })[code],
    delete: "Löschen",
    deleteTitle: "Frage löschen?",
    deleteConfirm: "Diese Frage wird dauerhaft aus dem Pool entfernt.",
    deleteError: "Die Frage konnte nicht gelöscht werden.",
    cancel: "Abbrechen",
    back: "Zurück zu den Fragen",
    settings: "Einstellungen",
    questions: "Fragen",
    settingsSection: "Rundeneinstellungen",
    prize: "Preisgeld",
    answerTime: "Antwortzeit",
    autoStart: "Automatisch starten",
    autoStartInterval: "Abstand zwischen Runden",
    chatTarget: "Chat-Ziel",
    channelDefault: "Kanalstandard",
    allChats: "Alle Chats",
    sourceOnly: "Dieser Chat",
    whereAsked: "Chat der Frage",
    startText: "Startnachricht",
    solvedText: "Auflösung bei richtigen Antworten",
    timeoutText: "Auflösung ohne Gewinner",
    roundTextHint: "Variablen: {blitz.type}, {blitz.prompt}, {blitz.answer}, {blitz.prize}, {blitz.seconds}, {blitz.winners}, {blitz.share}",
    settingsSaved: "Einstellungen gespeichert.",
    settingsError: "Die Einstellungen konnten nicht gespeichert werden.",
    noSelection: "Wähle eine Frage aus oder erstelle eine neue.",
    loadError: "Der Fragenpool konnte nicht geladen werden.",
    retry: "Erneut laden",
    removeAnswer: (answer) => `Antwort ${answer} entfernen`,
    invalidAnswer: "Schließe die ungespeicherte Antwort mit Enter ab.",
    roleLocked: "Du darfst Fragen und Einstellungen nicht bearbeiten.",
    startTextDefault: "Blitzrunde! {blitz.type}: {blitz.prompt} · Die ersten Richtigen teilen sich {blitz.prize}. ({blitz.seconds} s)",
    solvedTextDefault: "Richtig: {blitz.answer} · {blitz.winners} · je +{blitz.share}",
    timeoutTextDefault: "Zeit um! Gesucht war: {blitz.answer}.",
    timeoutAnswer: (answer) => `Zeit um! Gesucht war: ${answer}.`,
    solvedAnswer: (answer, winners, share) => `Richtig: ${answer} · ${blitzTexts("de").winnerNames(winners)} · je +${String(share)}`,
    winnerNames: (winners) => {
      const names = winners.slice(0, 5).map(({ login }) => login.slice(0, 25));
      const remaining = winners.length - names.length;
      if (remaining > 0) names.push(`+${String(remaining)} weitere`);
      return names.join(", ");
    },
    roundTypeVariableLabel: "Rundentyp",
    roundTypeVariableDescription: "Wortsalat oder Quiz",
    promptVariableLabel: "Angezeigte Frage",
    promptVariableDescription: "Der Wortsalat oder die Quizfrage",
    answerVariableLabel: "Lösung",
    answerVariableDescription: "Die gespeicherte Lösung der Runde",
    prizeVariableLabel: "Preisgeld",
    prizeVariableDescription: "Das Preisgeld der Runde",
    secondsVariableLabel: "Antwortzeit",
    secondsVariableDescription: "Die Antwortzeit in Sekunden",
    winnersVariableLabel: "Gewinner",
    winnersVariableDescription: "Bis zu fünf Gewinnernamen",
    shareVariableLabel: "Anteil",
    shareVariableDescription: "Der Punkteanteil pro Gewinner",
  },
  en: {
    title: "Blitz Round",
    subtitle: "Question pool and round settings",
    description: "Short chat puzzles for point rewards",
    actionName: "Start Blitz Round",
    roundRunning: "Round is running",
    questionPoolEmpty: "No questions in the pool",
    startFailed: "The Blitz Round could not be started.",
    roundStarted: "Blitz Round started.",
    addQuestion: "New question",
    newQuestion: "New question",
    emptyHint: "Add a word scramble or quiz question so chat can join in.",
    search: "Search questions",
    searchPlaceholder: "Search prompt or solution",
    clearSearch: "Clear search",
    previousPage: "Previous page",
    nextPage: "Next page",
    pageCount: (page, total) => `Page ${String(page)} of ${String(total)}`,
    questionCount: (count) => `${String(count)} questions`,
    type: "Question type",
    questionLimit: "The question pool is full.",
    duplicateAnswer: (answer) => `${answer} is already listed.`,
    enabledHint: "Enabled questions can be selected for a round.",
    unsavedTitle: "Save changes?",
    unsavedDescription: "This question has unsaved changes.",
    settingsUnsavedDescription: "Round settings have unsaved changes.",
    continueEditing: "Keep editing",
    secondsUnit: "seconds",
    minutesUnit: "minutes",
    autoStartHint: "Rounds start only while the channel is live.",
    scramble: "Word scramble",
    quiz: "Quiz",
    word: "Word",
    prompt: "Question",
    acceptedAnswers: "Accepted answers",
    answerPlaceholder: "Type an answer and press Enter",
    enabled: "Question enabled",
    save: "Save",
    discard: "Discard",
    saved: "Saved",
    saving: "Saving …",
    saveError: "The question could not be saved.",
    conflict: "This question changed while you were editing it. Reload the saved version before continuing.",
    reload: "Reload question",
    validationError: (code) => ({
      invalid_question: "Check the question details.",
      invalid_kind: "Choose word scramble or quiz.",
      prompt_required: "Enter a question or word.",
      prompt_too_long: "Text must be 120 characters or fewer.",
      answer_count_invalid: "Add between one and ten answers.",
      answer_invalid: "Each answer must contain 1 to 60 characters and be unique.",
      scramble_word_invalid: "The word must contain 4 to 16 letters.",
      scramble_word_repeated: "The word needs at least two different letters.",
    })[code],
    delete: "Delete",
    deleteTitle: "Delete this question?",
    deleteConfirm: "This question will be removed from the pool.",
    deleteError: "The question could not be deleted.",
    cancel: "Cancel",
    back: "Back to questions",
    settings: "Settings",
    questions: "Questions",
    settingsSection: "Round settings",
    prize: "Prize",
    answerTime: "Answer time",
    autoStart: "Start automatically",
    autoStartInterval: "Time between rounds",
    chatTarget: "Chat target",
    channelDefault: "Channel default",
    allChats: "All chats",
    sourceOnly: "This chat",
    whereAsked: "Chat where asked",
    startText: "Start message",
    solvedText: "Result when viewers answer correctly",
    timeoutText: "Result when nobody wins",
    roundTextHint: "Variables: {blitz.type}, {blitz.prompt}, {blitz.answer}, {blitz.prize}, {blitz.seconds}, {blitz.winners}, {blitz.share}",
    settingsSaved: "Settings saved.",
    settingsError: "The settings could not be saved.",
    noSelection: "Choose a question or create a new one.",
    loadError: "The question pool could not be loaded.",
    retry: "Reload",
    removeAnswer: (answer) => `Remove answer ${answer}`,
    invalidAnswer: "Press Enter to finish the uncommitted answer.",
    roleLocked: "You cannot edit questions or settings.",
    startTextDefault: "Blitz round! {blitz.type}: {blitz.prompt} · First correct answers share {blitz.prize}. ({blitz.seconds} s)",
    solvedTextDefault: "Correct: {blitz.answer} · {blitz.winners} · +{blitz.share} each",
    timeoutTextDefault: "Time's up! The answer was: {blitz.answer}.",
    timeoutAnswer: (answer) => `Time's up! The answer was: ${answer}.`,
    solvedAnswer: (answer, winners, share) => `Correct: ${answer} · ${blitzTexts("en").winnerNames(winners)} · +${String(share)} each`,
    winnerNames: (winners) => {
      const names = winners.slice(0, 5).map(({ login }) => login.slice(0, 25));
      const remaining = winners.length - names.length;
      if (remaining > 0) names.push(`+${String(remaining)} more`);
      return names.join(", ");
    },
    roundTypeVariableLabel: "Round type",
    roundTypeVariableDescription: "Word scramble or quiz",
    promptVariableLabel: "Displayed prompt",
    promptVariableDescription: "The scramble or quiz question",
    answerVariableLabel: "Answer",
    answerVariableDescription: "The saved answer for this round",
    prizeVariableLabel: "Prize",
    prizeVariableDescription: "The round prize",
    secondsVariableLabel: "Answer time",
    secondsVariableDescription: "The answer time in seconds",
    winnersVariableLabel: "Winners",
    winnersVariableDescription: "Up to five winner names",
    shareVariableLabel: "Share",
    shareVariableDescription: "The points paid to each winner",
  },
};

export const blitzTexts = (language?: DashboardLanguage): BlitzTexts => catalog[language === "en" ? "en" : "de"];

export const formatBlitzResolutionLine = (input: {
  language: "de" | "en";
  answer: string;
  winners: readonly BlitzWinner[];
  share: number;
}): string => input.winners.length === 0
  ? catalog[input.language].timeoutAnswer(input.answer)
  : catalog[input.language].solvedAnswer(input.answer, input.winners, input.share);

export const blitzRoundDefaultsForLanguage = (language: "de" | "en"): BlitzRoundSettings => {
  const labels = catalog[language];
  return blitzRoundSettingsSchema.parse({
    startText: labels.startTextDefault,
    solvedText: labels.solvedTextDefault,
    timeoutText: labels.timeoutTextDefault,
  });
};

export const blitzRoundTypeLabel = (kind: "scramble" | "quiz", language: "de" | "en"): string => kind === "scramble"
  ? catalog[language].scramble
  : catalog[language].quiz;

export const blitzActionTexts = {
  name: { de: catalog.de.actionName, en: catalog.en.actionName },
  roundRunning: { de: catalog.de.roundRunning, en: catalog.en.roundRunning },
  questionPoolEmpty: { de: catalog.de.questionPoolEmpty, en: catalog.en.questionPoolEmpty },
  error: { de: catalog.de.startFailed, en: catalog.en.startFailed },
  started: { de: catalog.de.roundStarted, en: catalog.en.roundStarted },
} as const;
