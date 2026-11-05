import type { ModuleLanguage } from "../../contract";

export const pollsPanelTexts: Readonly<Record<ModuleLanguage, {
  page: string;
  runningNow: string;
  poll: string;
  prediction: string;
  activeStatus: string;
  noPoll: string;
  noPrediction: string;
  remaining: string;
  ended: string;
  votes: string;
  users: (count: number) => string;
  points: string;
  end: string;
  lock: string;
  resolve: string;
  cancel: string;
  openPredictions: string;
  noOpenPredictions: string;
  refundDeadline: string;
  checkOnTwitch: string;
  dismiss: string;
  dismissed: string;
  preparedEntries: string;
  noEntries: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  filter: string;
  allKinds: string;
  polls: string;
  predictions: string;
  newEntry: string;
  createEntry: string;
  editEntry: string;
  duplicate: string;
  delete: string;
  moreActions: string;
  start: string;
  edit: string;
  kind: string;
  title: string;
  choices: string;
  choicesLimit: (minimum: number, maximum: number) => string;
  choice: (index: number) => string;
  choiceCount: (count: number) => string;
  duration: string;
  durationLimit: (minimum: number, maximum: number) => string;
  seconds: string;
  channelPointsVoting: string;
  channelPointsCost: string;
  channelPointsLimit: (minimum: number, maximum: number) => string;
  addChoice: string;
  removeChoice: string;
  moveChoiceUp: string;
  moveChoiceDown: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  discardChangesTitle: string;
  discardChangesDescription: string;
  continueEditing: string;
  cancelDialog: string;
  cancelDescription: string;
  confirmCancel: string;
  resolveDialog: string;
  loadingFresh: string;
  resolveChoice: (choice: string) => string;
  noOutcomes: string;
  closeDialog: string;
  deleteTitle: string;
  deleteDescription: (title: string) => string;
  confirmDelete: string;
  history: string;
  historyEmpty: string;
  previousPage: string;
  nextPage: string;
  source: string;
  sourceBot: string;
  sourceTwitch: string;
  result: string;
  resultUnknown: string;
  resultCanceled: string;
  statusCompleted: string;
  statusTerminated: string;
  statusArchived: string;
  statusActive: string;
  statusLocked: string;
  resultResolved: (choice: string) => string;
  startedAt: string;
  refreshFromTwitch: string;
  loading: string;
  loadFailed: string;
  retry: string;
  successSaved: string;
  successDeleted: string;
  successStarted: string;
  successEnded: string;
  successLocked: string;
  successResolved: string;
  successCanceled: string;
  successDismissed: string;
  successReconciled: string;
  runningPollReason: string;
  runningPredictionReason: string;
  runningLockReason: string;
  entryLimit: string;
  invalidEntry: string;
  conflict: string;
  moduleDisabled: string;
  managementDenied: string;
  runNotFound: string;
  notOpen: string;
  notDismissible: string;
  notEligible: string;
  alreadyActive: string;
  missingConnection: string;
  tokenUnavailable: string;
  missingScope: string;
  revoked: string;
  refreshFailed: string;
  rateLimited: string;
  network: string;
  requestFailed: string;
  twitchStatusUnknown: string;
  twitchInvalidResponse: string;
  choiceInvalid: string;
  serverTitleError: string;
  serverChoiceError: string;
  serverDurationError: string;
  serverCostError: string;
  localTitleError: string;
  localChoiceError: string;
  localChoicesError: string;
  localDurationError: string;
  localCostError: string;
  characterCount: (count: number, max: number) => string;
  unknownError: string;
}> > = {
  de: {
    page: "Umfragen & Predictions",
    runningNow: "Läuft gerade",
    poll: "Umfrage",
    prediction: "Prediction",
    activeStatus: "Läuft",
    noPoll: "Keine Umfrage aktiv",
    noPrediction: "Keine Prediction aktiv",
    remaining: "Verbleibend",
    ended: "Beendet",
    votes: "Stimmen",
    users: (count) => count === 1 ? "Person" : "Personen",
    points: "Punkte",
    end: "Beenden",
    lock: "Sperren",
    resolve: "Auflösen …",
    cancel: "Abbrechen …",
    openPredictions: "Offene Predictions",
    noOpenPredictions: "Es gibt keine offenen Predictions.",
    refundDeadline: "Punkte werden zurückgegeben ab",
    checkOnTwitch: "Unbekannter Lauf · auf Twitch prüfen",
    dismiss: "Verwerfen",
    dismissed: "Lauf wurde verworfen.",
    preparedEntries: "Vorbereitete Einträge",
    noEntries: "Keine passenden Einträge vorhanden.",
    search: "Einträge suchen",
    searchPlaceholder: "Titel eingeben",
    clearSearch: "Suche leeren",
    filter: "Eintragstyp",
    allKinds: "Alle",
    polls: "Umfragen",
    predictions: "Predictions",
    newEntry: "Neu",
    createEntry: "Neuer Eintrag",
    editEntry: "Eintrag bearbeiten",
    duplicate: "Duplizieren",
    delete: "Löschen",
    moreActions: "Weitere Aktionen",
    start: "Starten",
    edit: "Bearbeiten",
    kind: "Typ",
    title: "Titel",
    choices: "Antworten",
    choicesLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} Antworten`,
    choice: (index) => `Antwort ${String(index)}`,
    choiceCount: (count) => `${String(count)} Antworten`,
    duration: "Dauer",
    durationLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} Sekunden`,
    seconds: "Sekunden",
    channelPointsVoting: "Zusatzstimmen mit Kanalpunkten",
    channelPointsCost: "Kanalpunkte je Stimme",
    channelPointsLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} Punkte`,
    addChoice: "Antwort hinzufügen",
    removeChoice: "Antwort entfernen",
    moveChoiceUp: "Antwort nach oben",
    moveChoiceDown: "Antwort nach unten",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert",
    saving: "Wird gespeichert …",
    discardChangesTitle: "Änderungen verwerfen?",
    discardChangesDescription: "Nicht gespeicherte Änderungen gehen verloren.",
    continueEditing: "Weiter bearbeiten",
    cancelDialog: "Prediction abbrechen?",
    cancelDescription: "Alle gesetzten Kanalpunkte werden an die Zuschauer zurückgegeben.",
    confirmCancel: "Prediction abbrechen",
    resolveDialog: "Prediction auflösen",
    loadingFresh: "Aktuelle Ausgänge von Twitch werden geladen …",
    resolveChoice: (choice) => `„${choice}“ auszahlen`,
    noOutcomes: "Twitch hat keine Ausgänge für diese Prediction geliefert.",
    closeDialog: "Schließen",
    deleteTitle: "Eintrag löschen?",
    deleteDescription: (title) => `„${title}“ wird aus den vorbereiteten Einträgen gelöscht. Gespeicherte Läufe bleiben erhalten.`,
    confirmDelete: "Eintrag löschen",
    history: "Verlauf",
    historyEmpty: "Es gibt noch keine abgeschlossenen Läufe.",
    previousPage: "Vorherige Seite",
    nextPage: "Nächste Seite",
    source: "Quelle",
    sourceBot: "BroBot",
    sourceTwitch: "Twitch",
    result: "Ergebnis",
    resultUnknown: "Unbekannt",
    resultCanceled: "Abgebrochen · Punkte zurück",
    statusCompleted: "Abgeschlossen",
    statusTerminated: "Vorzeitig beendet",
    statusArchived: "Archiviert",
    statusActive: "Läuft",
    statusLocked: "Gesperrt",
    resultResolved: (choice) => `Gewonnen: ${choice}`,
    startedAt: "Gestartet",
    refreshFromTwitch: "Von Twitch aktualisieren",
    loading: "Polls und Predictions werden geladen …",
    loadFailed: "Polls und Predictions konnten nicht geladen werden.",
    retry: "Erneut versuchen",
    successSaved: "Eintrag wurde gespeichert.",
    successDeleted: "Eintrag wurde gelöscht.",
    successStarted: "Lauf wurde auf Twitch gestartet.",
    successEnded: "Umfrage wurde beendet.",
    successLocked: "Prediction wurde gesperrt.",
    successResolved: "Prediction wurde aufgelöst.",
    successCanceled: "Prediction wurde abgebrochen. Alle Punkte gehen zurück.",
    successDismissed: "Unbekannter Lauf wurde verworfen.",
    successReconciled: "Mit Twitch abgeglichen.",
    runningPollReason: "Es läuft bereits eine Umfrage.",
    runningPredictionReason: "Es läuft bereits eine Prediction.",
    runningLockReason: "Es gibt eine gesperrte Prediction, die zuerst abgeschlossen werden muss.",
    entryLimit: "Es sind höchstens 200 vorbereitete Einträge möglich.",
    invalidEntry: "Prüfe die markierten Felder und die Twitch-Grenzen.",
    conflict: "Der Eintrag wurde zwischenzeitlich geändert. Aktualisiere die Seite und versuche es erneut.",
    moduleDisabled: "Aktiviere das Polls-Modul, um diese Aktion auszuführen.",
    managementDenied: "Dafür fehlt die Berechtigung für Operatoren.",
    runNotFound: "Der Lauf wurde nicht gefunden oder ist nicht mehr verfügbar.",
    notOpen: "Dieser Lauf ist nicht mehr offen. Die Daten wurden aktualisiert.",
    notDismissible: "Dieser unbekannte Lauf kann nicht mehr verworfen werden.",
    notEligible: "Umfragen und Predictions gibt es nur für Affiliates und Partner.",
    alreadyActive: "Auf Twitch läuft bereits eine Umfrage oder Prediction dieser Art. Der Status wurde abgeglichen.",
    missingConnection: "Die Broadcaster-Verbindung fehlt. Verbinde Twitch erneut.",
    tokenUnavailable: "Der Broadcaster-Zugang ist nicht verfügbar. Verbinde Twitch erneut.",
    missingScope: "Die benötigte Twitch-Berechtigung fehlt. Verbinde den Broadcaster erneut und bestätige die Berechtigung.",
    revoked: "Der Broadcaster-Zugang wurde widerrufen. Verbinde Twitch erneut.",
    refreshFailed: "Der Broadcaster-Zugang konnte nicht erneuert werden. Verbinde Twitch erneut.",
    rateLimited: "Twitch begrenzt gerade Anfragen. Bitte versuche es gleich erneut.",
    network: "Twitch ist gerade nicht erreichbar. Bitte versuche es erneut.",
    requestFailed: "Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
    twitchStatusUnknown: "Twitch hat einen unbekannten Status gemeldet. Aktualisiere den Stand von Twitch und versuche es erneut.",
    twitchInvalidResponse: "Twitch hat eine ungültige Antwort geliefert. Aktualisiere den Stand von Twitch und versuche es erneut.",
    choiceInvalid: "Dieser Ausgang ist nicht mehr verfügbar. Lade die Prediction erneut.",
    serverTitleError: "Twitch hat diesen Titel abgelehnt. Prüfe die Länge und den Inhalt.",
    serverChoiceError: "Twitch hat diese Antwort abgelehnt. Prüfe die Länge und Anzahl der Antworten.",
    serverDurationError: "Die Dauer liegt außerhalb des erlaubten Bereichs.",
    serverCostError: "Gib gültige Kanalpunkte je Stimme ein.",
    localTitleError: "Gib einen Titel innerhalb der Twitch-Längengrenze ein.",
    localChoiceError: "Gib eine Antwort innerhalb der Twitch-Längengrenze ein.",
    localChoicesError: "Wähle die erlaubte Anzahl an Antworten.",
    localDurationError: "Die Dauer muss innerhalb des erlaubten Bereichs liegen.",
    localCostError: "Die Kanalpunkte je Stimme müssen innerhalb des erlaubten Bereichs liegen.",
    characterCount: (count, max) => `${String(count)} / ${String(max)}`,
    unknownError: "Unbekannter Fehler. Bitte versuche es erneut.",
  },
  en: {
    page: "Polls & Predictions",
    runningNow: "Running now",
    poll: "Poll",
    prediction: "Prediction",
    activeStatus: "Running",
    noPoll: "No poll is active",
    noPrediction: "No prediction is active",
    remaining: "Remaining",
    ended: "Ended",
    votes: "Votes",
    users: (count) => count === 1 ? "person" : "people",
    points: "Points",
    end: "End",
    lock: "Lock",
    resolve: "Resolve…",
    cancel: "Cancel…",
    openPredictions: "Open predictions",
    noOpenPredictions: "There are no open predictions.",
    refundDeadline: "Points will be refunded from",
    checkOnTwitch: "Unknown run · check on Twitch",
    dismiss: "Dismiss",
    dismissed: "Run dismissed.",
    preparedEntries: "Prepared entries",
    noEntries: "There are no matching entries.",
    search: "Search entries",
    searchPlaceholder: "Enter a title",
    clearSearch: "Clear search",
    filter: "Entry type",
    allKinds: "All",
    polls: "Polls",
    predictions: "Predictions",
    newEntry: "New",
    createEntry: "New entry",
    editEntry: "Edit entry",
    duplicate: "Duplicate",
    delete: "Delete",
    moreActions: "More actions",
    start: "Start",
    edit: "Edit",
    kind: "Kind",
    title: "Title",
    choices: "Choices",
    choicesLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} choices`,
    choice: (index) => `Choice ${String(index)}`,
    choiceCount: (count) => `${String(count)} choices`,
    duration: "Duration",
    durationLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} seconds`,
    seconds: "seconds",
    channelPointsVoting: "Extra votes with channel points",
    channelPointsCost: "Channel points per vote",
    channelPointsLimit: (minimum, maximum) => `${String(minimum)}–${String(maximum)} points`,
    addChoice: "Add choice",
    removeChoice: "Remove choice",
    moveChoiceUp: "Move choice up",
    moveChoiceDown: "Move choice down",
    save: "Save",
    discard: "Discard",
    saved: "Saved",
    saving: "Saving…",
    discardChangesTitle: "Discard changes?",
    discardChangesDescription: "Unsaved changes will be lost.",
    continueEditing: "Continue editing",
    cancelDialog: "Cancel prediction?",
    cancelDescription: "All channel points wagered will be returned to viewers.",
    confirmCancel: "Cancel prediction",
    resolveDialog: "Resolve prediction",
    loadingFresh: "Loading current outcomes from Twitch…",
    resolveChoice: (choice) => `Pay out “${choice}”`,
    noOutcomes: "Twitch returned no outcomes for this prediction.",
    closeDialog: "Close",
    deleteTitle: "Delete entry?",
    deleteDescription: (title) => `“${title}” will be removed from prepared entries. Saved runs will remain.`,
    confirmDelete: "Delete entry",
    history: "History",
    historyEmpty: "There are no completed runs yet.",
    previousPage: "Previous page",
    nextPage: "Next page",
    source: "Source",
    sourceBot: "BroBot",
    sourceTwitch: "Twitch",
    result: "Result",
    resultUnknown: "Unknown",
    resultCanceled: "Canceled · points returned",
    statusCompleted: "Completed",
    statusTerminated: "Ended early",
    statusArchived: "Archived",
    statusActive: "Running",
    statusLocked: "Locked",
    resultResolved: (choice) => `Winner: ${choice}`,
    startedAt: "Started",
    refreshFromTwitch: "Refresh from Twitch",
    loading: "Loading polls and predictions…",
    loadFailed: "Polls and predictions could not be loaded.",
    retry: "Try again",
    successSaved: "Entry saved.",
    successDeleted: "Entry deleted.",
    successStarted: "Run started on Twitch.",
    successEnded: "Poll ended.",
    successLocked: "Prediction locked.",
    successResolved: "Prediction resolved.",
    successCanceled: "Prediction canceled. All points are being returned.",
    successDismissed: "Unknown run dismissed.",
    successReconciled: "Reconciled with Twitch.",
    runningPollReason: "A poll is already running.",
    runningPredictionReason: "A prediction is already running.",
    runningLockReason: "A locked prediction must be resolved or canceled first.",
    entryLimit: "You can prepare up to 200 entries.",
    invalidEntry: "Check the highlighted fields and Twitch limits.",
    conflict: "This entry changed in the meantime. Refresh the page and try again.",
    moduleDisabled: "Enable the Polls module before using this action.",
    managementDenied: "This action requires operator permission.",
    runNotFound: "The run was not found or is no longer available.",
    notOpen: "This run is no longer open. Its data has been refreshed.",
    notDismissible: "This unknown run can no longer be dismissed.",
    notEligible: "Polls and predictions are available to Affiliates and Partners only.",
    alreadyActive: "A poll or prediction of this kind is already running on Twitch. The state has been refreshed.",
    missingConnection: "The broadcaster connection is missing. Reconnect Twitch.",
    tokenUnavailable: "Broadcaster access is unavailable. Reconnect Twitch.",
    missingScope: "The required Twitch permission is missing. Reconnect the broadcaster and grant the permission.",
    revoked: "Broadcaster access was revoked. Reconnect Twitch.",
    refreshFailed: "Broadcaster access could not be refreshed. Reconnect Twitch.",
    rateLimited: "Twitch is limiting requests right now. Please try again shortly.",
    network: "Twitch is unavailable right now. Please try again.",
    requestFailed: "The action could not be completed. Please try again.",
    twitchStatusUnknown: "Twitch returned an unknown status. Refresh from Twitch and try again.",
    twitchInvalidResponse: "Twitch returned an invalid response. Refresh from Twitch and try again.",
    choiceInvalid: "This outcome is no longer available. Reload the prediction.",
    serverTitleError: "Twitch rejected this title. Check its length and content.",
    serverChoiceError: "Twitch rejected this choice. Check its length and the number of choices.",
    serverDurationError: "The duration is outside the allowed range.",
    serverCostError: "Enter a valid channel-points cost per vote.",
    localTitleError: "Enter a title within Twitch's length limit.",
    localChoiceError: "Enter a choice within Twitch's length limit.",
    localChoicesError: "Use the allowed number of choices.",
    localDurationError: "The duration must be within the allowed range.",
    localCostError: "The channel-points cost per vote must be within the allowed range.",
    characterCount: (count, max) => `${String(count)} / ${String(max)}`,
    unknownError: "Unknown error. Please try again.",
  },
};
