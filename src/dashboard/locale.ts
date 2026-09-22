import type { ApiErrorCode, ChannelRole, EventCode, EventTone } from "../contracts/values";
import { browserModuleLanguage, type ModuleLanguage } from "../modules/contract";

export type DashboardLanguage = ModuleLanguage;
export type LocaleCatalog<T> = Record<DashboardLanguage, T>;

export interface DashboardCommonTexts {
  cancel: string;
  close: string;
  save: string;
  roles: Record<ChannelRole, string>;
}

const commonTexts: LocaleCatalog<DashboardCommonTexts> = {
  de: {
    cancel: "Abbrechen",
    close: "Schließen",
    save: "Speichern",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Verwalter",
      operator: "Bediener",
    },
  },
  en: {
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    roles: {
      broadcaster: "Broadcaster",
      manager: "Manager",
      operator: "Operator",
    },
  },
};

/**
 * The panel's language, derived from the browser (decision 0007).
 * This is the only place that determines it — a later, deliberate
 * per-user language choice only replaces this function.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const dashboardCommonTexts = (): DashboardCommonTexts => commonTexts[dashboardLanguage()];

export interface DashboardTexts {
  header: {
    connectionRunning: string;
    connectionWaiting: string;
    connectionInterrupted: string;
    channelIdentity: string;
    noConnection: string;
    switchOn: string;
    switchOff: string;
  };
  status: {
    connected: string;
    revoked: string;
    error: string;
    loginIdentityMissing: string;
    notChecked: string;
    expired: string;
    maintenanceOverdue: string;
    renewalOverdue: string;
    valid: string;
    moderatorRoleMissing: string;
    chatSubscriptionError: string;
    chatSubscriptionRevoked: string;
    botError: string;
    botTokenRevoked: string;
    broadcasterConsentMissing: string;
    chatSubscriptionMissing: string;
    healthy: string;
    stateIncomplete: string;
    notConnected: string;
    notSetUp: string;
    moderator: string;
    missing: string;
    active: string;
    pending: string;
    notRequired: string;
    present: string;
    botPermissionsMissing: (count: string) => string;
  };
  navigation: {
    mainNavigation: string;
    overview: string;
    channel: string;
    system: string;
    members: string;
    module: string;
    events: string;
    selectChannel: string;
    selectModule: string;
    signInWithTwitch: string;
    twitchAccount: string;
    signingOut: string;
    signOut: string;
    /** Sidebar section heading; the "what you open during an incident" group. */
    operationSection: string;
    collapseSidebar: string;
    expandSidebar: string;
    openSidebar: string;
    closeSidebar: string;
  };
  overview: {
    oneChannelAvailable: string;
    channelsAvailable: (count: string) => string;
    channelsAvailableShort: (count: string) => string;
    noChannelAvailable: string;
    noMembership: string;
    activeModules: string;
    loadState: string;
  };
  moderation: {
    noCheckForChannel: string;
    lastCheck: (timestamp: string) => string;
    checkRunning: string;
    checkModeratorStatus: string;
    nextCheckFrom: (timestamp: string) => string;
    checkLocked: string;
    broadcasterReauthorize: string;
    requestBroadcasterConsent: string;
  };
  bot: {
    noSavedStatus: string;
    lastUpdated: (timestamp: string) => string;
    optionalModules: string;
    normalOperation: string;
    channelBotRequired: string;
    botPermissionsOperator: string;
    botPermissionsComplete: string;
  };
  errors: {
    title: string;
    warning: string;
    sessionInvalid: string;
    dataLoadFailed: string;
    changeFailed: string;
    last: string;
    noCause: string;
  };
  statusCard: {
    yourRole: string;
    broadcasterOauth: string;
    chatConsent: string;
    botAccount: string;
    botPermissions: string;
    moderatorStatus: string;
    chatSubscription: string;
    tokenStatus: string;
    broadcasterConsentMissing: string;
    broadcastExplanation: string;
    noBotStatus: string;
    chatBotRequired: string;
  };
  time: {
    updated: (relativeTime: string) => string;
    secondsAgo: (count: number) => string;
    minutesAgo: (count: number) => string;
    hoursAgo: (count: number) => string;
  };
  system: {
    title: string;
    readOnly: string;
    loadState: string;
    properties: string;
    botReason: string;
    botUpdated: string;
    chatSubscriptionId: string;
    chatSubscriptionReason: string;
    chatSubscriptionUpdated: string;
    loginStatus: string;
    loginReason: string;
    loginValidUntil: string;
    botValidUntil: string;
    auditLog: string;
    entries: string;
    time: string;
    action: string;
    who: string;
    loadAudit: string;
    noAuditEntries: string;
    changeData: string;
    before: string;
    after: string;
    olderEntries: string;
    loadingOlderEntries: string;
    subscriptions: string;
    noSubscriptions: string;
    subscription: string;
    state: string;
    reason: string;
    subscriptionDetails: string;
    subscriptionRawType: string;
    subscriptionVersion: string;
    subscriptionId: string;
    subscriptionUpdated: string;
    twitchMessage: string;
    httpStatus: string;
    missingBotPermissions: string;
    missingScopes: string;
  };
  events: {
    title: string;
    count: (count: string) => string;
    log: string;
    time: string;
    event: string;
    module: string;
    who: string;
    automatic: string;
    info: string;
    error: string;
    notice: string;
    unknown: string;
    code: string;
    timestamp: string;
    operation: string;
    participants: string;
    history: string;
    load: string;
    none: string;
    detail: string;
    loadOlder: string;
    loadingOlder: string;
    filter: string;
    origin: string;
    moduleFilter: string;
    tone: string;
    person: string;
    all: string;
    channelEvents: string;
    moduleDiagnostics: string;
    activeFilters: string;
    resetFilters: string;
    noMatches: string;
    loadMoreAtEnd: string;
    feedEnd: string;
    realtimeConnecting: string;
    realtimeConnected: string;
    realtimeReconnecting: string;
    realtimeOffline: string;
    realtimeRenewSession: string;
    realtimeNew: (count: string) => string;
    connectionLost: string;
    retry: string;
    technicalDetails: string;
    copyId: string;
    copied: string;
    trigger: string;
    moderator: string;
    affectedPerson: string;
  };
  signIn: {
    required: string;
    explanation: string;
    signInWithTwitch: string;
    checkChannelAccess: string;
    loadMembers: string;
  };
  module: {
    module: string;
    available: string;
    load: string;
    registered: string;
    active: string;
    inactive: string;
    enable: string;
    disable: string;
    moduleList: string;
    moduleOverview: string;
    managementLocked: string;
    noneActive: string;
    noView: string;
    views: string;
    loadingViews: string;
    notActive: (name: string) => string;
    unknown: (name: string) => string;
    scopesMissing: (name: string) => string;
    requestScopeConsent: string;
    scopeConsentLocked: string;
    scopeList: string;
    scopeMissing: string;
    scopeGranted: string;
  };
  /** Stream Manager: the immediate-action row and the warnings/errors feed
   *  on the channel overview -- each action reports success/failure at
   *  itself, never a global toast (see docs/input/umbau-plan.md Epic 4). */
  streamManager: {
    immediateActions: string;
    adLength: string;
    runAd: (length: string) => string;
    adStarted: (length: string) => string;
    adCooldown: (seconds: string) => string;
    shoutoutLogin: string;
    sendShoutout: string;
    shoutoutSent: (login: string) => string;
    createClip: string;
    clipCreated: string;
    openClip: string;
    feedTitle: string;
    feedEmpty: string;
  };
  /** Full-page states from #159: they replace page content (navigation
   *  stays usable) instead of stacking another red box on a normal page. */
  blocking: {
    botTitle: string;
    botDescriptionAdmin: string;
    botDescriptionViewer: string;
    botAction: string;
    botContact: string;
    channelTitle: string;
    channelDescription: string;
    channelAction: string;
    channelContact: string;
  };
}

const dashboardTextsCatalog: LocaleCatalog<DashboardTexts> = {
  de: {
    header: {
      connectionRunning: "Läuft",
      connectionWaiting: "Wartet",
      connectionInterrupted: "Gestört",
      channelIdentity: "Kanal",
      noConnection: "Keine Verbindung",
      switchOn: "An",
      switchOff: "Aus",
    },
    status: {
      connected: "Verbunden", revoked: "Widerrufen", error: "Fehler",
      loginIdentityMissing: "Login-Identität fehlt", notChecked: "Nicht geprüft", expired: "Abgelaufen",
      maintenanceOverdue: "Wartung überfällig", renewalOverdue: "Erneuerung überfällig", valid: "Gültig",
      moderatorRoleMissing: "Moderatorrolle fehlt", chatSubscriptionError: "Chat-Abo-Fehler", chatSubscriptionRevoked: "Chat-Abo widerrufen",
      botError: "Bot-Fehler", botTokenRevoked: "Bot-Token widerrufen", broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt",
      chatSubscriptionMissing: "Chat-Abo fehlt", healthy: "Gesund", stateIncomplete: "Zustand unvollständig",
      notConnected: "Nicht verbunden", notSetUp: "Nicht eingerichtet", moderator: "Moderator", missing: "Fehlt",
      active: "Aktiv", pending: "Ausstehend", notRequired: "Nicht erforderlich", present: "Vorhanden",
      botPermissionsMissing: (count) => `${count} fehlen`,
    },
    navigation: {
      mainNavigation: "Hauptnavigation", overview: "Übersicht", channel: "Kanal", system: "System",
      members: "Mitglieder", module: "Module", events: "Ereignisse", selectChannel: "Kanal auswählen",
      selectModule: "Modul auswählen",
      signInWithTwitch: "Mit Twitch anmelden", twitchAccount: "Twitch-Konto",
      signingOut: "Abmeldung …", signOut: "Abmelden",
      operationSection: "Betrieb",
      collapseSidebar: "Seitenleiste einklappen", expandSidebar: "Seitenleiste ausklappen",
      openSidebar: "Seitenleiste öffnen", closeSidebar: "Seitenleiste schließen",
    },
    overview: {
      oneChannelAvailable: "1 Kanal freigegeben",
      channelsAvailable: (count) => `${count} Kanäle sind für dich freigegeben.`,
      channelsAvailableShort: (count) => `${count} Kanäle freigegeben`,
      noChannelAvailable: "Noch kein Kanal freigegeben",
      noMembership: "Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.",
      activeModules: "Aktive Module", loadState: "Kanalzustand wird geladen …",
    },
    moderation: {
      noCheckForChannel: "Für diesen Kanal liegt noch keine Prüfung vor.",
      lastCheck: (timestamp) => `Letzte Prüfung: ${timestamp}`,
      checkRunning: "Prüfung läuft …", checkModeratorStatus: "Moderatorstatus prüfen",
      nextCheckFrom: (timestamp) => `Nächste Prüfung ab ${timestamp}.`,
      checkLocked: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
      broadcasterReauthorize: "Der Broadcaster muss Twitch erneut autorisieren.",
      requestBroadcasterConsent: "Broadcaster-Zustimmung anfordern",
    },
    bot: {
      noSavedStatus: "Es gibt noch keinen gespeicherten Botstatus.",
      lastUpdated: (timestamp) => `Zuletzt aktualisiert: ${timestamp}`,
      optionalModules: "Für optionale Broadcaster-Module verbunden.",
      normalOperation: "Optional; für den normalen Bot-Betrieb nicht erforderlich.",
      channelBotRequired: "channel:bot wird vom Broadcaster benötigt.",
      botPermissionsOperator: "Der Betreiber muss die Anwendung neu autorisieren.",
      botPermissionsComplete: "Alle angeforderten Bot-Berechtigungen sind vorhanden.",
    },
    errors: {
      title: "Fehler", warning: "Warnung", sessionInvalid: "Deine Sitzung ist nicht mehr gültig.",
      dataLoadFailed: "Die Daten konnten nicht geladen werden.", changeFailed: "Die Änderung ist fehlgeschlagen.", last: "Letzter Fehler",
      noCause: "Keine gespeicherte Ursache",
    },
    statusCard: {
      yourRole: "Deine Rolle", broadcasterOauth: "Broadcaster-OAuth", chatConsent: "Chat-Zustimmung",
      botAccount: "Bot-Account", botPermissions: "Bot-Berechtigungen", moderatorStatus: "Moderatorstatus", chatSubscription: "Chat-Abo", tokenStatus: "Token-Zustand",
      broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt", broadcastExplanation: "Für optionale Broadcaster-Module verbunden.",
      noBotStatus: "Es gibt noch keinen gespeicherten Botstatus.", chatBotRequired: "channel:bot wird vom Broadcaster benötigt.",
    },
    time: {
      updated: (relativeTime) => `aktualisiert ${relativeTime}`, secondsAgo: (count) => `vor ${String(count)} s`,
      minutesAgo: (count) => `vor ${String(count)} Min.`, hoursAgo: (count) => `vor ${String(count)} Std.`,
    },
    system: {
      title: "System", readOnly: "nur lesend", loadState: "Systemzustand wird geladen …", properties: "Eigenschaften",
      botReason: "Bot-Grund", botUpdated: "Bot zuletzt aktualisiert", chatSubscriptionId: "Chat-Abo-ID", chatSubscriptionReason: "Chat-Abo-Grund",
      chatSubscriptionUpdated: "Chat-Abo zuletzt aktualisiert", loginStatus: "Login-Token-Status", loginReason: "Login-Token-Grund",
      loginValidUntil: "Login-Token gültig bis", botValidUntil: "Bot-Token gültig bis", auditLog: "Audit-Log",
      entries: "Einträge", time: "Zeit", action: "Aktion", who: "Wer", loadAudit: "Audit-Log wird geladen …",
      noAuditEntries: "Noch keine Audit-Einträge gespeichert.", changeData: "Änderungsdaten",
      before: "Vorher", after: "Nachher", olderEntries: "Ältere Einträge laden",
      loadingOlderEntries: "Ältere Einträge werden geladen …",
      subscriptions: "Abonnements", noSubscriptions: "Keine Abonnements gespeichert.", subscription: "Abo", state: "Zustand", reason: "Grund",
      subscriptionDetails: "Abo-Details", subscriptionRawType: "Roher Typ", subscriptionVersion: "Version", subscriptionId: "Abo-ID", subscriptionUpdated: "Zuletzt geändert",
      twitchMessage: "Twitch-Meldung", httpStatus: "HTTP-Status", missingBotPermissions: "Fehlende Bot-Berechtigungen", missingScopes: "Fehlende Scopes",
    },
    events: {
      title: "Ereignisse", count: (count) => `${count} Einträge`, log: "Ereignisprotokoll", time: "Zeit", event: "Ereignis",
      module: "Modul", who: "Wer", automatic: "Automatisch", info: "Info", error: "Fehler", notice: "Hinweis", unknown: "Unbekannt", code: "Code", timestamp: "Zeitstempel", operation: "Vorgang", participants: "Beteiligte", history: "Verlauf",
      load: "Ereignisse werden geladen …",
      none: "Noch keine Ereignisse protokolliert.", detail: "Detail", loadOlder: "Ältere Ereignisse laden", loadingOlder: "Ältere Ereignisse werden geladen …",
      filter: "Filter", origin: "Herkunft", moduleFilter: "Modul", tone: "Ton", person: "Person", all: "Alle",
      channelEvents: "Kanalereignisse", moduleDiagnostics: "Moduldiagnosen", activeFilters: "Aktive Filter:", resetFilters: "Filter zurücksetzen",
      noMatches: "Keine Ereignisse passen zu den Filtern.", loadMoreAtEnd: "Am Ende werden ältere Ereignisse nachgeladen.",
      feedEnd: "Ende des Ereignisverlaufs erreicht.",
      realtimeConnecting: "Verbindet …", realtimeConnected: "Verbunden", realtimeReconnecting: "Verbindet neu …",
      realtimeOffline: "Offline", realtimeRenewSession: "Sitzung erneuern", realtimeNew: (count) => `${count} neue Ereignisse`,
      connectionLost: "Verbindung unterbrochen. Die Ereignisse konnten nicht geladen werden.",
      retry: "Erneut versuchen", technicalDetails: "Technische Details", copyId: "ID kopieren", copied: "Kopiert",
      trigger: "Auslöser", moderator: "Moderator", affectedPerson: "Betroffene Person",
    },
    signIn: {
      required: "Anmeldung erforderlich", explanation: "Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.",
      signInWithTwitch: "Mit Twitch anmelden", checkChannelAccess: "Kanalzugriff wird geprüft …", loadMembers: "Mitglieder werden geladen …",
    },
    module: {
      module: "Modul", available: "Verfügbare Module", load: "Module werden geladen …",
      registered: "Für diesen Bot ist noch kein Modul registriert.", active: "Aktiv", inactive: "Inaktiv",
      enable: "aktivieren", disable: "deaktivieren", moduleList: "Modulliste",
      moduleOverview: "Modulübersicht",
      managementLocked: "Nur Broadcaster und Verwalter dürfen Module ändern.", noneActive: "Keine Module aktiv.",
      noView: "Für dieses aktive Modul gibt es noch keine Panel-Ansicht.", views: "Modulansichten",
      loadingViews: "Modulansichten werden geladen …",
      notActive: (name) => `Das Modul „${name}“ ist in diesem Kanal nicht aktiv.`,
      scopesMissing: (name) => `Das Modul „${name}“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.`,
      requestScopeConsent: "Broadcaster-Berechtigungen erteilen",
      scopeConsentLocked: "Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.",
      scopeList: "Benötigte Broadcaster-Berechtigungen",
      scopeMissing: "Fehlt",
      scopeGranted: "Erteilt",
      unknown: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    },
    streamManager: {
      immediateActions: "Sofortaktionen",
      adLength: "Werbedauer",
      runAd: (length) => `Werbung jetzt (${length}s)`,
      adStarted: (length) => `Werbung gestartet (${length}s)`,
      adCooldown: (seconds) => `Wartezeit: ${seconds}s`,
      shoutoutLogin: "Twitch-Name",
      sendShoutout: "Shoutout senden",
      shoutoutSent: (login) => `Shoutout an ${login} gesendet`,
      createClip: "Clip erstellen",
      clipCreated: "Clip erstellt",
      openClip: "Clip öffnen",
      feedTitle: "Warnungen und Fehler",
      feedEmpty: "Keine Warnungen oder Fehler.",
    },
    blocking: {
      botTitle: "Der Bot ist nicht angemeldet",
      botDescriptionAdmin: "Ohne Bot-Identität empfängt kein Kanal Ereignisse: EventSub, Chat, Shoutouts und die Mitgliedersuche funktionieren nirgends. Melde den Bot an, um alles wieder in Betrieb zu setzen.",
      botDescriptionViewer: "Der Bot ist nicht verbunden. Das betrifft jeden Kanal: EventSub, Chat, Shoutouts und die Mitgliedersuche funktionieren nirgends. Das kann nur der Betreiber der Installation beheben.",
      botAction: "Bot anmelden",
      botContact: "Wende dich an den Betreiber der Installation.",
      channelTitle: "Kanal nicht freigegeben",
      channelDescription: "Dieser Kanal ist für dein Konto nicht freigegeben. Andere Kanäle sind davon nicht betroffen.",
      channelAction: "Zur Betreiberansicht",
      channelContact: "Nur der Betreiber kann diesen Kanal für dein Konto freigeben.",
    },
  },
  en: {
    header: {
      connectionRunning: "Running",
      connectionWaiting: "Waiting",
      connectionInterrupted: "Interrupted",
      channelIdentity: "Channel",
      noConnection: "No connection",
      switchOn: "On",
      switchOff: "Off",
    },
    status: {
      connected: "Connected", revoked: "Revoked", error: "Error", loginIdentityMissing: "Login identity missing",
      notChecked: "Not checked", expired: "Expired", maintenanceOverdue: "Maintenance overdue",
      renewalOverdue: "Renewal overdue", valid: "Valid", moderatorRoleMissing: "Moderator role missing",
      chatSubscriptionError: "Chat subscription error", chatSubscriptionRevoked: "Chat subscription revoked", botError: "Bot error",
      botTokenRevoked: "Bot token revoked", broadcasterConsentMissing: "Broadcaster consent missing",
      chatSubscriptionMissing: "Chat subscription missing", healthy: "Healthy", stateIncomplete: "Incomplete status",
      notConnected: "Not connected", notSetUp: "Not set up", moderator: "Moderator", missing: "Missing", active: "Active",
      pending: "Pending", notRequired: "Not required", present: "Present",
      botPermissionsMissing: (count) => `${count} missing`,
    },
    navigation: {
      mainNavigation: "Main navigation", overview: "Overview", channel: "Channel", system: "System",
      members: "Members", module: "Modules", events: "Events", selectChannel: "Select channel",
      selectModule: "Select module",
      signInWithTwitch: "Sign in with Twitch", twitchAccount: "Twitch account",
      signingOut: "Signing out …", signOut: "Sign out",
      operationSection: "Operation",
      collapseSidebar: "Collapse sidebar", expandSidebar: "Expand sidebar",
      openSidebar: "Open sidebar", closeSidebar: "Close sidebar",
    },
    overview: {
      oneChannelAvailable: "1 channel available",
      channelsAvailable: (count) => `${count} channels are available to you.`,
      channelsAvailableShort: (count) => `${count} channels available`,
      noChannelAvailable: "No channel available yet", noMembership: "This account is not a member of an available channel.",
      activeModules: "Active modules", loadState: "Loading channel status …",
    },
    moderation: {
      noCheckForChannel: "This channel has not been checked yet.", lastCheck: (timestamp) => `Last checked: ${timestamp}`,
      checkRunning: "Checking …", checkModeratorStatus: "Check moderator status",
      nextCheckFrom: (timestamp) => `Next check available ${timestamp}.`,
      checkLocked: "Only broadcasters and managers may check moderator status.",
      broadcasterReauthorize: "The broadcaster must authorize Twitch again.", requestBroadcasterConsent: "Request broadcaster consent",
    },
    bot: {
      noSavedStatus: "No bot status has been saved yet.", lastUpdated: (timestamp) => `Last updated: ${timestamp}`,
      optionalModules: "Connected for optional broadcaster modules.", normalOperation: "Optional; not required for normal bot operation.",
      channelBotRequired: "channel:bot is required from the broadcaster.",
      botPermissionsOperator: "The operator must authorize the application again.",
      botPermissionsComplete: "All requested bot permissions are present.",
    },
    errors: {
      title: "Error", warning: "Warning", sessionInvalid: "Your session is no longer valid.", dataLoadFailed: "The data could not be loaded.",
      changeFailed: "The change failed.",
      last: "Last error", noCause: "No saved cause",
    },
    statusCard: {
      yourRole: "Your role", broadcasterOauth: "Broadcaster OAuth", chatConsent: "Chat consent", botAccount: "Bot account", botPermissions: "Bot permissions",
      moderatorStatus: "Moderator status", chatSubscription: "Chat subscription", tokenStatus: "Token status",
      broadcasterConsentMissing: "Broadcaster consent missing", broadcastExplanation: "Connected for optional broadcaster modules.",
      noBotStatus: "No bot status has been saved yet.", chatBotRequired: "channel:bot is required from the broadcaster.",
    },
    time: {
      updated: (relativeTime) => `updated ${relativeTime}`, secondsAgo: (count) => `${String(count)} sec ago`,
      minutesAgo: (count) => `${String(count)} min ago`, hoursAgo: (count) => `${String(count)} hr ago`,
    },
    system: {
      title: "System", readOnly: "read-only", loadState: "Loading system status …", properties: "Properties",
      botReason: "Bot reason", botUpdated: "Bot last updated", chatSubscriptionId: "Chat subscription ID", chatSubscriptionReason: "Chat subscription reason",
      chatSubscriptionUpdated: "Chat subscription last updated", loginStatus: "Login token status", loginReason: "Login token reason",
      loginValidUntil: "Login token valid until", botValidUntil: "Bot token valid until", auditLog: "Audit log", entries: "entries",
      time: "Time", action: "Action", who: "Who",
      loadAudit: "Loading audit log …", noAuditEntries: "No audit entries saved yet.", changeData: "Change data",
      before: "Before", after: "After", olderEntries: "Load older entries", loadingOlderEntries: "Loading older entries …",
      subscriptions: "Subscriptions", noSubscriptions: "No subscriptions saved.", subscription: "Subscription", state: "State", reason: "Reason",
      subscriptionDetails: "Subscription details", subscriptionRawType: "Raw type", subscriptionVersion: "Version", subscriptionId: "Subscription ID", subscriptionUpdated: "Last changed",
      twitchMessage: "Twitch message", httpStatus: "HTTP status", missingBotPermissions: "Missing bot permissions", missingScopes: "Missing scopes",
    },
    events: {
      title: "Events", count: (count) => `${count} entries`, log: "Event log", time: "Time", event: "Event", module: "Module",
      who: "Who", automatic: "Automatic", info: "Info", error: "Error", notice: "Notice", unknown: "Unknown", code: "Code", timestamp: "Timestamp", operation: "Operation", participants: "Participants", history: "History", load: "Loading events …", none: "No events logged yet.", detail: "Detail",
      loadOlder: "Load older events", loadingOlder: "Loading older events …",
      filter: "Filters", origin: "Origin", moduleFilter: "Module", tone: "Tone", person: "Person", all: "All",
      channelEvents: "Channel events", moduleDiagnostics: "Module diagnostics", activeFilters: "Active filters:", resetFilters: "Reset filters",
      noMatches: "No events match the filters.", loadMoreAtEnd: "Older events load at the end.",
      feedEnd: "End of the event history reached.",
      realtimeConnecting: "Connecting …", realtimeConnected: "Connected", realtimeReconnecting: "Reconnecting …",
      realtimeOffline: "Offline", realtimeRenewSession: "Renew session", realtimeNew: (count) => `${count} new events`,
      connectionLost: "Connection lost. The events could not be loaded.",
      retry: "Retry", technicalDetails: "Technical details", copyId: "Copy ID", copied: "Copied",
      trigger: "Trigger", moderator: "Moderator", affectedPerson: "Affected person",
    },
    signIn: {
      required: "Sign-in required", explanation: "Sign in with your Twitch account to see available channels.",
      signInWithTwitch: "Sign in with Twitch", checkChannelAccess: "Checking channel access …", loadMembers: "Loading members …",
    },
    module: {
      module: "Module", available: "Available modules", load: "Loading modules …", registered: "No module is registered for this bot yet.",
      active: "Active", inactive: "Inactive", enable: "enable", disable: "disable", moduleList: "Module list",
      moduleOverview: "Module overview",
      managementLocked: "Only broadcasters and managers may change modules.", noneActive: "No modules active.",
      noView: "This active module does not have a panel view yet.", views: "Module views", loadingViews: "Loading module views …",
      notActive: (name) => `The module “${name}” is not active in this channel.`,
      unknown: (name) => `The module “${name}” is unknown.`,
      scopesMissing: (name) => `The module “${name}” is disabled because broadcaster permissions are missing.`,
      requestScopeConsent: "Grant broadcaster permissions",
      scopeConsentLocked: "Only this channel’s broadcaster may grant this consent.",
      scopeList: "Required broadcaster permissions",
      scopeMissing: "Missing",
      scopeGranted: "Granted",
    },
    streamManager: {
      immediateActions: "Immediate actions",
      adLength: "Ad length",
      runAd: (length) => `Run ad now (${length}s)`,
      adStarted: (length) => `Ad started (${length}s)`,
      adCooldown: (seconds) => `Cooldown: ${seconds}s`,
      shoutoutLogin: "Twitch login",
      sendShoutout: "Send shoutout",
      shoutoutSent: (login) => `Shoutout sent to ${login}`,
      createClip: "Create clip",
      clipCreated: "Clip created",
      openClip: "Open clip",
      feedTitle: "Warnings and errors",
      feedEmpty: "No warnings or errors.",
    },
    blocking: {
      botTitle: "The bot is not signed in",
      botDescriptionAdmin: "Without a bot identity no channel receives events: EventSub, chat, shoutouts, and member search all fail everywhere. Sign the bot in to bring everything back.",
      botDescriptionViewer: "The bot is not connected. This affects every channel: EventSub, chat, shoutouts, and member search fail everywhere. Only the installation's operator can fix this.",
      botAction: "Sign in the bot",
      botContact: "Contact the installation's operator.",
      channelTitle: "Channel not released",
      channelDescription: "This channel is not released to your account. Other channels are not affected.",
      channelAction: "Go to the operator view",
      channelContact: "Only the operator can release this channel to your account.",
    },
  },
};

// Re-exported from `contracts/values` (not declared here): modules and the
// worker construct diagnostics with this same type, so it has to live where
// both sides of the module boundary can reach it. See `EVENT_CODES` there
// for the full list and the freeze this closed union gives every
// construction site.
export type { EventCode };

export type EventDetail = Readonly<Record<string, unknown>>;
export type EventText = string | ((detail: EventDetail) => string);

const textCommandName = (detail: EventDetail): string | null =>
  typeof detail.name === "string" && detail.name.length > 0 ? detail.name : null;

const eventTextWithName = (
  detail: EventDetail,
  withoutName: string,
  withName: (name: string) => string,
): string => {
  const name = textCommandName(detail);
  return name === null ? withoutName : withName(name);
};

const detailText = (detail: EventDetail, key: string, fallback: string): string =>
  typeof detail[key] === "string" && detail[key].length > 0 ? detail[key] : fallback;

const textCommandTier = (detail: EventDetail, key: string, fallback: string, language: DashboardLanguage): string => {
  const value = detail[key];
  const labels: Record<string, string> = language === "de"
    ? { everyone: "alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster", viewer: "Zuschauer" }
    : { everyone: "everyone", subscriber: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcaster", viewer: "viewer" };
  const values = Array.isArray(value) ? value : [value];
  const labeledValues = values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return labeledValues.length === 0
    ? fallback
    : labeledValues.map((entry) => labels[entry] ?? entry).join(", ");
};

const detailNumber = (detail: EventDetail, key: string, fallback: string): string =>
  typeof detail[key] === "number" && Number.isFinite(detail[key]) ? String(detail[key]) : fallback;

const detailDuration = (detail: EventDetail, unit: string, fallback: string): string =>
  typeof detail.duration === "number" && Number.isFinite(detail.duration) ? `${String(detail.duration)} ${unit}` : fallback;

const detailReason = (detail: EventDetail): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? `: ${detail.reason}`
    : "";

const detailReasonWith = (detail: EventDetail, preposition: string): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? ` ${preposition} ${detail.reason}`
    : "";

const detailClassification = (detail: EventDetail, fallback: string): string =>
  typeof detail.einstufung === "string" && detail.einstufung.length > 0 ? detail.einstufung : fallback;

const detailModerator = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` von ${detail.moderator}` : fallback;

const detailModeratorEn = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` by ${detail.moderator}` : fallback;

export const eventTexts: LocaleCatalog<Record<EventCode, EventText>> = {
  de: {
    "host.action.failed": "Aktion fehlgeschlagen",
    "host.chat.failed": "Chat-Nachricht fehlgeschlagen",
    "host.chat.sent": "Chat-Nachricht gesendet",
    "host.module.error": "Modulfehler",
    "host.module.unknown": "Unbekanntes Modul",
    "host.overlay.not_executed": "Overlay nicht ausgeführt",
    "host.shoutout.failed": "Shoutout fehlgeschlagen",
    "host.shoutout.sent": "Shoutout gesendet",
    "host.clip.failed": "Clip fehlgeschlagen",
    "channel_events.raid.incoming": (detail) => `Raid von ${detailText(detail, "source", "unbekannt")} mit ${detailNumber(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.raid.outgoing": (detail) => `Raid zu ${detailText(detail, "target", "unbekannt")} mit ${detailNumber(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.shoutout.sent": (detail) => `Shoutout an ${detailText(detail, "target", "unbekannt")}`,
    "channel_events.shoutout.received": (detail) => `Shoutout von ${detailText(detail, "source", "unbekannt")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` mit ${String(detail.viewers)} Zuschauern` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.resub": (detail) => `Resub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift-Sub von ${detailText(detail, "gifter", "unbekannt")} an ${detailText(detail, "recipient", "unbekannt")}`,
    "channel_events.chat.community_gift": (detail) => `Community-Gift von ${detailText(detail, "gifter", "unbekannt")} für ${detailNumber(detail, "count", "unbekannte Anzahl")} Subs`,
    "channel_events.chat.announcement": (detail) => `Ankündigung von ${detailText(detail, "person", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.chat.unknown": (detail) => `Unbekannte Chat-Benachrichtigung: ${detailText(detail, "art", "unbekannt")}`,
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unbekannt")} gebannt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unbekannt")} für ${detailDuration(detail, "Sekunden", "unbekannte Dauer")} getimeoutet von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unbekannt")} aus dem Timeout genommen von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unbekannt")} entbannt von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.delete": (detail) => `Nachricht von ${detailText(detail, "person", "unbekannt")} gelöscht von ${detailText(detail, "moderator", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unbekannt")} verwarnt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.unknown": (detail) => `Unbekannte Moderationsaktion: ${detailText(detail, "action", "unbekannt")}`,
    "channel_events.automod.held": (detail) => `AutoMod hielt die Nachricht von ${detailText(detail, "person", "unbekannt")}${detailReasonWith(detail, "wegen")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.suspicious.message": (detail) => `Nachricht von auffälligem Nutzer ${detailText(detail, "person", "unbekannt")} (${detailClassification(detail, "unbekannte Einstufung")}): ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.suspicious.classified": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} verschärft${detailModerator(detail, "")}: ${detailClassification(detail, "unbekannt")}`,
    "channel_events.suspicious.cleared": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} aufgehoben${detailModerator(detail, "")}`,
    "raid.outgoing": (detail) => `Ausgehender Raid zu ${detailText(detail, "targetChannelId", "unbekannt")}`,
    "raid.shoutout": (detail) => `Raid über der Schwelle (${detailNumber(detail, "viewers", "unbekannt")} von ${detailNumber(detail, "threshold", "unbekannt")}): Shoutout und Chatzeile`,
    "raid.invalid": (detail) => `Raid verworfen: ${detailText(detail, "reason", "ungültige Daten")}`,
    "shoutout.suppressed": (detail) => detail.reason === "abgeschaltet"
      ? "Shoutout abgeschaltet"
      : detail.reason === "unter_schwelle"
        ? `Shoutout unter der Schwelle (${detailNumber(detail, "viewers", "unbekannt")} von ${detailNumber(detail, "threshold", "unbekannt")} Zuschauern)`
        : "Shoutout unterdrückt",
    "ads.announcement": (detail) => `Werbepause ${detail.automatic === true ? "automatisch" : "manuell"} startedAt: ${detailNumber(detail, "duration", "unbekannte Dauer")} Sekunden`,
    "ads.skipped": (detail) => `Werbepause übersprungen: ${detail.reason === "dauer_null" ? "Dauer ist null" : "Ereignisdaten sind ungültig"}`,
    "ads.prewarning.announced": (detail) => `Vorwarnung: Werbung in ${detailNumber(detail, "sekunden", "unbekannter Zeit")} Sekunden`,
    "ads.prewarning.no_schedule": "Keine nächste Werbepause geplant",
    "ads.prewarning.too_late": "Werbe-Vorwarnung unterdrückt: Termin zu nah",
    "ads.prewarning.break_started": "Werbe-Vorwarnung unterdrückt: Werbepause hat begonnen",
    "ads.prewarning.rescheduled": "Werbe-Vorwarnung unterdrückt: Termin wurde verschoben",
    "ads.prewarning.scope_missing": "Werbe-Vorwarnung unterdrückt: channel:read:ads fehlt",
    "ads.prewarning.schedule_error": (detail) => `Werbezeitplan nicht gelesen: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "ads.snooze": (detail) => detail.outcome === "success" ? "Nächste Werbepause verschoben" : `Snooze nicht ausgeführt: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "ads.commercial.failed": (detail) => `Werbeeinblendung nicht gestartet: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "text_commands.cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Textbefehl abgekühlt"
        : `Befehl !${name} abgekühlt, noch ${String(detail.remainingSeconds)} s`;
    },
    "text_commands.triggered": (detail) => eventTextWithName(detail, "Befehl ausgeführt", (name) => `Befehl !${name} ausgeführt`),
    "text_commands.disabled": (detail) => eventTextWithName(detail, "Textbefehl ausgeschaltet", (name) => `Textbefehl !${name} ausgeschaltet`),
    "text_commands.permission_denied": (detail) => eventTextWithName(detail, "Textbefehl nicht berechtigt", (name) => `Befehl !${name} nicht ausgelöst: Mindeststufe ${textCommandTier(detail, "requiredTier", "unbekannt", "de")}, vorhanden ${textCommandTier(detail, "currentTier", "kein Chat-Status", "de")}`),
    "text_commands.already_exists": (detail) => eventTextWithName(detail, "Textbefehl bereits vorhanden", (name) => `Textbefehl !${name} bereits vorhanden`),
    "text_commands.not_authorized": "Textbefehl nicht berechtigt",
    "text_commands.unknown": (detail) => eventTextWithName(detail, "Textbefehl unbekannt", (name) => `Textbefehl !${name} unbekannt`),
    "text_commands.invalid": "Textbefehl ungültig",
  },
  en: {
    "host.action.failed": "Action failed",
    "host.chat.failed": "Chat message failed",
    "host.chat.sent": "Chat message sent",
    "host.module.error": "Module error",
    "host.module.unknown": "Unknown module",
    "host.overlay.not_executed": "Overlay not executed",
    "host.shoutout.failed": "Shoutout failed",
    "host.shoutout.sent": "Shoutout sent",
    "host.clip.failed": "Clip failed",
    "channel_events.raid.incoming": (detail) => `Raid from ${detailText(detail, "source", "unknown")} with ${detailNumber(detail, "viewers", "unknown number")} viewers`,
    "channel_events.raid.outgoing": (detail) => `Raid to ${detailText(detail, "target", "unknown")} with ${detailNumber(detail, "viewers", "unknown number")} viewers`,
    "channel_events.shoutout.sent": (detail) => `Shoutout sent to ${detailText(detail, "target", "unknown")}`,
    "channel_events.shoutout.received": (detail) => `Shoutout received from ${detailText(detail, "source", "unknown")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` with ${String(detail.viewers)} viewers` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.resub": (detail) => `Resub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift sub from ${detailText(detail, "gifter", "unknown")} to ${detailText(detail, "recipient", "unknown")}`,
    "channel_events.chat.community_gift": (detail) => `Community gift from ${detailText(detail, "gifter", "unknown")} for ${detailNumber(detail, "count", "unknown number")} subs`,
    "channel_events.chat.announcement": (detail) => `Announcement from ${detailText(detail, "person", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.chat.unknown": (detail) => `Unknown chat notification: ${detailText(detail, "art", "unknown")}`,
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unknown")} banned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unknown")} timed out for ${detailDuration(detail, "seconds", "unknown duration")} by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unknown")} removed from timeout by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unknown")} unbanned by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.delete": (detail) => `Message from ${detailText(detail, "person", "unknown")} deleted by ${detailText(detail, "moderator", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unknown")} warned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.unknown": (detail) => `Unknown moderation action: ${detailText(detail, "action", "unknown")}`,
    "channel_events.automod.held": (detail) => `AutoMod held a message from ${detailText(detail, "person", "unknown")}${detailReasonWith(detail, "for")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.suspicious.message": (detail) => `Message from suspicious user ${detailText(detail, "person", "unknown")} (${detailClassification(detail, "unknown classification")}): ${detailText(detail, "text", "no text")}`,
    "channel_events.suspicious.classified": (detail) => `Classification for ${detailText(detail, "person", "unknown")} tightened${detailModeratorEn(detail, "")}: ${detailClassification(detail, "unknown")}`,
    "channel_events.suspicious.cleared": (detail) => `Classification for ${detailText(detail, "person", "unknown")} cleared${detailModeratorEn(detail, "")}`,
    "raid.outgoing": (detail) => `Outgoing raid to ${detailText(detail, "targetChannelId", "unknown")}`,
    "raid.shoutout": (detail) => `Raid above threshold (${detailNumber(detail, "viewers", "unknown")} of ${detailNumber(detail, "threshold", "unknown")}): shoutout and chat line`,
    "raid.invalid": (detail) => `Raid discarded: ${detailText(detail, "reason", "invalid data")}`,
    "shoutout.suppressed": (detail) => detail.reason === "abgeschaltet"
      ? "Shoutout disabled"
      : detail.reason === "unter_schwelle"
        ? `Shoutout below threshold (${detailNumber(detail, "viewers", "unknown")} of ${detailNumber(detail, "threshold", "unknown")} viewers)`
        : "Shoutout suppressed",
    "ads.announcement": (detail) => `Ad break ${detail.automatic === true ? "automatically" : "manually"} started: ${detailNumber(detail, "duration", "unknown duration")} seconds`,
    "ads.skipped": (detail) => `Ad break skipped: ${detail.reason === "dauer_null" ? "duration is zero" : "event data is invalid"}`,
    "ads.prewarning.announced": (detail) => `Ad warning: ad in ${detailNumber(detail, "sekunden", "unknown time")} seconds`,
    "ads.prewarning.no_schedule": "No next ad break scheduled",
    "ads.prewarning.too_late": "Ad warning suppressed: ad is too close",
    "ads.prewarning.break_started": "Ad warning suppressed: ad break has started",
    "ads.prewarning.rescheduled": "Ad warning suppressed: schedule changed",
    "ads.prewarning.scope_missing": "Ad warning suppressed: channel:read:ads is missing",
    "ads.prewarning.schedule_error": (detail) => `Ad schedule could not be read: ${detailText(detail, "reason", "unknown error")}`,
    "ads.snooze": (detail) => detail.outcome === "success" ? "Next ad break postponed" : `Snooze not executed: ${detailText(detail, "reason", "unknown error")}`,
    "ads.commercial.failed": (detail) => `Commercial not started: ${detailText(detail, "reason", "unknown error")}`,
    "text_commands.cooldown": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Text command on cooldown"
        : `Command !${name} on cooldown, ${String(detail.remainingSeconds)}s left`;
    },
    "text_commands.triggered": (detail) => eventTextWithName(detail, "Command executed", (name) => `Command !${name} executed`),
    "text_commands.disabled": (detail) => eventTextWithName(detail, "Text command disabled", (name) => `Text command !${name} disabled`),
    "text_commands.permission_denied": (detail) => eventTextWithName(detail, "Text command not authorized", (name) => `Command !${name} not executed: minimum level ${textCommandTier(detail, "requiredTier", "unknown", "en")}, present ${textCommandTier(detail, "currentTier", "no chat status", "en")}`),
    "text_commands.already_exists": (detail) => eventTextWithName(detail, "Text command already exists", (name) => `Text command !${name} already exists`),
    "text_commands.not_authorized": "Text command not authorized",
    "text_commands.unknown": (detail) => eventTextWithName(detail, "Unknown text command", (name) => `Unknown text command !${name}`),
    "text_commands.invalid": "Invalid text command",
  },
};

export type EventFamily = "gemeinschaft" | "raid" | "moderation" | "betrieb";
export type EventTier = "voll" | "gezeichnet";
export type EventNumberKey = "viewers" | "count" | "duration" | "remainingSeconds" | "tier" | null;
export interface EventToneEntry {
  family: EventFamily;
  tier: EventTier;
  word: LocaleCatalog<string>;
  numberKey: EventNumberKey;
  tone?: EventTone;
}

export const eventToneEntries: Record<EventCode, EventToneEntry> = {
  "host.action.failed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.chat.failed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.chat.sent": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "host.module.error": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.module.unknown": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "host.overlay.not_executed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.shoutout.failed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.shoutout.sent": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "channel_events.raid.incoming": { family: "raid", tier: "voll", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "channel_events.raid.outgoing": { family: "raid", tier: "gezeichnet", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "channel_events.shoutout.sent": { family: "raid", tier: "gezeichnet", word: { de: "Shoutout", en: "Shoutout" }, numberKey: null },
  "channel_events.shoutout.received": { family: "raid", tier: "voll", word: { de: "Shoutout", en: "Shoutout" }, numberKey: "viewers" },
  "channel_events.chat.sub": { family: "gemeinschaft", tier: "voll", word: { de: "Abo", en: "Sub" }, numberKey: "tier" },
  "channel_events.chat.resub": { family: "gemeinschaft", tier: "voll", word: { de: "Resub", en: "Resub" }, numberKey: "tier" },
  "channel_events.chat.gift_sub": { family: "gemeinschaft", tier: "voll", word: { de: "Gift-Sub", en: "Gift Sub" }, numberKey: "tier" },
  "channel_events.chat.community_gift": { family: "gemeinschaft", tier: "voll", word: { de: "Gift", en: "Gift" }, numberKey: "count" },
  "channel_events.chat.announcement": { family: "gemeinschaft", tier: "gezeichnet", word: { de: "Ankündigung", en: "Announcement" }, numberKey: null },
  "channel_events.chat.unknown": { family: "gemeinschaft", tier: "voll", word: { de: "Unbekannt", en: "Unknown" }, numberKey: null },
  "channel_events.moderation.ban": { family: "moderation", tier: "voll", word: { de: "Bann", en: "Ban" }, numberKey: null },
  "channel_events.moderation.timeout": { family: "moderation", tier: "voll", word: { de: "Auszeit", en: "Timeout" }, numberKey: "duration" },
  "channel_events.moderation.untimeout": { family: "moderation", tier: "gezeichnet", word: { de: "Entsperrt", en: "Untimeout" }, numberKey: null },
  "channel_events.moderation.unban": { family: "moderation", tier: "gezeichnet", word: { de: "Entbannt", en: "Unbanned" }, numberKey: null },
  "channel_events.moderation.delete": { family: "moderation", tier: "voll", word: { de: "Gelöscht", en: "Deleted" }, numberKey: null },
  "channel_events.moderation.warn": { family: "moderation", tier: "voll", word: { de: "Verwarnung", en: "Warning" }, numberKey: null },
  "channel_events.moderation.unknown": { family: "moderation", tier: "voll", word: { de: "Unbekannt", en: "Unknown" }, numberKey: null },
  "channel_events.automod.held": { family: "moderation", tier: "voll", word: { de: "AutoMod", en: "AutoMod" }, numberKey: null },
  "channel_events.suspicious.message": { family: "moderation", tier: "voll", word: { de: "Verdacht", en: "Suspicious" }, numberKey: null },
  "channel_events.suspicious.classified": { family: "moderation", tier: "voll", word: { de: "Einstufung", en: "Classified" }, numberKey: null },
  "channel_events.suspicious.cleared": { family: "moderation", tier: "gezeichnet", word: { de: "Entwarnt", en: "Cleared" }, numberKey: null },
  "raid.outgoing": { family: "raid", tier: "gezeichnet", word: { de: "Raid", en: "Raid" }, numberKey: "viewers", tone: "warning" },
  "raid.shoutout": { family: "raid", tier: "voll", word: { de: "Raid", en: "Raid" }, numberKey: "viewers" },
  "raid.invalid": { family: "raid", tier: "gezeichnet", word: { de: "Raid", en: "Raid" }, numberKey: null, tone: "warning" },
  "shoutout.suppressed": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.announcement": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: "duration", tone: "info" },
  "ads.skipped": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.announced": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "ads.prewarning.no_schedule": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.too_late": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.break_started": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.rescheduled": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.scope_missing": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "ads.prewarning.schedule_error": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "ads.snooze": { family: "betrieb", tier: "gezeichnet", word: { de: "Snooze", en: "Snooze" }, numberKey: null, tone: "info" },
  "ads.commercial.failed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "host.clip.failed": { family: "betrieb", tier: "gezeichnet", word: { de: "Fehler", en: "Error" }, numberKey: null, tone: "error" },
  "text_commands.cooldown": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: "remainingSeconds", tone: "warning" },
  "text_commands.triggered": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.disabled": { family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info" },
  "text_commands.permission_denied": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.already_exists": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.not_authorized": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.unknown": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
  "text_commands.invalid": { family: "betrieb", tier: "gezeichnet", word: { de: "Hinweis", en: "Notice" }, numberKey: null, tone: "warning" },
};

export function eventText(code: string, language?: DashboardLanguage): string;
export function eventText(code: string, detail: EventDetail, language?: DashboardLanguage): string;
export function eventText(
  code: string,
  detailOrLanguage: EventDetail | DashboardLanguage = {},
  language?: DashboardLanguage,
): string {
  const detail = typeof detailOrLanguage === "string" ? {} : detailOrLanguage;
  const resolvedLanguage = typeof detailOrLanguage === "string"
    ? detailOrLanguage
    : language ?? dashboardLanguage();
  if (Object.prototype.hasOwnProperty.call(eventTexts[resolvedLanguage], code)) {
    const text = eventTexts[resolvedLanguage][code as EventCode];
    return typeof text === "function" ? text(detail) : text;
  }
  return code;
}

/**
 * DE/EN text for every `ApiErrorCode` the worker (or the dashboard's own
 * request guard) can send back as `{ "error": "<code>" }`. `Record<ApiErrorCode,
 * string>` per language, the same reasoning as `eventTexts`: adding a code in
 * `contracts/values.ts` without a matching entry here fails the build.
 */
export const apiErrorTexts: LocaleCatalog<Record<ApiErrorCode, string>> = {
  de: {
    session_missing: "Sitzung fehlt.",
    csrf_invalid: "CSRF-Token fehlt oder ist ungültig.",
    channel_missing: "Kanal fehlt.",
    channel_access_denied: "Kanalzugriff verweigert.",
    platform_access_denied: "Kein Betreiberzugang.",
    panel_request_not_allowed: "Die Panel-Anfrage ist nicht erlaubt.",
    pagination_limit_invalid: "Die Begrenzung ist ungültig.",
    pagination_cursor_invalid: "Der Cursor ist ungültig.",
    twitch_login_invalid: "Twitch-Name fehlt oder ist ungültig.",
    twitch_user_not_found: "Twitch-Nutzer nicht gefunden.",
    twitch_user_search_failed: "Twitch-Nutzersuche ist fehlgeschlagen.",
    channel_not_found: "Kanal nicht gefunden.",
    broadcaster_role_immutable: "Die Rolle Broadcaster darf auf der Betreiberebene nicht geändert werden.",
    broadcaster_role_change_requires_broadcaster: "Nur ein Broadcaster darf die Rolle Broadcaster vergeben oder entziehen.",
    mutation_failed: "Die Änderung konnte nicht durchgeführt werden.",
    member_changed_concurrently: "Mitglied wurde inzwischen geändert.",
    release_input_invalid: "Login oder Vollzustimmung ist ungültig.",
    channel_already_released: "Der Kanal ist bereits freigegeben.",
    channel_release_failed: "Der Kanal konnte nicht freigegeben werden.",
    full_consent_invalid: "Vollzustimmung ist ungültig.",
    full_consent_already_set: "Diese Vollzustimmung ist bereits gesetzt.",
    member_or_role_invalid: "Mitglied oder Rolle ist ungültig.",
    member_already_exists: "Dieses Mitglied ist bereits freigegeben.",
    member_management_denied: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.",
    self_membership_denied: "Du kannst deine eigene Mitgliedschaft nicht per POST anlegen.",
    member_add_failed: "Mitglied konnte nicht hinzugefügt werden.",
    role_invalid: "Rolle ist ungültig.",
    member_not_found: "Mitglied nicht gefunden.",
    role_already_set: "Diese Rolle ist bereits gesetzt.",
    self_role_escalation_denied: "Du kannst deine eigene Rolle nicht erhöhen.",
    last_broadcaster_cannot_be_demoted: "Der letzte Broadcaster kann nicht herabgestuft werden.",
    last_broadcaster_cannot_be_removed: "Der letzte Broadcaster kann nicht entfernt werden.",
    event_origin_invalid: "Ereignis-Herkunft ist ungültig.",
    event_tone_invalid: "Ereignis-Ton ist ungültig.",
    moderator_status_check_denied: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
    moderator_status_check_rate_limited: "Der Moderatorstatus wurde für diesen Kanal kürzlich geprüft.",
    moderator_status_check_failed: "Moderatorstatus konnte nicht gelesen werden.",
    module_management_denied: "Nur Broadcaster und Verwalter dürfen Module ändern.",
    module_unknown: "Unbekanntes Modul.",
    module_not_configured: "Modul ist in diesem Kanal nicht eingerichtet.",
    module_settings_invalid: "Moduleinstellungen sind ungültig.",
    module_settings_changed_concurrently: "Moduleinstellungen wurden inzwischen geändert.",
    module_enabled_field_invalid: "Feld enabled ist ungültig.",
    module_changed_concurrently: "Modul wurde inzwischen geändert.",
    command_management_denied: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, ändern oder löschen.",
    command_data_invalid: "Befehlsdaten sind ungültig.",
    command_already_exists: "Der Befehl existiert bereits.",
    command_creation_denied: "Der Befehl darf nicht angelegt werden.",
    command_not_found: "Der Befehl wurde nicht gefunden.",
    command_update_denied: "Der Befehl darf nicht geändert werden.",
    command_changed_concurrently: "Der Befehl wurde inzwischen geändert.",
    command_delete_denied: "Der Befehl darf nicht gelöscht werden.",
    ad_schedule_read_failed: "Der Werbezeitplan konnte nicht gelesen werden.",
    ad_snooze_failed: "Die nächste Werbepause konnte nicht verschoben werden.",
    commercial_length_invalid: "Die Werbedauer ist ungültig.",
    commercial_start_failed: "Die Werbeeinblendung konnte nicht gestartet werden.",
    clip_create_failed: "Der Clip konnte nicht erstellt werden.",
    shoutout_send_failed: "Der Shoutout konnte nicht gesendet werden.",
    overlay_token_manage_denied: "Nur Broadcaster und Verwalter dürfen Overlay-Token verwalten.",
    overlay_expiry_invalid: "Ablaufzeit ist ungültig.",
    overlay_revocation_reason_invalid: "Widerrufsgrund fehlt oder ist ungültig.",
    overlay_token_not_found: "Overlay-Token nicht gefunden.",
    overlay_token_invalid: "Overlay-Zugang ungültig.",
    unknown_api_route: "Unbekannte API-Route.",
  },
  en: {
    session_missing: "Session missing.",
    csrf_invalid: "CSRF token missing or invalid.",
    channel_missing: "Channel missing.",
    channel_access_denied: "Channel access denied.",
    platform_access_denied: "No operator access.",
    panel_request_not_allowed: "This panel request is not allowed.",
    pagination_limit_invalid: "The limit is invalid.",
    pagination_cursor_invalid: "The cursor is invalid.",
    twitch_login_invalid: "Twitch name missing or invalid.",
    twitch_user_not_found: "Twitch user not found.",
    twitch_user_search_failed: "Twitch user search failed.",
    channel_not_found: "Channel not found.",
    broadcaster_role_immutable: "The broadcaster role cannot be changed at the operator level.",
    broadcaster_role_change_requires_broadcaster: "Only a broadcaster can grant or revoke the broadcaster role.",
    mutation_failed: "The change could not be made.",
    member_changed_concurrently: "The member has since changed.",
    release_input_invalid: "Login or full consent is invalid.",
    channel_already_released: "The channel is already released.",
    channel_release_failed: "The channel could not be released.",
    full_consent_invalid: "Full consent is invalid.",
    full_consent_already_set: "This full consent is already set.",
    member_or_role_invalid: "Member or role is invalid.",
    member_already_exists: "This member is already added.",
    member_management_denied: "Only broadcasters and managers may change members.",
    self_membership_denied: "You cannot add your own membership by POST.",
    member_add_failed: "The member could not be added.",
    role_invalid: "Role is invalid.",
    member_not_found: "Member not found.",
    role_already_set: "This role is already set.",
    self_role_escalation_denied: "You cannot raise your own role.",
    last_broadcaster_cannot_be_demoted: "The last broadcaster cannot be demoted.",
    last_broadcaster_cannot_be_removed: "The last broadcaster cannot be removed.",
    event_origin_invalid: "Event origin is invalid.",
    event_tone_invalid: "Event tone is invalid.",
    moderator_status_check_denied: "Only broadcasters and managers may check the moderator status.",
    moderator_status_check_rate_limited: "The moderator status for this channel was checked recently.",
    moderator_status_check_failed: "The moderator status could not be read.",
    module_management_denied: "Only broadcasters and managers may change modules.",
    module_unknown: "Unknown module.",
    module_not_configured: "This module is not set up for this channel.",
    module_settings_invalid: "The module settings are invalid.",
    module_settings_changed_concurrently: "The module settings have since changed.",
    module_enabled_field_invalid: "The enabled field is invalid.",
    module_changed_concurrently: "The module has since changed.",
    command_management_denied: "Only broadcasters and managers may create, change, or remove commands.",
    command_data_invalid: "Command data is invalid.",
    command_already_exists: "This command already exists.",
    command_creation_denied: "This command may not be created.",
    command_not_found: "This command was not found.",
    command_update_denied: "This command may not be changed.",
    command_changed_concurrently: "This command has since changed.",
    command_delete_denied: "This command may not be removed.",
    ad_schedule_read_failed: "The ad schedule could not be read.",
    ad_snooze_failed: "The next ad break could not be postponed.",
    commercial_length_invalid: "The commercial length is invalid.",
    commercial_start_failed: "The commercial could not be started.",
    clip_create_failed: "The clip could not be created.",
    shoutout_send_failed: "The shoutout could not be sent.",
    overlay_token_manage_denied: "Only broadcasters and managers may manage overlay tokens.",
    overlay_expiry_invalid: "Expiry is invalid.",
    overlay_revocation_reason_invalid: "Revocation reason missing or invalid.",
    overlay_token_not_found: "Overlay token not found.",
    overlay_token_invalid: "Overlay access invalid.",
    unknown_api_route: "Unknown API route.",
  },
};

/**
 * Looks a server error code up in `apiErrorTexts`. Falls back to the
 * caller's own generic text -- never to raw server text -- for a code an
 * old worker, a proxy's HTML error page, or a network failure didn't give
 * us, or gave us one this build doesn't know.
 */
export const apiErrorText = (
  code: string | null,
  fallback: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const catalog: Record<string, string> = apiErrorTexts[language];
  return (code !== null ? catalog[code] : undefined) ?? fallback;
};

/**
 * DE/EN text for the known-closed subset of `reason` codes written to
 * `bot_identity_status`/`twitch_login_identity`/`eventsub_subscriptions` by
 * `bot-maintenance.ts`/`login-maintenance.ts`/`eventsub-subscriptions.ts`.
 * Unlike `apiErrorTexts`, this isn't a closed union: Twitch's own error
 * body can pass its own code straight through (`error.code ?? fallbackCode`
 * in `bot-maintenance.ts`'s `maintenanceErrorDetails`), so an unrecognized
 * code falls back to showing itself -- it's already an English identifier,
 * never German prose, so that's safe.
 */
const maintenanceReasonTexts: LocaleCatalog<Record<string, string>> = {
  de: {
    timeout: "Zeitüberschreitung",
    network_error: "Netzwerkfehler",
    invalid_response: "Ungültige Antwort",
    invalid_target: "Unbekanntes Ziel",
    pagination_loop: "Wiederholte Seitenblätterung",
    maintenance_failed: "Wartung fehlgeschlagen",
    moderator_status_failed: "Moderatorstatus-Prüfung fehlgeschlagen",
    channel_or_consent_missing: "Kanal oder Zustimmung fehlt",
    token_ciphertext_unreadable: "Token nicht lesbar",
  },
  en: {
    timeout: "Timeout",
    network_error: "Network error",
    invalid_response: "Invalid response",
    invalid_target: "Unknown target",
    pagination_loop: "Repeated pagination",
    maintenance_failed: "Maintenance failed",
    moderator_status_failed: "Moderator status check failed",
    channel_or_consent_missing: "Channel or consent missing",
    token_ciphertext_unreadable: "Token unreadable",
  },
};

export const maintenanceReasonText = (
  code: string | null | undefined,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  if (code === null || code === undefined) return null;
  const catalog: Record<string, string> = maintenanceReasonTexts[language];
  return catalog[code] ?? code;
};

export const dashboardTexts = (): DashboardTexts => dashboardTextsCatalog[dashboardLanguage()];

export const formatDashboardDate = (
  value: string,
  options: Intl.DateTimeFormatOptions,
): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(dashboardLanguage(), options).format(date);
};

export const formatDate = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium" });

export const formatTimestamp = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium", timeStyle: "short" });

export const formatNumber = (value: number): string =>
  new Intl.NumberFormat(dashboardLanguage()).format(value);
