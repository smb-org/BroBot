import type { DashboardLanguage } from "../../dashboard/locale";
import type { QuizQuestion, QuizSetValidationCode } from "./contracts";

export interface QuizPanelTexts {
  title: string;
  subtitle: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  newSet: string;
  creatingSet: string;
  page: (current: number, total: number) => string;
  previousPage: string;
  nextPage: string;
  noSets: string;
  noSetsDescription: string;
  selectSet: string;
  settings: string;
  settingsLoadError: string;
  retry: string;
  setName: string;
  setNamePlaceholder: string;
  addQuestion: string;
  question: (position: number) => string;
  questionText: string;
  questionPlaceholder: string;
  options: string;
  option: (position: number) => string;
  correctAnswer: (option: number, question: number) => string;
  correctAnswerHint: string;
  optionRequired: string;
  addOption: string;
  removeOption: (position: number) => string;
  removeQuestion: (position: number) => string;
  moveUp: (position: number) => string;
  moveDown: (position: number) => string;
  enabled: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  draftChangedWhileSaving: string;
  saveError: string;
  conflict: string;
  reload: string;
  reloading: string;
  validationError: (code: QuizSetValidationCode) => string;
  maximumSets: string;
  createError: string;
  delete: string;
  deleteTitle: string;
  deleteDescription: string;
  deleteError: string;
  deleting: string;
  confirm: string;
  cancel: string;
  unsavedTitle: string;
  unsavedDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndContinue: string;
  questionCount: (count: number) => string;
}

interface QuizStarterSetContent {
  name: string;
  questions: readonly Omit<QuizQuestion, "position">[];
}

const starterSets: Readonly<Record<DashboardLanguage, QuizStarterSetContent>> = {
  de: {
    name: "Allgemeinwissen",
    questions: [
      { text: "Welche Farbe entsteht aus Blau und Gelb?", options: ["Violett", "Grün", "Orange"], correctIndex: 1, enabled: true },
      { text: "Wie viele Beine hat eine Spinne?", options: ["Sechs", "Acht", "Zehn"], correctIndex: 1, enabled: true },
      { text: "Wie heißt gefrorenes Wasser?", options: ["Dampf", "Regen", "Eis"], correctIndex: 2, enabled: true },
      { text: "Welches Tier lebt im Wasser und atmet durch Kiemen?", options: ["Fisch", "Katze", "Eule"], correctIndex: 0, enabled: true },
      { text: "Wie viele Tage hat eine Woche?", options: ["Fünf", "Sieben", "Neun"], correctIndex: 1, enabled: true },
    ],
  },
  en: {
    name: "General knowledge",
    questions: [
      { text: "Which color do blue and yellow make?", options: ["Purple", "Green", "Orange"], correctIndex: 1, enabled: true },
      { text: "How many legs does a spider have?", options: ["Six", "Eight", "Ten"], correctIndex: 1, enabled: true },
      { text: "What is frozen water called?", options: ["Steam", "Rain", "Ice"], correctIndex: 2, enabled: true },
      { text: "Which animal lives in water and breathes through gills?", options: ["Fish", "Cat", "Owl"], correctIndex: 0, enabled: true },
      { text: "How many days are in a week?", options: ["Five", "Seven", "Nine"], correctIndex: 1, enabled: true },
    ],
  },
};

export const quizStarterSetContent = (language: DashboardLanguage): QuizStarterSetContent => starterSets[language];

const texts: Readonly<Record<DashboardLanguage, QuizPanelTexts>> = {
  de: {
    title: "Fragensets",
    subtitle: "Erstelle Quizfragen für deinen Kanal.",
    search: "Sets suchen",
    searchPlaceholder: "Nach Namen suchen",
    clearSearch: "Suche löschen",
    newSet: "Neues Set",
    creatingSet: "Set wird erstellt …",
    page: (current, total) => `Seite ${String(current)} von ${String(total)}`,
    previousPage: "Vorherige Seite",
    nextPage: "Nächste Seite",
    noSets: "Noch keine Fragensets",
    noSetsDescription: "Lege ein Set an und füge deine ersten Fragen hinzu.",
    selectSet: "Wähle ein Fragenset aus.",
    settings: "Einstellungen",
    settingsLoadError: "Die Quiz-Einstellungen konnten nicht geladen werden.",
    retry: "Erneut versuchen",
    setName: "Set-Name",
    setNamePlaceholder: "Zum Beispiel: Allgemeinwissen",
    addQuestion: "Frage hinzufügen",
    question: (position) => `Frage ${String(position)}`,
    questionText: "Fragetext",
    questionPlaceholder: "Schreibe eine Frage",
    options: "Antwortoptionen",
    option: (position) => `Option ${String(position)}`,
    correctAnswer: (option, question) => `Richtige Antwort Option ${String(option)} für Frage ${String(question)}`,
    correctAnswerHint: "Richtige Antwort per Auswahlkreis markieren.",
    optionRequired: "Darf nicht leer sein.",
    addOption: "Option hinzufügen",
    removeOption: (position) => `Option ${String(position)} entfernen`,
    removeQuestion: (position) => `Frage ${String(position)} entfernen`,
    moveUp: (position) => `Frage ${String(position)} nach oben verschieben`,
    moveDown: (position) => `Frage ${String(position)} nach unten verschieben`,
    enabled: "Frage aktiv",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert",
    saving: "Speichert …",
    draftChangedWhileSaving: "Der Entwurf hat sich während des Speicherns geändert. Speichere erneut.",
    saveError: "Das Set konnte nicht gespeichert werden.",
    conflict: "Das Set wurde zwischenzeitlich geändert.",
    reload: "Neu laden",
    reloading: "Wird neu geladen …",
    validationError: (code) => ({
      invalid_set: "Prüfe die Eingaben und versuche es erneut.",
      set_name_required: "Gib einen Namen für das Set ein.",
      question_count_invalid: "Ein Set kann höchstens 100 Fragen enthalten.",
      question_invalid: "Eine Frage enthält ungültige Angaben.",
      question_text_required: "Gib einen Fragetext ein.",
      question_too_long: "Ein Fragetext darf höchstens 200 Zeichen lang sein.",
      option_count_invalid: "Jede Frage braucht zwei bis vier Antwortoptionen.",
      option_invalid: "Antwortoptionen dürfen nicht leer sein.",
      option_too_long: "Eine Antwortoption darf höchstens 80 Zeichen lang sein.",
      correct_index_invalid: "Wähle eine richtige Antwort aus.",
    })[code],
    maximumSets: "In diesem Kanal sind bereits 50 Sets vorhanden.",
    createError: "Das Set konnte nicht erstellt werden.",
    delete: "Set löschen",
    deleteTitle: "Dieses Quiz-Set löschen?",
    deleteDescription: "Das Set und alle zugehörigen Fragen werden gelöscht.",
    deleteError: "Das Set konnte nicht gelöscht werden.",
    deleting: "Wird gelöscht …",
    confirm: "Set löschen",
    cancel: "Abbrechen",
    unsavedTitle: "Änderungen noch nicht gespeichert",
    unsavedDescription: "Speichere oder verwirf deine Änderungen, bevor du das Set wechselst.",
    continueEditing: "Weiter bearbeiten",
    discardAndSwitch: "Verwerfen und wechseln",
    saveAndContinue: "Speichern und wechseln",
    questionCount: (count) => `${String(count)} ${count === 1 ? "Frage" : "Fragen"}`,
  },
  en: {
    title: "Question sets",
    subtitle: "Create quiz questions for your channel.",
    search: "Search sets",
    searchPlaceholder: "Search by name",
    clearSearch: "Clear search",
    newSet: "New set",
    creatingSet: "Creating set …",
    page: (current, total) => `Page ${String(current)} of ${String(total)}`,
    previousPage: "Previous page",
    nextPage: "Next page",
    noSets: "No question sets yet",
    noSetsDescription: "Create a set and add your first questions.",
    selectSet: "Choose a question set.",
    settings: "Settings",
    settingsLoadError: "The quiz settings could not be loaded.",
    retry: "Try again",
    setName: "Set name",
    setNamePlaceholder: "For example: General knowledge",
    addQuestion: "Add question",
    question: (position) => `Question ${String(position)}`,
    questionText: "Question text",
    questionPlaceholder: "Write a question",
    options: "Answer options",
    option: (position) => `Option ${String(position)}`,
    correctAnswer: (option, question) => `Correct answer option ${String(option)} for question ${String(question)}`,
    correctAnswerHint: "Mark the correct answer with its radio button.",
    optionRequired: "Must not be empty.",
    addOption: "Add option",
    removeOption: (position) => `Remove option ${String(position)}`,
    removeQuestion: (position) => `Remove question ${String(position)}`,
    moveUp: (position) => `Move question ${String(position)} up`,
    moveDown: (position) => `Move question ${String(position)} down`,
    enabled: "Question enabled",
    save: "Save",
    discard: "Discard",
    saved: "Saved",
    saving: "Saving …",
    draftChangedWhileSaving: "The draft changed while saving. Save again to include the latest edits.",
    saveError: "The set could not be saved.",
    conflict: "The set changed while you were editing it.",
    reload: "Reload",
    reloading: "Reloading …",
    validationError: (code) => ({
      invalid_set: "Check the fields and try again.",
      set_name_required: "Enter a name for this set.",
      question_count_invalid: "A set can contain up to 100 questions.",
      question_invalid: "A question contains invalid details.",
      question_text_required: "Enter the question text.",
      question_too_long: "Question text can be up to 200 characters.",
      option_count_invalid: "Each question needs two to four answer options.",
      option_invalid: "Answer options cannot be empty.",
      option_too_long: "Answer options can be up to 80 characters.",
      correct_index_invalid: "Select a correct answer.",
    })[code],
    maximumSets: "This channel already has 50 sets.",
    createError: "The set could not be created.",
    delete: "Delete set",
    deleteTitle: "Delete this quiz set?",
    deleteDescription: "The set and all its questions will be deleted.",
    deleteError: "The set could not be deleted.",
    deleting: "Deleting …",
    confirm: "Delete set",
    cancel: "Cancel",
    unsavedTitle: "Unsaved changes",
    unsavedDescription: "Save or discard your changes before switching sets.",
    continueEditing: "Continue editing",
    discardAndSwitch: "Discard and switch",
    saveAndContinue: "Save and switch",
    questionCount: (count) => `${String(count)} ${count === 1 ? "question" : "questions"}`,
  },
};

export const quizPanelTexts = (language: DashboardLanguage): QuizPanelTexts => texts[language];

export const quizCatalog = {
  de: {
    startLine: (setName: string, count: number) => `Quiz „${setName}“ startet · ${String(count)} ${count === 1 ? "Frage" : "Fragen"}.`,
    questionLine: (position: number, total: number, question: string, options: readonly string[]) =>
      `Frage ${String(position)}/${String(total)}: ${question} · ${options.map((option, index) => `${String(index + 1)}: ${option}`).join(" · ")}`,
    resultLine: (ranking: readonly { login: string; correct: number; rank: number; payout: number }[], distributed: number) => ranking.length === 0
      ? `Quiz beendet · keine Antworten · ${String(distributed)} Punkte ausgezahlt.`
      : `Quiz beendet · ${ranking.map((entry) => `${String(entry.rank)}. ${entry.login} (${String(entry.correct)} richtig, +${String(entry.payout)})`).join(" · ")} · ${String(distributed)} Punkte ausgezahlt.`,
    startAction: "Quiz starten",
    nextAction: "Weiter",
    pauseAction: "Pause",
    resumeAction: "Fortsetzen",
    endAction: "Beenden",
    actionError: "Die Quizaktion ist fehlgeschlagen.",
    started: "Quiz gestartet.",
    advanced: "Quizphase beendet.",
    paused: "Quiz pausiert.",
    resumed: "Quiz fortgesetzt.",
    ended: "Quiz beendet.",
    roundRunning: "Ein Quiz läuft bereits.",
    noQuestionSets: "Kein Fragenset mit aktiven Fragen vorhanden.",
    streamOffline: "Der Stream muss live sein.",
    chooseSet: "Fragenset",
    chooseSetPlaceholder: "Set auswählen",
    questionsLabel: "Fragen",
    allQuestions: "Alle aktiven Fragen",
    loadError: "Fragensets konnten nicht geladen werden.",
    enabledQuestionCount: (count: number) => `${String(count)} ${count === 1 ? "aktive Frage" : "aktive Fragen"}`,
    firstQuestions: (count: number) => `Erste ${String(count)}`,
    sessionTitle: "Quiz",
    phase: { announce: "Frage wird angekündigt", open: "Antworten offen", reveal: "Lösung", results: "Ergebnis" },
    questionProgress: (current: number, total: number) => `Frage ${String(current)} von ${String(total)}`,
    controlError: "Quizaktion fehlgeschlagen. Bitte erneut versuchen.",
    pausedLabel: "Pausiert",
    timeLeft: (time: string) => `Noch ${time}`,
  },
  en: {
    startLine: (setName: string, count: number) => `Quiz “${setName}” starts · ${String(count)} ${count === 1 ? "question" : "questions"}.`,
    questionLine: (position: number, total: number, question: string, options: readonly string[]) =>
      `Question ${String(position)}/${String(total)}: ${question} · ${options.map((option, index) => `${String(index + 1)}: ${option}`).join(" · ")}`,
    resultLine: (ranking: readonly { login: string; correct: number; rank: number; payout: number }[], distributed: number) => ranking.length === 0
      ? `Quiz ended · no answers · ${String(distributed)} points paid.`
      : `Quiz ended · ${ranking.map((entry) => `${String(entry.rank)}. ${entry.login} (${String(entry.correct)} correct, +${String(entry.payout)})`).join(" · ")} · ${String(distributed)} points paid.`,
    startAction: "Start quiz",
    nextAction: "Next",
    pauseAction: "Pause",
    resumeAction: "Resume",
    endAction: "End",
    actionError: "The quiz action failed.",
    started: "Quiz started.",
    advanced: "Quiz phase ended.",
    paused: "Quiz paused.",
    resumed: "Quiz resumed.",
    ended: "Quiz ended.",
    roundRunning: "A quiz is already running.",
    noQuestionSets: "No question set with enabled questions is available.",
    streamOffline: "The stream must be live.",
    chooseSet: "Question set",
    chooseSetPlaceholder: "Choose a set",
    questionsLabel: "Questions",
    allQuestions: "All enabled questions",
    loadError: "Question sets could not be loaded.",
    enabledQuestionCount: (count: number) => `${String(count)} ${count === 1 ? "enabled question" : "enabled questions"}`,
    firstQuestions: (count: number) => `First ${String(count)}`,
    sessionTitle: "Quiz",
    phase: { announce: "Announcing question", open: "Answers open", reveal: "Answer reveal", results: "Results" },
    questionProgress: (current: number, total: number) => `Question ${String(current)} of ${String(total)}`,
    controlError: "Quiz action failed. Try again.",
    pausedLabel: "Paused",
    timeLeft: (time: string) => `${time} left`,
  },
} as const;

export const quizCockpitTexts = (language: DashboardLanguage) => quizCatalog[language];
