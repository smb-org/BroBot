import type { ModuleLanguage } from "../../contract";
import type { BelaboxFetchFailureReason, BelaboxStatsUrlError } from "../contracts";

export interface BelaboxPanelTexts {
  title: string;
  connection: string;
  notConfigured: string;
  loading: string;
  awaitingSample: string;
  updatedAt: string;
  latestSample: string;
  pollingInactive: string;
  retryPolling: string;
  retryPollingFailed: string;
  connected: string;
  disconnected: string;
  stale: string;
  bitrate: string;
  history: string;
  liveRange: string;
  streamRange: string;
  onDemandHistory: string;
  noHistory: string;
  streams: string;
  noStreams: string;
  lowThreshold: string;
  recoverThreshold: string;
  streamStarted: string;
  averageBitrate: string;
  p10Bitrate: string;
  disconnects: string;
  droppedPackets: string;
  statsUrl: string;
  statsUrlHint: string;
  statsUrlConfigured: string;
  statsUrlNotConfigured: string;
  removed: string;
  removeFailed: string;
  refreshFailed: string;
  remove: string;
  removeTitle: string;
  removeConsequence: string;
  confirmRemove: string;
  cancel: string;
  testConnection: string;
  testFailed: string;
  testNotConfigured: string;
  invalidUrl: string;
  invalidScheme: string;
  invalidPort: string;
  invalidHost: string;
  credentialsNotAllowed: string;
  queryNotAllowed: string;
  fragmentNotAllowed: string;
  invalidPath: string;
  timeout: string;
  network: string;
  http4xx: string;
  http5xx: string;
  redirectRejected: string;
  tooLarge: string;
  malformed: string;
  budgetExhausted: string;
  readOnly: string;
  alertLow: string;
  alertDisconnect: string;
  alertRecovering: string;
  alertPending: string;
  fetchFailureNotice: string;
  checkNow: string;
  statusUnavailable: string;
  connectionActions: string;
}

const texts: Readonly<Record<ModuleLanguage, BelaboxPanelTexts>> = {
  de: {
    title: "BELABOX-Verbindung",
    connection: "Verbindung",
    notConfigured: "Keine Statistik-URL hinterlegt",
    loading: "Wird geladen",
    awaitingSample: "Warte auf erste Messung",
    updatedAt: "Geändert am",
    latestSample: "Letzte Messung",
    pollingInactive: "Abfrage nicht aktiv – erneut versuchen",
    retryPolling: "Erneut versuchen",
    retryPollingFailed: "Der Abruf konnte nicht erneut gestartet werden.",
    connected: "Verbunden",
    disconnected: "Getrennt",
    stale: "Veraltet",
    bitrate: "Bitrate",
    history: "Bitrate-Verlauf",
    liveRange: "Live · 10 Min.",
    streamRange: "Stream",
    onDemandHistory: "Im Modus „Bei Bedarf“ wird kein Verlauf gespeichert. Die aktuelle Messung steht oben.",
    noHistory: "Für diesen Zeitraum liegen noch keine Messwerte vor.",
    streams: "Streams",
    noStreams: "Noch keine BELABOX-Streams aufgezeichnet.",
    lowThreshold: "Niedrige Schwelle",
    recoverThreshold: "Erholungsschwelle",
    streamStarted: "Gestartet",
    averageBitrate: "Mittel",
    p10Bitrate: "P10",
    disconnects: "Trennungen",
    droppedPackets: "Verlorene Pakete",
    statsUrl: "Statistik-URL",
    statsUrlHint: "Leer lassen, um die hinterlegte URL beizubehalten.",
    statsUrlConfigured: "Hinterlegt",
    statsUrlNotConfigured: "Nicht hinterlegt",
    removed: "Die Statistik-URL wurde entfernt.",
    removeFailed: "Die Statistik-URL konnte nicht entfernt werden.",
    refreshFailed: "Der Status konnte nicht aktualisiert werden.",
    remove: "Statistik-URL entfernen",
    removeTitle: "Statistik-URL entfernen?",
    removeConsequence: "Die gespeicherte Verbindung liefert danach keine Statistiken mehr.",
    confirmRemove: "Statistik-URL entfernen",
    cancel: "Abbrechen",
    testConnection: "Verbindung testen",
    testFailed: "Die Verbindung konnte nicht getestet werden.",
    testNotConfigured: "Hinterlege zuerst eine Statistik-URL.",
    invalidUrl: "Die URL ist ungültig.",
    invalidScheme: "Nur HTTP oder HTTPS ist erlaubt.",
    invalidPort: "Der Port ist nicht erlaubt.",
    invalidHost: "Der Host ist nicht erlaubt.",
    credentialsNotAllowed: "Anmeldedaten in der URL sind nicht erlaubt.",
    queryNotAllowed: "URL-Abfragen sind nicht erlaubt.",
    fragmentNotAllowed: "URL-Fragmente sind nicht erlaubt.",
    invalidPath: "Der URL-Pfad ist ungültig.",
    timeout: "Der Relay-Dienst hat nicht rechtzeitig geantwortet.",
    network: "Der Relay-Dienst ist nicht erreichbar.",
    http4xx: "Der Relay-Dienst hat die Anfrage abgelehnt.",
    http5xx: "Der Relay-Dienst meldet einen Fehler.",
    redirectRejected: "Weiterleitungen werden nicht unterstützt.",
    tooLarge: "Die Antwort des Relay-Dienstes ist zu groß.",
    malformed: "Die Antwort des Relay-Dienstes ist ungültig.",
    budgetExhausted: "Das Abruflimit wurde erreicht. Bitte später erneut versuchen.",
    readOnly: "Nur Broadcaster und Verwalter können diese Verbindung ändern.",
    alertLow: "Niedrige BELABOX-Bitrate",
    alertDisconnect: "BELABOX-Encoder getrennt",
    alertRecovering: "BELABOX-Verbindung erholt sich",
    alertPending: "BELABOX-Alarm wird geprüft",
    fetchFailureNotice: "BELABOX-Status konnte dreimal nicht abgerufen werden.",
    checkNow: "Jetzt prüfen",
    statusUnavailable: "BELABOX-Status noch nicht verfügbar.",
    connectionActions: "Weitere Verbindungsaktionen",
  },
  en: {
    title: "BELABOX connection",
    connection: "Connection",
    notConfigured: "No stats URL stored",
    loading: "Loading",
    awaitingSample: "Waiting for first sample",
    updatedAt: "Changed",
    latestSample: "Latest sample",
    pollingInactive: "Polling inactive – try again",
    retryPolling: "Try again",
    retryPollingFailed: "Polling could not be restarted.",
    connected: "Connected",
    disconnected: "Disconnected",
    stale: "Stale",
    bitrate: "Bitrate",
    history: "Bitrate history",
    liveRange: "Live · 10 min",
    streamRange: "Stream",
    onDemandHistory: "On-demand mode does not store history. The current sample is shown above.",
    noHistory: "No measurements are available for this range yet.",
    streams: "Streams",
    noStreams: "No BELABOX streams recorded yet.",
    lowThreshold: "Low threshold",
    recoverThreshold: "Recovery threshold",
    streamStarted: "Started",
    averageBitrate: "Average",
    p10Bitrate: "P10",
    disconnects: "Disconnects",
    droppedPackets: "Dropped packets",
    statsUrl: "Stats URL",
    statsUrlHint: "Leave blank to keep the stored URL.",
    statsUrlConfigured: "Stored",
    statsUrlNotConfigured: "Not stored",
    removed: "The stats URL was removed.",
    removeFailed: "The stats URL could not be removed.",
    refreshFailed: "The status could not be refreshed.",
    remove: "Remove stats URL",
    removeTitle: "Remove stats URL?",
    removeConsequence: "The saved connection will stop providing statistics.",
    confirmRemove: "Remove stats URL",
    cancel: "Cancel",
    testConnection: "Test connection",
    testFailed: "The connection could not be tested.",
    testNotConfigured: "Enter a stats URL first.",
    invalidUrl: "The URL is invalid.",
    invalidScheme: "Only HTTP or HTTPS is allowed.",
    invalidPort: "The port is not allowed.",
    invalidHost: "The host is not allowed.",
    credentialsNotAllowed: "URL credentials are not allowed.",
    queryNotAllowed: "URL queries are not allowed.",
    fragmentNotAllowed: "URL fragments are not allowed.",
    invalidPath: "The URL path is invalid.",
    timeout: "The relay did not respond in time.",
    network: "The relay could not be reached.",
    http4xx: "The relay rejected the request.",
    http5xx: "The relay reported an error.",
    redirectRejected: "Redirects are not supported.",
    tooLarge: "The relay response is too large.",
    malformed: "The relay response is invalid.",
    budgetExhausted: "The fetch limit was reached. Try again later.",
    readOnly: "Only broadcasters and managers can change this connection.",
    alertLow: "BELABOX bitrate is low",
    alertDisconnect: "BELABOX encoder disconnected",
    alertRecovering: "BELABOX connection is recovering",
    alertPending: "BELABOX alert is pending",
    fetchFailureNotice: "BELABOX status could not be fetched three times.",
    checkNow: "Check now",
    statusUnavailable: "BELABOX status is not available yet.",
    connectionActions: "More connection actions",
  },
};

export const belaboxPanelTexts = (language: ModuleLanguage): BelaboxPanelTexts => texts[language];

export const belaboxReasonText = (
  labels: BelaboxPanelTexts,
  reason: BelaboxFetchFailureReason | BelaboxStatsUrlError | "not_configured",
): string => {
  const mapped: Readonly<Record<BelaboxFetchFailureReason | BelaboxStatsUrlError | "not_configured", string>> = {
    timeout: labels.timeout,
    network: labels.network,
    http_4xx: labels.http4xx,
    http_5xx: labels.http5xx,
    redirect_rejected: labels.redirectRejected,
    too_large: labels.tooLarge,
    malformed: labels.malformed,
    budget_exhausted: labels.budgetExhausted,
    invalid_url: labels.invalidUrl,
    invalid_scheme: labels.invalidScheme,
    invalid_port: labels.invalidPort,
    invalid_host: labels.invalidHost,
    credentials_not_allowed: labels.credentialsNotAllowed,
    query_not_allowed: labels.queryNotAllowed,
    fragment_not_allowed: labels.fragmentNotAllowed,
    invalid_path: labels.invalidPath,
    not_configured: labels.testNotConfigured,
  };
  return mapped[reason];
};
