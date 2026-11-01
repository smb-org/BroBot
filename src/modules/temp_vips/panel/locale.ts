import type { ModuleLanguage } from "../../contract";

export const tempVipsPanelTexts: Readonly<Record<ModuleLanguage, {
  grant: string;
  takeOver: string;
  loading: string;
  loadError: string;
  retry: string;
  empty: string;
  listTitle: string;
  name: string;
  expires: string;
  grantedBy: string;
  source: string;
  sourceLabels: Readonly<Record<"command" | "dashboard" | "import" | "channel_points", string>>;
  extend: string;
  endNow: string;
  release: string;
  releaseHint: string;
  retryRemoval: string;
  removalWarning: string;
  removalReasons: Readonly<Record<string, string>>;
  removalReasonUnknown: string;
  tabsLabel: string;
  tabVips: string;
  tabSettings: string;
  duration: string;
  days: string;
  durationHint: string;
  loginHint: string;
  targetSearch: string;
  targetEmpty: string;
  chooseTarget: string;
  remainingDuration: string;
  remainingTime: string;
  expiryDate: string;
  expiryDateHint: (timeZone: string) => string;
  selectedTarget: string;
  grantTitle: string;
  takeOverTitle: string;
  extendTitle: (name: string) => string;
  endTitle: (name: string) => string;
  endDescription: string;
  releaseSuccess: string;
  endSuccess: string;
  retrySuccess: string;
  operationPending: string;
  maximumExceeded: string;
  userNotFound: string;
  twitchUnavailable: string;
  operationFailed: string;
  ambiguousFailure: string;
  invalidDuration: string;
  durationRequired: string;
  expiryRequired: string;
  confirmation: string;
  cancel: string;
  save: string;
  clearSearch: string;
}>> = {
  de: {
    grant: "VIP vergeben",
    takeOver: "Vorhandenes VIP übernehmen",
    loading: "Temporäre VIPs werden geladen …",
    loadError: "Die VIP-Liste konnte nicht geladen werden.",
    retry: "Erneut versuchen",
    empty: "Es gibt noch keine temporären VIPs.",
    listTitle: "VIP-Liste",
    name: "Name",
    expires: "Läuft ab",
    grantedBy: "Vergeben von",
    source: "Quelle",
    sourceLabels: { command: "Chatbefehl", dashboard: "Dashboard", import: "Übernommen", channel_points: "Kanalpunkte" },
    extend: "Verlängern",
    endNow: "Jetzt beenden",
    release: "Verwaltung abgeben · VIP behalten",
    releaseHint: "Der Eintrag wird entfernt. Das VIP bleibt bestehen.",
    retryRemoval: "Entzug erneut versuchen",
    removalWarning: "Der VIP-Entzug ist fehlgeschlagen.",
    removalReasons: {
      network: "Netzwerkfehler",
      unknown_status: "Twitch hat die Anfrage abgelehnt",
      rate_limited: "Zu viele Anfragen",
      invalid_response: "Ungültige Antwort von Twitch",
      not_connected: "Broadcaster-Verbindung fehlt",
      token_unavailable: "Broadcaster-Zugang nicht verfügbar",
      scope_missing: "Berechtigung des Broadcasters fehlt",
      revoked: "Broadcaster-Zugang wurde widerrufen",
      refresh_failed: "Broadcaster-Zugang konnte nicht erneuert werden",
      precondition_failed: "Voraussetzung nicht erfüllt",
      no_slots: "Keine VIP-Plätze frei",
      moderator: "Konto ist Moderator",
      community_gate: "Twitch lässt das aktuell nicht zu",
    },
    removalReasonUnknown: "Unbekannter Fehler",
    tabsLabel: "Bereich",
    tabVips: "VIPs",
    tabSettings: "Einstellungen",
    duration: "Dauer",
    days: "Tage",
    durationHint: "Die Höchstdauer begrenzt die gesamte verbleibende VIP-Zeit.",
    loginHint: "Gib den Twitch-Benutzernamen ein.",
    targetSearch: "VIPs filtern",
    targetEmpty: "Keine passenden VIPs gefunden.",
    chooseTarget: "VIP auswählen",
    remainingDuration: "Restzeit als Dauer",
    remainingTime: "Restzeit",
    expiryDate: "Ablaufzeit festlegen",
    expiryDateHint: (zone) => `Datum und Uhrzeit in der Kanalzeitzone ${zone}.`,
    selectedTarget: "Ausgewähltes VIP",
    grantTitle: "VIP vergeben",
    takeOverTitle: "Vorhandenes VIP übernehmen",
    extendTitle: (name) => `VIP für ${name} verlängern`,
    endTitle: (name) => `VIP für ${name} jetzt beenden?`,
    endDescription: "Das VIP wird auf Twitch entzogen und der Eintrag aus der Liste entfernt.",
    releaseSuccess: "VIP-Verwaltung abgegeben. Das VIP bleibt bestehen.",
    endSuccess: "VIP wurde beendet.",
    retrySuccess: "VIP-Entzug wurde erneut eingereiht.",
    operationPending: "Die Aktion wartet in der Kanalwarteschlange.",
    maximumExceeded: "Die gewünschte Dauer überschreitet die Höchstdauer. Wähle eine kürzere Dauer.",
    userNotFound: "Twitch-Konto nicht gefunden.",
    twitchUnavailable: "Twitch ist derzeit nicht erreichbar.",
    operationFailed: "Die Aktion konnte nicht abgeschlossen werden.",
    ambiguousFailure: "Das Ergebnis ist unklar. Wiederhole dieselbe Eingabe, damit kein doppelter Auftrag entsteht.",
    invalidDuration: "Gib eine gültige Dauer von mindestens 10 Minuten ein.",
    durationRequired: "Wähle eine gültige Dauer.",
    expiryRequired: "Gib ein gültiges Datum und eine Uhrzeit ein.",
    confirmation: "Bestätigen",
    cancel: "Abbrechen",
    save: "Übernehmen",
    clearSearch: "Suche leeren",
  },
  en: {
    grant: "Grant VIP",
    takeOver: "Take over existing VIP",
    loading: "Loading temporary VIPs …",
    loadError: "The VIP list could not be loaded.",
    retry: "Try again",
    empty: "There are no temporary VIPs yet.",
    listTitle: "VIP list",
    name: "Name",
    expires: "Expires",
    grantedBy: "Granted by",
    source: "Source",
    sourceLabels: { command: "Chat command", dashboard: "Dashboard", import: "Taken over", channel_points: "Channel points" },
    extend: "Extend",
    endNow: "End now",
    release: "Release management · keep VIP",
    releaseHint: "The entry is removed. The VIP stays in place.",
    retryRemoval: "Retry removal",
    removalWarning: "The VIP removal failed.",
    removalReasons: {
      network: "Network error",
      unknown_status: "Twitch rejected the request",
      rate_limited: "Too many requests",
      invalid_response: "Invalid response from Twitch",
      not_connected: "Broadcaster connection missing",
      token_unavailable: "Broadcaster access unavailable",
      scope_missing: "Broadcaster permission missing",
      revoked: "Broadcaster access was revoked",
      refresh_failed: "Broadcaster access could not be renewed",
      precondition_failed: "Precondition not met",
      no_slots: "No VIP slots free",
      moderator: "Account is a moderator",
      community_gate: "Twitch does not allow this right now",
    },
    removalReasonUnknown: "Unknown error",
    tabsLabel: "Section",
    tabVips: "VIPs",
    tabSettings: "Settings",
    duration: "Duration",
    days: "days",
    durationHint: "The maximum limits the total remaining VIP time.",
    loginHint: "Enter the Twitch login.",
    targetSearch: "Filter VIPs",
    targetEmpty: "No matching VIPs found.",
    chooseTarget: "Choose VIP",
    remainingDuration: "Set remaining time as a duration",
    remainingTime: "Remaining time",
    expiryDate: "Set an expiry date and time",
    expiryDateHint: (zone) => `Date and time in the channel time zone ${zone}.`,
    selectedTarget: "Selected VIP",
    grantTitle: "Grant VIP",
    takeOverTitle: "Take over existing VIP",
    extendTitle: (name) => `Extend VIP for ${name}`,
    endTitle: (name) => `End VIP for ${name} now?`,
    endDescription: "The VIP will be removed on Twitch and its entry will be deleted from this list.",
    releaseSuccess: "VIP management released. The VIP stays in place.",
    endSuccess: "VIP ended.",
    retrySuccess: "VIP removal was queued for another attempt.",
    operationPending: "The action is waiting in the channel queue.",
    maximumExceeded: "The requested duration exceeds the maximum. Choose a shorter duration.",
    userNotFound: "Twitch account not found.",
    twitchUnavailable: "Twitch is unavailable right now.",
    operationFailed: "The action could not be completed.",
    ambiguousFailure: "The result is uncertain. Retry the same input so the operation is not duplicated.",
    invalidDuration: "Enter a valid duration of at least 10 minutes.",
    durationRequired: "Choose a valid duration.",
    expiryRequired: "Enter a valid date and time.",
    confirmation: "Confirm",
    cancel: "Cancel",
    save: "Apply",
    clearSearch: "Clear search",
  },
};
