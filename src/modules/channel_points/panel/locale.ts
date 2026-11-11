import type { ModuleLanguage } from "../../contract";

const createTexts = (language: ModuleLanguage) => {
  const de = language === "de";
  return {
    page: de ? "Kanalpunkte" : "Channel points",
    loading: de ? "Kanalpunkte werden geladen …" : "Loading channel points …",
    loadFailed: de ? "Kanalpunkte konnten nicht geladen werden." : "Channel points could not be loaded.",
    retry: de ? "Erneut laden" : "Reload",
    ready: de ? "Twitch verbunden" : "Twitch connected",
    available: de ? "Verfügbar" : "Available",
    unavailable: de ? "Nicht verfügbar" : "Unavailable",
    missingAuthorization: de
      ? "Die Broadcaster-Autorisierung fehlt. Verbinde das Twitch-Konto des Kanals erneut."
      : "Broadcaster authorization is missing. Reconnect the channel’s Twitch account.",
    missingScopes: (scopes: readonly string[]) => de
      ? `Fehlende Twitch-Berechtigung${scopes.length === 1 ? "" : "en"}: ${scopes.join(", ")}. Erteile die Berechtigungen für Kanalpunkte erneut.`
      : `Missing Twitch permission${scopes.length === 1 ? "" : "s"}: ${scopes.join(", ")}. Grant the channel-points permissions again.`,
    notAffiliate: de
      ? "Kanalpunkte sind nur für Twitch-Affiliates und -Partner verfügbar."
      : "Channel points require a Twitch Affiliate or Partner account.",
    rewards: de ? "Belohnungen" : "Rewards",
    newReward: de ? "Neu" : "New",
    refreshFromTwitch: de ? "Von Twitch aktualisieren" : "Refresh from Twitch",
    refreshing: de ? "Wird aktualisiert …" : "Refreshing …",
    rewardsEmpty: de ? "Noch keine Kanalpunkte-Belohnungen." : "No channel-points rewards yet.",
    statusActive: de ? "Auf Twitch aktiv" : "Active on Twitch",
    statusDisabledByModule: de ? "Durch Modul deaktiviert" : "Disabled by module",
    statusDisabled: de ? "Auf Twitch pausiert" : "Paused on Twitch",
    statusDeleted: de ? "Auf Twitch gelöscht" : "Deleted on Twitch",
    statusCreating: de ? "Wird erstellt" : "Creating",
    actionUnavailable: de ? "Aktion nicht verfügbar" : "Action unavailable",
    modeAutomatic: de ? "Automatisch" : "Automatic",
    modeQueue: de ? "Warteschlange" : "Queue",
    modeAutomaticDescription: de
      ? "Die Aktion läuft direkt; ein klarer Fehler erstattet die Punkte."
      : "The action runs immediately; a clear failure refunds the points.",
    modeQueueDescription: de
      ? "Einlösung erst später im Cockpit ausführen oder erstatten."
      : "Run or refund the redemption later from the cockpit.",
    active: de ? "Aktiv" : "Active",
    activeReward: (title: string) => de ? `${title} aktiv` : `${title} active`,
    moreActions: (title: string) => de ? `Weitere Aktionen für ${title}` : `More actions for ${title}`,
    edit: de ? "Bearbeiten" : "Edit",
    delete: de ? "Löschen" : "Delete",
    recreateShort: de ? "Neu anlegen" : "Recreate",
    recreateReward: (title: string) => de ? `${title} auf Twitch neu anlegen` : `Recreate ${title} on Twitch`,
    deleteTitle: (title: string) => de ? `Belohnung „${title}“ löschen?` : `Delete “${title}”?`,
    deleteDescription: (title: string) => de
      ? `Die Belohnung „${title}“ wird auch auf Twitch gelöscht.`
      : `The “${title}” reward will also be deleted on Twitch.`,
    confirmDelete: (title: string) => de ? `„${title}“ löschen` : `Delete “${title}”`,
    cancel: de ? "Abbrechen" : "Cancel",
    deleteSuccess: de ? "Belohnung gelöscht." : "Reward deleted.",
    rewardSaved: de ? "Belohnung gespeichert." : "Reward saved.",
    rewardRecreated: de ? "Belohnung auf Twitch neu angelegt." : "Reward recreated on Twitch.",
    rewardLimit: de
      ? "Twitch erlaubt höchstens 50 eigene Belohnungen pro Kanal."
      : "Twitch allows up to 50 custom rewards per channel.",
    duplicateTitle: de ? "Dieser Titel wird bereits verwendet." : "This title is already in use.",
    invalidReward: de ? "Prüfe die Belohnungsfelder und versuche es erneut." : "Check the reward fields and try again.",
    invalidActionConfig: de ? "Prüfe die Einstellungen dieser Aktion." : "Check this action’s settings.",
    actionNeedsInput: de
      ? "Diese Aktion benötigt eine Zuschauereingabe."
      : "This action requires viewer input.",
    actionUnknown: de ? "Diese Aktion ist nicht mehr verfügbar." : "This action is no longer available.",
    actionProviderDisabled: de ? "Das Modul für diese Aktion ist ausgeschaltet." : "The module providing this action is off.",
    actionProvidersUnavailable: de
      ? "Der Status verfügbarer Module konnte nicht gelesen werden. Lade die Seite erneut."
      : "Available module status could not be read. Reload the page.",
    noActionSettings: de ? "Diese Aktion benötigt keine Einstellungen." : "This action needs no settings.",
    managementDenied: de ? "Nur Broadcaster und Verwalter können Belohnungen ändern." : "Only broadcasters and managers can change rewards.",
    operationDenied: de ? "Du hast keine Berechtigung zum Aktualisieren von Twitch." : "You do not have permission to reconcile Twitch.",
    requestFailed: de ? "Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut." : "The request failed. Please try again.",
    reconcileFailed: de ? "Twitch konnte nicht vollständig aktualisiert werden." : "Twitch could not be fully reconciled.",
    reconcileSuccess: de ? "Mit Twitch abgeglichen." : "Reconciled with Twitch.",
    createTitle: de ? "Neue Belohnung" : "New reward",
    editTitle: de ? "Belohnung bearbeiten" : "Edit reward",
    title: de ? "Titel" : "Title",
    prompt: de ? "Hinweis" : "Prompt",
    cost: de ? "Kosten" : "Cost",
    points: de ? "Punkte" : "Points",
    backgroundColor: de ? "Hintergrundfarbe" : "Background color",
    unsetColor: de ? "Keine eigene Farbe" : "No custom color",
    clearColor: de ? "Farbe entfernen" : "Clear color",
    userInput: de ? "Zuschauereingabe erforderlich" : "Viewer input required",
    maxPerStream: de ? "Maximal pro Stream" : "Maximum per stream",
    maxPerUserPerStream: de ? "Maximal pro Person und Stream" : "Maximum per person per stream",
    cooldown: de ? "Cooldown pro Belohnung" : "Reward cooldown",
    seconds: "s",
    perStreamUnit: de ? "× pro Stream" : "× per stream",
    perPersonUnit: de ? "× pro Person" : "× per person",
    action: de ? "Aktion" : "Action",
    mode: de ? "Ablauf" : "Mode",
    inputLockReason: de
      ? "Diese Aktion benötigt eine Zuschauereingabe."
      : "This action requires viewer input.",
    inputRequiredError: de
      ? "Aktiviere die Zuschauereingabe für diese Aktion."
      : "Enable viewer input for this action.",
    required: de ? "Dieses Feld ist erforderlich." : "This field is required.",
    titleLimit: de ? "Der Titel darf höchstens 45 Zeichen haben." : "The title must be 45 characters or fewer.",
    promptLimit: de ? "Der Hinweis darf höchstens 200 Zeichen haben." : "The prompt must be 200 characters or fewer.",
    costInvalid: de ? "Die Kosten müssen mindestens 1 Punkt betragen." : "Cost must be at least 1 point.",
    limitInvalid: de ? "Gib einen gültigen Grenzwert ein." : "Enter a valid limit.",
    save: de ? "Speichern" : "Save",
    discard: de ? "Verwerfen" : "Discard",
    saved: de ? "Gespeichert" : "Saved",
    saving: de ? "Wird gespeichert …" : "Saving …",
    unsaved: de ? "Ungespeicherte Änderungen" : "Unsaved changes",
    discardChangesTitle: de ? "Änderungen verwerfen?" : "Discard changes?",
    discardChangesDescription: de ? "Deine Änderungen gehen verloren." : "Your changes will be lost.",
    continueEditing: de ? "Weiter bearbeiten" : "Continue editing",
    history: de ? "Verlauf" : "History",
    historyEmpty: de ? "Noch keine Einlösungen." : "No redemptions yet.",
    previousPage: de ? "Vorherige Seite" : "Previous page",
    nextPage: de ? "Nächste Seite" : "Next page",
    pageCount: (page: number) => de ? `Seite ${String(page)}` : `Page ${String(page)}`,
    redeemedAt: de ? "Zeitpunkt" : "Time",
    viewer: de ? "Zuschauer" : "Viewer",
    redemptionInput: de ? "Eingabe" : "Input",
    outcomeFulfilled: de ? "Erledigt" : "Fulfilled",
    outcomeRefunded: (reason: string) => de ? `Erstattet · ${reason}` : `Refunded · ${reason}`,
    outcomeOpen: de ? "Offen" : "Open",
    outcomeOrphaned: (reason: string) => de ? `Verwaist · ${reason}` : `Orphaned · ${reason}`,
    outcomeFailed: de ? "Aktualisierung fehlgeschlagen" : "Update failed",
    counter: (count: number, maximum: number) => `${String(count)} / ${String(maximum)}`,
    chatMessage: de ? "Chat-Nachricht" : "Chat message",
    insertPlaceholder: (name: string) => de ? `Platzhalter ${name} einfügen` : `Insert ${name} placeholder`,
    placeholders: de ? "Platzhalter einfügen" : "Insert placeholders",
    previous: de ? "Zurück" : "Previous",
    next: de ? "Weiter" : "Next",
  };
};

export const channelPointsPanelTexts = {
  de: createTexts("de"),
  en: createTexts("en"),
} as const;
