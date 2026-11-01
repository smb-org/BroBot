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
  grantSuccess: string;
  importSuccess: string;
  extendSuccess: string;
  endSuccess: string;
  retrySuccess: string;
  operationPending: string;
  notVip: string;
  maximumExceeded: string;
  alreadyVip: string;
  notManaged: string;
  userNotFound: string;
  twitchUnavailable: string;
  operationFailed: string;
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
    grantSuccess: "VIP wurde vergeben.",
    importSuccess: "Vorhandenes VIP wurde übernommen.",
    extendSuccess: "VIP-Zeit wurde verlängert.",
    endSuccess: "VIP wurde beendet.",
    retrySuccess: "VIP-Entzug wurde erneut eingereiht.",
    operationPending: "Die Aktion wartet in der Kanalwarteschlange.",
    notVip: "Dieses Konto ist nicht mehr VIP. Es wurde nicht übernommen.",
    maximumExceeded: "Die gewünschte Dauer überschreitet die Höchstdauer.",
    alreadyVip: "Dieses Konto hat bereits ein VIP oder einen laufenden Eintrag.",
    notManaged: "Für dieses Konto gibt es keinen verwalteten VIP-Eintrag.",
    userNotFound: "Twitch-Konto nicht gefunden.",
    twitchUnavailable: "Twitch ist derzeit nicht erreichbar.",
    operationFailed: "Die Aktion konnte nicht abgeschlossen werden.",
    invalidDuration: "Gib eine gültige Dauer ein.",
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
    grantSuccess: "VIP granted.",
    importSuccess: "Existing VIP taken over.",
    extendSuccess: "VIP time extended.",
    endSuccess: "VIP ended.",
    retrySuccess: "VIP removal was queued for another attempt.",
    operationPending: "The action is waiting in the channel queue.",
    notVip: "This account is no longer a VIP. It was not taken over.",
    maximumExceeded: "The requested duration exceeds the maximum.",
    alreadyVip: "This account already has a VIP or an active entry.",
    notManaged: "There is no managed VIP entry for this account.",
    userNotFound: "Twitch account not found.",
    twitchUnavailable: "Twitch is unavailable right now.",
    operationFailed: "The action could not be completed.",
    invalidDuration: "Enter a valid duration.",
    durationRequired: "Choose a valid duration.",
    expiryRequired: "Enter a valid date and time.",
    confirmation: "Confirm",
    cancel: "Cancel",
    save: "Apply",
    clearSearch: "Clear search",
  },
};
