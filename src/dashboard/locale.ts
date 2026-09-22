import type { ChannelRole, EventTone } from "../contracts/values";
import { browserModuleLanguage, type ModuleLanguage } from "../modules/contract";

export type DashboardLanguage = ModuleLanguage;
export type LocaleCatalog<T> = Record<DashboardLanguage, T>;

export interface DashboardCommonTexts {
  abbrechen: string;
  schliessen: string;
  save: string;
  rollen: Record<ChannelRole, string>;
}

const commonTexts: LocaleCatalog<DashboardCommonTexts> = {
  de: {
    abbrechen: "Abbrechen",
    schliessen: "Schließen",
    save: "Speichern",
    rollen: {
      broadcaster: "Broadcaster",
      manager: "Verwalter",
      operator: "Bediener",
    },
  },
  en: {
    abbrechen: "Cancel",
    schliessen: "Close",
    save: "Save",
    rollen: {
      broadcaster: "Broadcaster",
      manager: "Manager",
      operator: "Operator",
    },
  },
};

/**
 * Die Sprache des Panels, abgeleitet aus dem Browser (Entscheidung 0007).
 * Dies ist die einzige Stelle, die sie bestimmt — eine spätere bewusste
 * Sprachwahl je Nutzer ersetzt nur diese Funktion.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const dashboardCommonTexts = (): DashboardCommonTexts => commonTexts[dashboardLanguage()];

export interface DashboardTexts {
  kopf: {
    verbindungLaeuft: string;
    verbindungWartet: string;
    verbindungGestort: string;
    channelIdentity: string;
    keineVerbindung: string;
    schalterAn: string;
    schalterAus: string;
  };
  status: {
    verbunden: string;
    widerrufen: string;
    fehler: string;
    loginIdentitaetFehlt: string;
    nichtGeprueft: string;
    abgelaufen: string;
    wartungUeberfaellig: string;
    erneuerungUeberfaellig: string;
    gueltig: string;
    moderatorrolleFehlt: string;
    chatAboFehler: string;
    chatAboWiderrufen: string;
    botFehler: string;
    botTokenWiderrufen: string;
    broadcasterConsentMissing: string;
    chatAboFehlt: string;
    gesund: string;
    stateIncomplete: string;
    nichtVerbunden: string;
    nichtEingerichtet: string;
    moderator: string;
    missing: string;
    aktiv: string;
    ausstehend: string;
    nichtErforderlich: string;
    vorhanden: string;
    botBerechtigungenFehlen: (count: string) => string;
  };
  navigation: {
    hauptnavigation: string;
    brotkrume: string;
    uebersicht: string;
    channel: string;
    system: string;
    members: string;
    module: string;
    ereignisse: string;
    selectChannel: string;
    selectModule: string;
    twitchAnmelden: string;
    twitchKonto: string;
    abmeldungLaeuft: string;
    abmelden: string;
  };
  overview: {
    einKanalFreigegeben: string;
    kanaeleFreigegeben: (count: string) => string;
    kanaeleFreigegebenKurz: (count: string) => string;
    keinKanalFreigegeben: string;
    keineMitgliedschaft: string;
    aktiveModule: string;
    loadState: string;
  };
  moderation: {
    fuerKanalKeinePruefung: string;
    letztePruefung: (timestamp: string) => string;
    checkRunning: string;
    moderatorstatusPruefen: string;
    naechstePruefungAb: (timestamp: string) => string;
    checkLocked: string;
    broadcasterErneutAutorisieren: string;
    broadcasterZustimmungAnfordern: string;
  };
  bot: {
    keinGespeicherterStatus: string;
    zuletztAktualisiert: (timestamp: string) => string;
    optionaleModule: string;
    normalerBetrieb: string;
    channelBotNoetig: string;
    botBerechtigungenBetreiber: string;
    botBerechtigungenVollstaendig: string;
  };
  fehler: {
    titel: string;
    warnung: string;
    sessionInvalid: string;
    datenLaden: string;
    letzter: string;
    keineUrsache: string;
    channelNotReleased: string;
  };
  statusKarte: {
    deineRolle: string;
    broadcasterOauth: string;
    chatZustimmung: string;
    botAccount: string;
    botBerechtigungen: string;
    moderatorstatus: string;
    chatAbo: string;
    tokenZustand: string;
    broadcasterConsentMissing: string;
    broadcastErklaerung: string;
    keinBotStatus: string;
    chatBotNoetig: string;
  };
  time: {
    aktualisiert: (relativeZeit: string) => string;
    vorSekunden: (count: number) => string;
    vorMinuten: (count: number) => string;
    vorStunden: (count: number) => string;
  };
  system: {
    titel: string;
    nurLesend: string;
    loadState: string;
    eigenschaften: string;
    botGrund: string;
    botAktualisiert: string;
    chatAboId: string;
    chatAboGrund: string;
    chatAboAktualisiert: string;
    loginStatus: string;
    loginGrund: string;
    loginGueltigBis: string;
    botGueltigBis: string;
    auditLog: string;
    eintraege: string;
    time: string;
    action: string;
    wer: string;
    loadAudit: string;
    keineAuditEintraege: string;
    aenderungsdaten: string;
    vorher: string;
    nachher: string;
    aeltereEintraege: string;
    aeltereEintraegeLaden: string;
    abonnements: string;
    keineAbonnements: string;
    abo: string;
    state: string;
    reason: string;
    aboInspector: string;
    aboTyp: string;
    aboVersion: string;
    aboId: string;
    aboAktualisiert: string;
    twitchMeldung: string;
    httpStatus: string;
    botBerechtigungenInspector: string;
    fehlendeScopes: string;
  };
  ereignisse: {
    titel: string;
    count: (count: string) => string;
    protokoll: string;
    time: string;
    ereignis: string;
    module: string;
    wer: string;
    automatic: string;
    info: string;
    fehler: string;
    hinweis: string;
    unbekannt: string;
    code: string;
    timestamp: string;
    vorgang: string;
    beteiligte: string;
    verlauf: string;
    load: string;
    keine: string;
    detail: string;
    aeltereLaden: string;
    aeltereWerdenGeladen: string;
    filter: string;
    origin: string;
    moduleFilter: string;
    tone: string;
    person: string;
    alle: string;
    channelEvents: string;
    moduleDiagnostics: string;
    aktiveFilter: string;
    filterZuruecksetzen: string;
    keineTreffer: string;
    nachladenAmEnde: string;
    feedEnde: string;
    realtimeVerbindet: string;
    realtimeVerbunden: string;
    realtimeWiederverbindung: string;
    realtimeOffline: string;
    realtimeSitzungErneuern: string;
    realtimeNeue: (count: string) => string;
  };
  anmeldung: {
    erforderlich: string;
    erklaerung: string;
    mitTwitchAnmelden: string;
    checkChannelAccess: string;
    loadMembers: string;
  };
  module: {
    module: string;
    verfuegbar: string;
    load: string;
    registriert: string;
    aktiv: string;
    inaktiv: string;
    aktivieren: string;
    deaktivieren: string;
    moduleList: string;
    moduleOverview: string;
    verwaltungGesperrt: string;
    keineAktiv: string;
    keineAnsicht: string;
    ansichten: string;
    ansichtenLaden: string;
    nichtAktiv: (name: string) => string;
    unbekannt: (name: string) => string;
    scopesFehlen: (name: string) => string;
    scopeZustimmungAnfordern: string;
    scopeZustimmungGesperrt: string;
    scopeListe: string;
    scopeFehlt: string;
    scopeErteilt: string;
  };
}

const dashboardTextsCatalog: LocaleCatalog<DashboardTexts> = {
  de: {
    kopf: {
      verbindungLaeuft: "Läuft",
      verbindungWartet: "Wartet",
      verbindungGestort: "Gestört",
      channelIdentity: "Kanal",
      keineVerbindung: "Keine Verbindung",
      schalterAn: "An",
      schalterAus: "Aus",
    },
    status: {
      verbunden: "Verbunden", widerrufen: "Widerrufen", fehler: "Fehler",
      loginIdentitaetFehlt: "Login-Identität fehlt", nichtGeprueft: "Nicht geprüft", abgelaufen: "Abgelaufen",
      wartungUeberfaellig: "Wartung überfällig", erneuerungUeberfaellig: "Erneuerung überfällig", gueltig: "Gültig",
      moderatorrolleFehlt: "Moderatorrolle fehlt", chatAboFehler: "Chat-Abo-Fehler", chatAboWiderrufen: "Chat-Abo widerrufen",
      botFehler: "Bot-Fehler", botTokenWiderrufen: "Bot-Token widerrufen", broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt",
      chatAboFehlt: "Chat-Abo fehlt", gesund: "Gesund", stateIncomplete: "Zustand unvollständig",
      nichtVerbunden: "Nicht verbunden", nichtEingerichtet: "Nicht eingerichtet", moderator: "Moderator", missing: "Fehlt",
      aktiv: "Aktiv", ausstehend: "Ausstehend", nichtErforderlich: "Nicht erforderlich", vorhanden: "Vorhanden",
      botBerechtigungenFehlen: (count) => `${count} fehlen`,
    },
    navigation: {
      hauptnavigation: "Hauptnavigation", brotkrume: "Brotkrume", uebersicht: "Übersicht", channel: "Kanal", system: "System",
      members: "Mitglieder", module: "Module", ereignisse: "Ereignisse", selectChannel: "Kanal auswählen",
      selectModule: "Modul auswählen",
      twitchAnmelden: "Mit Twitch anmelden", twitchKonto: "Twitch-Konto",
      abmeldungLaeuft: "Abmeldung …", abmelden: "Abmelden",
    },
    overview: {
      einKanalFreigegeben: "1 Kanal freigegeben",
      kanaeleFreigegeben: (count) => `${count} Kanäle sind für dich freigegeben.`,
      kanaeleFreigegebenKurz: (count) => `${count} Kanäle freigegeben`,
      keinKanalFreigegeben: "Noch kein Kanal freigegeben",
      keineMitgliedschaft: "Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.",
      aktiveModule: "Aktive Module", loadState: "Kanalzustand wird geladen …",
    },
    moderation: {
      fuerKanalKeinePruefung: "Für diesen Kanal liegt noch keine Prüfung vor.",
      letztePruefung: (timestamp) => `Letzte Prüfung: ${timestamp}`,
      checkRunning: "Prüfung läuft …", moderatorstatusPruefen: "Moderatorstatus prüfen",
      naechstePruefungAb: (timestamp) => `Nächste Prüfung ab ${timestamp}.`,
      checkLocked: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
      broadcasterErneutAutorisieren: "Der Broadcaster muss Twitch erneut autorisieren.",
      broadcasterZustimmungAnfordern: "Broadcaster-Zustimmung anfordern",
    },
    bot: {
      keinGespeicherterStatus: "Es gibt noch keinen gespeicherten Botstatus.",
      zuletztAktualisiert: (timestamp) => `Zuletzt aktualisiert: ${timestamp}`,
      optionaleModule: "Für optionale Broadcaster-Module verbunden.",
      normalerBetrieb: "Optional; für den normalen Bot-Betrieb nicht erforderlich.",
      channelBotNoetig: "channel:bot wird vom Broadcaster benötigt.",
      botBerechtigungenBetreiber: "Der Betreiber muss die Anwendung neu autorisieren.",
      botBerechtigungenVollstaendig: "Alle angeforderten Bot-Berechtigungen sind vorhanden.",
    },
    fehler: {
      titel: "Fehler", warnung: "Warnung", sessionInvalid: "Deine Sitzung ist nicht mehr gültig.",
      datenLaden: "Die Daten konnten nicht geladen werden.", letzter: "Letzter Fehler",
      keineUrsache: "Keine gespeicherte Ursache", channelNotReleased: "Dieser Kanal ist für dein Konto nicht freigegeben.",
    },
    statusKarte: {
      deineRolle: "Deine Rolle", broadcasterOauth: "Broadcaster-OAuth", chatZustimmung: "Chat-Zustimmung",
      botAccount: "Bot-Account", botBerechtigungen: "Bot-Berechtigungen", moderatorstatus: "Moderatorstatus", chatAbo: "Chat-Abo", tokenZustand: "Token-Zustand",
      broadcasterConsentMissing: "Broadcaster-Zustimmung fehlt", broadcastErklaerung: "Für optionale Broadcaster-Module verbunden.",
      keinBotStatus: "Es gibt noch keinen gespeicherten Botstatus.", chatBotNoetig: "channel:bot wird vom Broadcaster benötigt.",
    },
    time: {
      aktualisiert: (relativeZeit) => `aktualisiert ${relativeZeit}`, vorSekunden: (count) => `vor ${String(count)} s`,
      vorMinuten: (count) => `vor ${String(count)} Min.`, vorStunden: (count) => `vor ${String(count)} Std.`,
    },
    system: {
      titel: "System", nurLesend: "nur lesend", loadState: "Systemzustand wird geladen …", eigenschaften: "Eigenschaften",
      botGrund: "Bot-Grund", botAktualisiert: "Bot zuletzt aktualisiert", chatAboId: "Chat-Abo-ID", chatAboGrund: "Chat-Abo-Grund",
      chatAboAktualisiert: "Chat-Abo zuletzt aktualisiert", loginStatus: "Login-Token-Status", loginGrund: "Login-Token-Grund",
      loginGueltigBis: "Login-Token gültig bis", botGueltigBis: "Bot-Token gültig bis", auditLog: "Audit-Log",
      eintraege: "Einträge", time: "Zeit", action: "Aktion", wer: "Wer", loadAudit: "Audit-Log wird geladen …",
      keineAuditEintraege: "Noch keine Audit-Einträge gespeichert.", aenderungsdaten: "Änderungsdaten",
      vorher: "Vorher", nachher: "Nachher", aeltereEintraege: "Ältere Einträge laden",
      aeltereEintraegeLaden: "Ältere Einträge werden geladen …",
      abonnements: "Abonnements", keineAbonnements: "Keine Abonnements gespeichert.", abo: "Abo", state: "Zustand", reason: "Grund",
      aboInspector: "Abo-Details", aboTyp: "Roher Typ", aboVersion: "Version", aboId: "Abo-ID", aboAktualisiert: "Zuletzt geändert",
      twitchMeldung: "Twitch-Meldung", httpStatus: "HTTP-Status", botBerechtigungenInspector: "Fehlende Bot-Berechtigungen", fehlendeScopes: "Fehlende Scopes",
    },
    ereignisse: {
      titel: "Ereignisse", count: (count) => `${count} Einträge`, protokoll: "Ereignisprotokoll", time: "Zeit", ereignis: "Ereignis",
      module: "Modul", wer: "Wer", automatic: "Automatisch", info: "Info", fehler: "Fehler", hinweis: "Hinweis", unbekannt: "Unbekannt", code: "Code", timestamp: "Zeitstempel", vorgang: "Vorgang", beteiligte: "Beteiligte", verlauf: "Verlauf",
      load: "Ereignisse werden geladen …",
      keine: "Noch keine Ereignisse protokolliert.", detail: "Detail", aeltereLaden: "Ältere Ereignisse laden", aeltereWerdenGeladen: "Ältere Ereignisse werden geladen …",
      filter: "Filter", origin: "Herkunft", moduleFilter: "Modul", tone: "Ton", person: "Person", alle: "Alle",
      channelEvents: "Kanalereignisse", moduleDiagnostics: "Moduldiagnosen", aktiveFilter: "Aktive Filter:", filterZuruecksetzen: "Filter zurücksetzen",
      keineTreffer: "Keine Ereignisse passen zu den Filtern.", nachladenAmEnde: "Am Ende werden ältere Ereignisse nachgeladen.",
      feedEnde: "Ende des Ereignisverlaufs erreicht.",
      realtimeVerbindet: "Verbindet …", realtimeVerbunden: "Verbunden", realtimeWiederverbindung: "Verbindet neu …",
      realtimeOffline: "Offline", realtimeSitzungErneuern: "Sitzung erneuern", realtimeNeue: (count) => `${count} neue Ereignisse`,
    },
    anmeldung: {
      erforderlich: "Anmeldung erforderlich", erklaerung: "Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.",
      mitTwitchAnmelden: "Mit Twitch anmelden", checkChannelAccess: "Kanalzugriff wird geprüft …", loadMembers: "Mitglieder werden geladen …",
    },
    module: {
      module: "Modul", verfuegbar: "Verfügbare Module", load: "Module werden geladen …",
      registriert: "Für diesen Bot ist noch kein Modul registriert.", aktiv: "Aktiv", inaktiv: "Inaktiv",
      aktivieren: "aktivieren", deaktivieren: "deaktivieren", moduleList: "Modulliste",
      moduleOverview: "Modulübersicht",
      verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Module ändern.", keineAktiv: "Keine Module aktiv.",
      keineAnsicht: "Für dieses aktive Modul gibt es noch keine Panel-Ansicht.", ansichten: "Modulansichten",
      ansichtenLaden: "Modulansichten werden geladen …",
      nichtAktiv: (name) => `Das Modul „${name}“ ist in diesem Kanal nicht aktiv.`,
      scopesFehlen: (name) => `Das Modul „${name}“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.`,
      scopeZustimmungAnfordern: "Broadcaster-Berechtigungen erteilen",
      scopeZustimmungGesperrt: "Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.",
      scopeListe: "Benötigte Broadcaster-Berechtigungen",
      scopeFehlt: "Fehlt",
      scopeErteilt: "Erteilt",
      unbekannt: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    },
  },
  en: {
    kopf: {
      verbindungLaeuft: "Running",
      verbindungWartet: "Waiting",
      verbindungGestort: "Interrupted",
      channelIdentity: "Channel",
      keineVerbindung: "No connection",
      schalterAn: "On",
      schalterAus: "Off",
    },
    status: {
      verbunden: "Connected", widerrufen: "Revoked", fehler: "Error", loginIdentitaetFehlt: "Login identity missing",
      nichtGeprueft: "Not checked", abgelaufen: "Expired", wartungUeberfaellig: "Maintenance overdue",
      erneuerungUeberfaellig: "Renewal overdue", gueltig: "Valid", moderatorrolleFehlt: "Moderator role missing",
      chatAboFehler: "Chat subscription error", chatAboWiderrufen: "Chat subscription revoked", botFehler: "Bot error",
      botTokenWiderrufen: "Bot token revoked", broadcasterConsentMissing: "Broadcaster consent missing",
      chatAboFehlt: "Chat subscription missing", gesund: "Healthy", stateIncomplete: "Incomplete status",
      nichtVerbunden: "Not connected", nichtEingerichtet: "Not set up", moderator: "Moderator", missing: "Missing", aktiv: "Active",
      ausstehend: "Pending", nichtErforderlich: "Not required", vorhanden: "Present",
      botBerechtigungenFehlen: (count) => `${count} missing`,
    },
    navigation: {
      hauptnavigation: "Main navigation", brotkrume: "Breadcrumb", uebersicht: "Overview", channel: "Channel", system: "System",
      members: "Members", module: "Modules", ereignisse: "Events", selectChannel: "Select channel",
      selectModule: "Select module",
      twitchAnmelden: "Sign in with Twitch", twitchKonto: "Twitch account",
      abmeldungLaeuft: "Signing out …", abmelden: "Sign out",
    },
    overview: {
      einKanalFreigegeben: "1 channel available",
      kanaeleFreigegeben: (count) => `${count} channels are available to you.`,
      kanaeleFreigegebenKurz: (count) => `${count} channels available`,
      keinKanalFreigegeben: "No channel available yet", keineMitgliedschaft: "This account is not a member of an available channel.",
      aktiveModule: "Active modules", loadState: "Loading channel status …",
    },
    moderation: {
      fuerKanalKeinePruefung: "This channel has not been checked yet.", letztePruefung: (timestamp) => `Last checked: ${timestamp}`,
      checkRunning: "Checking …", moderatorstatusPruefen: "Check moderator status",
      naechstePruefungAb: (timestamp) => `Next check available ${timestamp}.`,
      checkLocked: "Only broadcasters and managers may check moderator status.",
      broadcasterErneutAutorisieren: "The broadcaster must authorize Twitch again.", broadcasterZustimmungAnfordern: "Request broadcaster consent",
    },
    bot: {
      keinGespeicherterStatus: "No bot status has been saved yet.", zuletztAktualisiert: (timestamp) => `Last updated: ${timestamp}`,
      optionaleModule: "Connected for optional broadcaster modules.", normalerBetrieb: "Optional; not required for normal bot operation.",
      channelBotNoetig: "channel:bot is required from the broadcaster.",
      botBerechtigungenBetreiber: "The operator must authorize the application again.",
      botBerechtigungenVollstaendig: "All requested bot permissions are present.",
    },
    fehler: {
      titel: "Error", warnung: "Warning", sessionInvalid: "Your session is no longer valid.", datenLaden: "The data could not be loaded.",
      letzter: "Last error", keineUrsache: "No saved cause", channelNotReleased: "This channel is not available to your account.",
    },
    statusKarte: {
      deineRolle: "Your role", broadcasterOauth: "Broadcaster OAuth", chatZustimmung: "Chat consent", botAccount: "Bot account", botBerechtigungen: "Bot permissions",
      moderatorstatus: "Moderator status", chatAbo: "Chat subscription", tokenZustand: "Token status",
      broadcasterConsentMissing: "Broadcaster consent missing", broadcastErklaerung: "Connected for optional broadcaster modules.",
      keinBotStatus: "No bot status has been saved yet.", chatBotNoetig: "channel:bot is required from the broadcaster.",
    },
    time: {
      aktualisiert: (relativeZeit) => `updated ${relativeZeit}`, vorSekunden: (count) => `${String(count)} sec ago`,
      vorMinuten: (count) => `${String(count)} min ago`, vorStunden: (count) => `${String(count)} hr ago`,
    },
    system: {
      titel: "System", nurLesend: "read-only", loadState: "Loading system status …", eigenschaften: "Properties",
      botGrund: "Bot reason", botAktualisiert: "Bot last updated", chatAboId: "Chat subscription ID", chatAboGrund: "Chat subscription reason",
      chatAboAktualisiert: "Chat subscription last updated", loginStatus: "Login token status", loginGrund: "Login token reason",
      loginGueltigBis: "Login token valid until", botGueltigBis: "Bot token valid until", auditLog: "Audit log", eintraege: "entries",
      time: "Time", action: "Action", wer: "Who",
      loadAudit: "Loading audit log …", keineAuditEintraege: "No audit entries saved yet.", aenderungsdaten: "Change data",
      vorher: "Before", nachher: "After", aeltereEintraege: "Load older entries", aeltereEintraegeLaden: "Loading older entries …",
      abonnements: "Subscriptions", keineAbonnements: "No subscriptions saved.", abo: "Subscription", state: "State", reason: "Reason",
      aboInspector: "Subscription details", aboTyp: "Raw type", aboVersion: "Version", aboId: "Subscription ID", aboAktualisiert: "Last changed",
      twitchMeldung: "Twitch message", httpStatus: "HTTP status", botBerechtigungenInspector: "Missing bot permissions", fehlendeScopes: "Missing scopes",
    },
    ereignisse: {
      titel: "Events", count: (count) => `${count} entries`, protokoll: "Event log", time: "Time", ereignis: "Event", module: "Module",
      wer: "Who", automatic: "Automatic", info: "Info", fehler: "Error", hinweis: "Notice", unbekannt: "Unknown", code: "Code", timestamp: "Timestamp", vorgang: "Operation", beteiligte: "Participants", verlauf: "History", load: "Loading events …", keine: "No events logged yet.", detail: "Detail",
      aeltereLaden: "Load older events", aeltereWerdenGeladen: "Loading older events …",
      filter: "Filters", origin: "Origin", moduleFilter: "Module", tone: "Tone", person: "Person", alle: "All",
      channelEvents: "Channel events", moduleDiagnostics: "Module diagnostics", aktiveFilter: "Active filters:", filterZuruecksetzen: "Reset filters",
      keineTreffer: "No events match the filters.", nachladenAmEnde: "Older events load at the end.",
      feedEnde: "End of the event history reached.",
      realtimeVerbindet: "Connecting …", realtimeVerbunden: "Connected", realtimeWiederverbindung: "Reconnecting …",
      realtimeOffline: "Offline", realtimeSitzungErneuern: "Renew session", realtimeNeue: (count) => `${count} new events`,
    },
    anmeldung: {
      erforderlich: "Sign-in required", erklaerung: "Sign in with your Twitch account to see available channels.",
      mitTwitchAnmelden: "Sign in with Twitch", checkChannelAccess: "Checking channel access …", loadMembers: "Loading members …",
    },
    module: {
      module: "Module", verfuegbar: "Available modules", load: "Loading modules …", registriert: "No module is registered for this bot yet.",
      aktiv: "Active", inaktiv: "Inactive", aktivieren: "enable", deaktivieren: "disable", moduleList: "Module list",
      moduleOverview: "Module overview",
      verwaltungGesperrt: "Only broadcasters and managers may change modules.", keineAktiv: "No modules active.",
      keineAnsicht: "This active module does not have a panel view yet.", ansichten: "Module views", ansichtenLaden: "Loading module views …",
      nichtAktiv: (name) => `The module “${name}” is not active in this channel.`,
      unbekannt: (name) => `The module “${name}” is unknown.`,
      scopesFehlen: (name) => `The module “${name}” is disabled because broadcaster permissions are missing.`,
      scopeZustimmungAnfordern: "Grant broadcaster permissions",
      scopeZustimmungGesperrt: "Only this channel’s broadcaster may grant this consent.",
      scopeListe: "Required broadcaster permissions",
      scopeFehlt: "Missing",
      scopeErteilt: "Granted",
    },
  },
};

export type EventCode =
  | "host.aktion.fehler"
  | "host.chat.fehlgeschlagen"
  | "host.chat.gesendet"
  | "host.modul.fehler"
  | "host.modul.unbekannt"
  | "host.overlay.nicht_ausgefuehrt"
  | "host.shoutout.fehlgeschlagen"
  | "host.shoutout.gesendet"
  | "channel_events.raid.incoming"
  | "channel_events.raid.outgoing"
  | "channel_events.shoutout.gesendet"
  | "channel_events.shoutout.empfangen"
  | "channel_events.chat.sub"
  | "channel_events.chat.resub"
  | "channel_events.chat.gift_sub"
  | "channel_events.chat.community_gift"
  | "channel_events.chat.ankuendigung"
  | "channel_events.chat.unbekannt"
  | "channel_events.moderation.ban"
  | "channel_events.moderation.timeout"
  | "channel_events.moderation.untimeout"
  | "channel_events.moderation.unban"
  | "channel_events.moderation.delete"
  | "channel_events.moderation.warn"
  | "channel_events.moderation.unbekannt"
  | "channel_events.automod.halte"
  | "channel_events.verdacht.nachricht"
  | "channel_events.verdacht.einstufung"
  | "channel_events.verdacht.entwarnung"
  | "raid.outgoing"
  | "raid.shoutout"
  | "raid.ungueltig"
  | "shoutout.unterdrueckt"
  | "ads.ankuendigung"
  | "ads.uebersprungen"
  | "ads.vorwarnung.angekuendigt"
  | "ads.vorwarnung.kein_termin"
  | "ads.vorwarnung.zu_spaet"
  | "ads.vorwarnung.pause_begonnen"
  | "ads.vorwarnung.termin_verschoben"
  | "ads.vorwarnung.scope_fehlt"
  | "ads.vorwarnung.zeitplan_fehler"
  | "ads.snooze"
  | "text_commands.abgekuehlt"
  | "text_commands.ausgeloest"
  | "text_commands.deaktiviert"
  | "text_commands.berechtigung"
  // Seit dem Wegfall der ändernden Chat-Befehle (#120) erzeugt niemand mehr
  // diese beiden Kennungen. Sie bleiben, weil das Ereignisprotokoll seine
  // Zeilen 14 Tage hält: Ohne Beschriftung wären bereits geschriebene
  // Einträge im Panel nicht mehr lesbar.
  | "text_commands.bereits_vorhanden"
  | "text_commands.nicht_berechtigt"
  | "text_commands.unbekannt"
  | "text_commands.ungueltig";

export type EventDetail = Readonly<Record<string, unknown>>;
export type EventText = string | ((detail: EventDetail) => string);

const textCommandName = (detail: EventDetail): string | null =>
  typeof detail.name === "string" && detail.name.length > 0 ? detail.name : null;

const eventTextWithName = (
  detail: EventDetail,
  ohneName: string,
  mitName: (name: string) => string,
): string => {
  const name = textCommandName(detail);
  return name === null ? ohneName : mitName(name);
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

const detailZahl = (detail: EventDetail, key: string, fallback: string): string =>
  typeof detail[key] === "number" && Number.isFinite(detail[key]) ? String(detail[key]) : fallback;

const detailDauer = (detail: EventDetail, einheit: string, fallback: string): string =>
  typeof detail.duration === "number" && Number.isFinite(detail.duration) ? `${String(detail.duration)} ${einheit}` : fallback;

const detailReason = (detail: EventDetail): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? `: ${detail.reason}`
    : "";

const detailReasonWith = (detail: EventDetail, praeposition: string): string =>
  typeof detail.reason === "string" && detail.reason.length > 0
    ? ` ${praeposition} ${detail.reason}`
    : "";

const detailEinstufung = (detail: EventDetail, fallback: string): string =>
  typeof detail.einstufung === "string" && detail.einstufung.length > 0 ? detail.einstufung : fallback;

const detailModerator = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` von ${detail.moderator}` : fallback;

const detailModeratorEn = (detail: EventDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` by ${detail.moderator}` : fallback;

export const eventTexts: LocaleCatalog<Record<EventCode, EventText>> = {
  de: {
    "host.aktion.fehler": "Aktion fehlgeschlagen",
    "host.chat.fehlgeschlagen": "Chat-Nachricht fehlgeschlagen",
    "host.chat.gesendet": "Chat-Nachricht gesendet",
    "host.modul.fehler": "Modulfehler",
    "host.modul.unbekannt": "Unbekanntes Modul",
    "host.overlay.nicht_ausgefuehrt": "Overlay nicht ausgeführt",
    "host.shoutout.fehlgeschlagen": "Shoutout fehlgeschlagen",
    "host.shoutout.gesendet": "Shoutout gesendet",
    "channel_events.raid.incoming": (detail) => `Raid von ${detailText(detail, "source", "unbekannt")} mit ${detailZahl(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.raid.outgoing": (detail) => `Raid zu ${detailText(detail, "target", "unbekannt")} mit ${detailZahl(detail, "viewers", "unbekannter Anzahl")} Zuschauern`,
    "channel_events.shoutout.gesendet": (detail) => `Shoutout an ${detailText(detail, "target", "unbekannt")}`,
    "channel_events.shoutout.empfangen": (detail) => `Shoutout von ${detailText(detail, "source", "unbekannt")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` mit ${String(detail.viewers)} Zuschauern` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.resub": (detail) => `Resub von ${detailText(detail, "person", "unbekannt")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift-Sub von ${detailText(detail, "gifter", "unbekannt")} an ${detailText(detail, "recipient", "unbekannt")}`,
    "channel_events.chat.community_gift": (detail) => `Community-Gift von ${detailText(detail, "gifter", "unbekannt")} für ${detailZahl(detail, "count", "unbekannte Anzahl")} Subs`,
    "channel_events.chat.ankuendigung": (detail) => `Ankündigung von ${detailText(detail, "person", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.chat.unbekannt": (detail) => `Unbekannte Chat-Benachrichtigung: ${detailText(detail, "art", "unbekannt")}`,
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unbekannt")} gebannt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unbekannt")} für ${detailDauer(detail, "Sekunden", "unbekannte Dauer")} getimeoutet von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unbekannt")} aus dem Timeout genommen von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unbekannt")} entbannt von ${detailText(detail, "moderator", "unbekannt")}`,
    "channel_events.moderation.delete": (detail) => `Nachricht von ${detailText(detail, "person", "unbekannt")} gelöscht von ${detailText(detail, "moderator", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unbekannt")} verwarnt von ${detailText(detail, "moderator", "unbekannt")}${detailReason(detail)}`,
    "channel_events.moderation.unbekannt": (detail) => `Unbekannte Moderationsaktion: ${detailText(detail, "action", "unbekannt")}`,
    "channel_events.automod.halte": (detail) => `AutoMod hielt die Nachricht von ${detailText(detail, "person", "unbekannt")}${detailReasonWith(detail, "wegen")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.verdacht.nachricht": (detail) => `Nachricht von auffälligem Nutzer ${detailText(detail, "person", "unbekannt")} (${detailEinstufung(detail, "unbekannte Einstufung")}): ${detailText(detail, "text", "ohne Text")}`,
    "channel_events.verdacht.einstufung": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} verschärft${detailModerator(detail, "")}: ${detailEinstufung(detail, "unbekannt")}`,
    "channel_events.verdacht.entwarnung": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} aufgehoben${detailModerator(detail, "")}`,
    "raid.outgoing": (detail) => `Ausgehender Raid zu ${detailText(detail, "targetChannelId", "unbekannt")}`,
    "raid.shoutout": (detail) => `Raid über der Schwelle (${detailZahl(detail, "viewers", "unbekannt")} von ${detailZahl(detail, "threshold", "unbekannt")}): Shoutout und Chatzeile`,
    "raid.ungueltig": (detail) => `Raid verworfen: ${detailText(detail, "reason", "ungültige Daten")}`,
    "shoutout.unterdrueckt": (detail) => detail.reason === "abgeschaltet"
      ? "Shoutout abgeschaltet"
      : detail.reason === "unter_schwelle"
        ? `Shoutout unter der Schwelle (${detailZahl(detail, "viewers", "unbekannt")} von ${detailZahl(detail, "threshold", "unbekannt")} Zuschauern)`
        : "Shoutout unterdrückt",
    "ads.ankuendigung": (detail) => `Werbepause ${detail.automatic === true ? "automatisch" : "manuell"} gestartet: ${detailZahl(detail, "duration", "unbekannte Dauer")} Sekunden`,
    "ads.uebersprungen": (detail) => `Werbepause übersprungen: ${detail.reason === "dauer_null" ? "Dauer ist null" : "Ereignisdaten sind ungültig"}`,
    "ads.vorwarnung.angekuendigt": (detail) => `Vorwarnung: Werbung in ${detailZahl(detail, "sekunden", "unbekannter Zeit")} Sekunden`,
    "ads.vorwarnung.kein_termin": "Keine nächste Werbepause geplant",
    "ads.vorwarnung.zu_spaet": "Werbe-Vorwarnung unterdrückt: Termin zu nah",
    "ads.vorwarnung.pause_begonnen": "Werbe-Vorwarnung unterdrückt: Werbepause hat begonnen",
    "ads.vorwarnung.termin_verschoben": "Werbe-Vorwarnung unterdrückt: Termin wurde verschoben",
    "ads.vorwarnung.scope_fehlt": "Werbe-Vorwarnung unterdrückt: channel:read:ads fehlt",
    "ads.vorwarnung.zeitplan_fehler": (detail) => `Werbezeitplan nicht gelesen: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "ads.snooze": (detail) => detail.ausgang === "erfolgreich" ? "Nächste Werbepause verschoben" : `Snooze nicht ausgeführt: ${detailText(detail, "reason", "unbekannter Fehler")}`,
    "text_commands.abgekuehlt": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Textbefehl abgekühlt"
        : `Befehl !${name} abgekühlt, noch ${String(detail.remainingSeconds)} s`;
    },
    "text_commands.ausgeloest": (detail) => eventTextWithName(detail, "Befehl ausgeführt", (name) => `Befehl !${name} ausgeführt`),
    "text_commands.deaktiviert": (detail) => eventTextWithName(detail, "Textbefehl ausgeschaltet", (name) => `Textbefehl !${name} ausgeschaltet`),
    "text_commands.berechtigung": (detail) => eventTextWithName(detail, "Textbefehl nicht berechtigt", (name) => `Befehl !${name} nicht ausgelöst: Mindeststufe ${textCommandTier(detail, "requiredTier", "unbekannt", "de")}, vorhanden ${textCommandTier(detail, "currentTier", "kein Chat-Status", "de")}`),
    "text_commands.bereits_vorhanden": (detail) => eventTextWithName(detail, "Textbefehl bereits vorhanden", (name) => `Textbefehl !${name} bereits vorhanden`),
    "text_commands.nicht_berechtigt": "Textbefehl nicht berechtigt",
    "text_commands.unbekannt": (detail) => eventTextWithName(detail, "Textbefehl unbekannt", (name) => `Textbefehl !${name} unbekannt`),
    "text_commands.ungueltig": "Textbefehl ungültig",
  },
  en: {
    "host.aktion.fehler": "Action failed",
    "host.chat.fehlgeschlagen": "Chat message failed",
    "host.chat.gesendet": "Chat message sent",
    "host.modul.fehler": "Module error",
    "host.modul.unbekannt": "Unknown module",
    "host.overlay.nicht_ausgefuehrt": "Overlay not executed",
    "host.shoutout.fehlgeschlagen": "Shoutout failed",
    "host.shoutout.gesendet": "Shoutout sent",
    "channel_events.raid.incoming": (detail) => `Raid from ${detailText(detail, "source", "unknown")} with ${detailZahl(detail, "viewers", "unknown number")} viewers`,
    "channel_events.raid.outgoing": (detail) => `Raid to ${detailText(detail, "target", "unknown")} with ${detailZahl(detail, "viewers", "unknown number")} viewers`,
    "channel_events.shoutout.gesendet": (detail) => `Shoutout sent to ${detailText(detail, "target", "unknown")}`,
    "channel_events.shoutout.empfangen": (detail) => `Shoutout received from ${detailText(detail, "source", "unknown")}${typeof detail.viewers === "number" && Number.isFinite(detail.viewers) ? ` with ${String(detail.viewers)} viewers` : ""}`,
    "channel_events.chat.sub": (detail) => `Sub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.resub": (detail) => `Resub from ${detailText(detail, "person", "unknown")}`,
    "channel_events.chat.gift_sub": (detail) => `Gift sub from ${detailText(detail, "gifter", "unknown")} to ${detailText(detail, "recipient", "unknown")}`,
    "channel_events.chat.community_gift": (detail) => `Community gift from ${detailText(detail, "gifter", "unknown")} for ${detailZahl(detail, "count", "unknown number")} subs`,
    "channel_events.chat.ankuendigung": (detail) => `Announcement from ${detailText(detail, "person", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.chat.unbekannt": (detail) => `Unknown chat notification: ${detailText(detail, "art", "unknown")}`,
    "channel_events.moderation.ban": (detail) => `${detailText(detail, "person", "unknown")} banned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.timeout": (detail) => `${detailText(detail, "person", "unknown")} timed out for ${detailDauer(detail, "seconds", "unknown duration")} by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.untimeout": (detail) => `${detailText(detail, "person", "unknown")} removed from timeout by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.unban": (detail) => `${detailText(detail, "person", "unknown")} unbanned by ${detailText(detail, "moderator", "unknown")}`,
    "channel_events.moderation.delete": (detail) => `Message from ${detailText(detail, "person", "unknown")} deleted by ${detailText(detail, "moderator", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "channel_events.moderation.warn": (detail) => `${detailText(detail, "person", "unknown")} warned by ${detailText(detail, "moderator", "unknown")}${detailReason(detail)}`,
    "channel_events.moderation.unbekannt": (detail) => `Unknown moderation action: ${detailText(detail, "action", "unknown")}`,
    "channel_events.automod.halte": (detail) => `AutoMod held a message from ${detailText(detail, "person", "unknown")}${detailReasonWith(detail, "for")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "channel_events.verdacht.nachricht": (detail) => `Message from suspicious user ${detailText(detail, "person", "unknown")} (${detailEinstufung(detail, "unknown classification")}): ${detailText(detail, "text", "no text")}`,
    "channel_events.verdacht.einstufung": (detail) => `Classification for ${detailText(detail, "person", "unknown")} tightened${detailModeratorEn(detail, "")}: ${detailEinstufung(detail, "unknown")}`,
    "channel_events.verdacht.entwarnung": (detail) => `Classification for ${detailText(detail, "person", "unknown")} cleared${detailModeratorEn(detail, "")}`,
    "raid.outgoing": (detail) => `Outgoing raid to ${detailText(detail, "targetChannelId", "unknown")}`,
    "raid.shoutout": (detail) => `Raid above threshold (${detailZahl(detail, "viewers", "unknown")} of ${detailZahl(detail, "threshold", "unknown")}): shoutout and chat line`,
    "raid.ungueltig": (detail) => `Raid discarded: ${detailText(detail, "reason", "invalid data")}`,
    "shoutout.unterdrueckt": (detail) => detail.reason === "abgeschaltet"
      ? "Shoutout disabled"
      : detail.reason === "unter_schwelle"
        ? `Shoutout below threshold (${detailZahl(detail, "viewers", "unknown")} of ${detailZahl(detail, "threshold", "unknown")} viewers)`
        : "Shoutout suppressed",
    "ads.ankuendigung": (detail) => `Ad break ${detail.automatic === true ? "automatically" : "manually"} started: ${detailZahl(detail, "duration", "unknown duration")} seconds`,
    "ads.uebersprungen": (detail) => `Ad break skipped: ${detail.reason === "dauer_null" ? "duration is zero" : "event data is invalid"}`,
    "ads.vorwarnung.angekuendigt": (detail) => `Ad warning: ad in ${detailZahl(detail, "sekunden", "unknown time")} seconds`,
    "ads.vorwarnung.kein_termin": "No next ad break scheduled",
    "ads.vorwarnung.zu_spaet": "Ad warning suppressed: ad is too close",
    "ads.vorwarnung.pause_begonnen": "Ad warning suppressed: ad break has started",
    "ads.vorwarnung.termin_verschoben": "Ad warning suppressed: schedule changed",
    "ads.vorwarnung.scope_fehlt": "Ad warning suppressed: channel:read:ads is missing",
    "ads.vorwarnung.zeitplan_fehler": (detail) => `Ad schedule could not be read: ${detailText(detail, "reason", "unknown error")}`,
    "ads.snooze": (detail) => detail.ausgang === "erfolgreich" ? "Next ad break postponed" : `Snooze not executed: ${detailText(detail, "reason", "unknown error")}`,
    "text_commands.abgekuehlt": (detail) => {
      const name = textCommandName(detail);
      return name === null || typeof detail.remainingSeconds !== "number" || !Number.isFinite(detail.remainingSeconds)
        ? "Text command on cooldown"
        : `Command !${name} on cooldown, ${String(detail.remainingSeconds)}s left`;
    },
    "text_commands.ausgeloest": (detail) => eventTextWithName(detail, "Command executed", (name) => `Command !${name} executed`),
    "text_commands.deaktiviert": (detail) => eventTextWithName(detail, "Text command disabled", (name) => `Text command !${name} disabled`),
    "text_commands.berechtigung": (detail) => eventTextWithName(detail, "Text command not authorized", (name) => `Command !${name} not executed: minimum level ${textCommandTier(detail, "requiredTier", "unknown", "en")}, present ${textCommandTier(detail, "currentTier", "no chat status", "en")}`),
    "text_commands.bereits_vorhanden": (detail) => eventTextWithName(detail, "Text command already exists", (name) => `Text command !${name} already exists`),
    "text_commands.nicht_berechtigt": "Text command not authorized",
    "text_commands.unbekannt": (detail) => eventTextWithName(detail, "Unknown text command", (name) => `Unknown text command !${name}`),
    "text_commands.ungueltig": "Invalid text command",
  },
};

export type EventFamily = "gemeinschaft" | "raid" | "moderation" | "betrieb";
export type EventTier = "voll" | "gezeichnet";
export type EventNumberKey = "viewers" | "count" | "duration" | "remainingSeconds" | "tier" | null;
export interface EventToneEntry {
  familie: EventFamily;
  tier: EventTier;
  wort: LocaleCatalog<string>;
  zahlSchluessel: EventNumberKey;
  tone?: EventTone;
}

export const eventToneEntries: Record<EventCode, EventToneEntry> = {
  "host.aktion.fehler": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "host.chat.fehlgeschlagen": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "host.chat.gesendet": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info" },
  "host.modul.fehler": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "host.modul.unbekannt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "host.overlay.nicht_ausgefuehrt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "host.shoutout.fehlgeschlagen": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "host.shoutout.gesendet": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info" },
  "channel_events.raid.incoming": { familie: "raid", tier: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers" },
  "channel_events.raid.outgoing": { familie: "raid", tier: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers" },
  "channel_events.shoutout.gesendet": { familie: "raid", tier: "gezeichnet", wort: { de: "Shoutout", en: "Shoutout" }, zahlSchluessel: null },
  "channel_events.shoutout.empfangen": { familie: "raid", tier: "voll", wort: { de: "Shoutout", en: "Shoutout" }, zahlSchluessel: "viewers" },
  "channel_events.chat.sub": { familie: "gemeinschaft", tier: "voll", wort: { de: "Abo", en: "Sub" }, zahlSchluessel: "tier" },
  "channel_events.chat.resub": { familie: "gemeinschaft", tier: "voll", wort: { de: "Resub", en: "Resub" }, zahlSchluessel: "tier" },
  "channel_events.chat.gift_sub": { familie: "gemeinschaft", tier: "voll", wort: { de: "Gift-Sub", en: "Gift Sub" }, zahlSchluessel: "tier" },
  "channel_events.chat.community_gift": { familie: "gemeinschaft", tier: "voll", wort: { de: "Gift", en: "Gift" }, zahlSchluessel: "count" },
  "channel_events.chat.ankuendigung": { familie: "gemeinschaft", tier: "gezeichnet", wort: { de: "Ankündigung", en: "Announcement" }, zahlSchluessel: null },
  "channel_events.chat.unbekannt": { familie: "gemeinschaft", tier: "voll", wort: { de: "Unbekannt", en: "Unknown" }, zahlSchluessel: null },
  "channel_events.moderation.ban": { familie: "moderation", tier: "voll", wort: { de: "Bann", en: "Ban" }, zahlSchluessel: null },
  "channel_events.moderation.timeout": { familie: "moderation", tier: "voll", wort: { de: "Auszeit", en: "Timeout" }, zahlSchluessel: "duration" },
  "channel_events.moderation.untimeout": { familie: "moderation", tier: "gezeichnet", wort: { de: "Entsperrt", en: "Untimeout" }, zahlSchluessel: null },
  "channel_events.moderation.unban": { familie: "moderation", tier: "gezeichnet", wort: { de: "Entbannt", en: "Unbanned" }, zahlSchluessel: null },
  "channel_events.moderation.delete": { familie: "moderation", tier: "voll", wort: { de: "Gelöscht", en: "Deleted" }, zahlSchluessel: null },
  "channel_events.moderation.warn": { familie: "moderation", tier: "voll", wort: { de: "Verwarnung", en: "Warning" }, zahlSchluessel: null },
  "channel_events.moderation.unbekannt": { familie: "moderation", tier: "voll", wort: { de: "Unbekannt", en: "Unknown" }, zahlSchluessel: null },
  "channel_events.automod.halte": { familie: "moderation", tier: "voll", wort: { de: "AutoMod", en: "AutoMod" }, zahlSchluessel: null },
  "channel_events.verdacht.nachricht": { familie: "moderation", tier: "voll", wort: { de: "Verdacht", en: "Suspicious" }, zahlSchluessel: null },
  "channel_events.verdacht.einstufung": { familie: "moderation", tier: "voll", wort: { de: "Einstufung", en: "Classified" }, zahlSchluessel: null },
  "channel_events.verdacht.entwarnung": { familie: "moderation", tier: "gezeichnet", wort: { de: "Entwarnt", en: "Cleared" }, zahlSchluessel: null },
  "raid.outgoing": { familie: "raid", tier: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers", tone: "warning" },
  "raid.shoutout": { familie: "raid", tier: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers" },
  "raid.ungueltig": { familie: "raid", tier: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: null, tone: "warning" },
  "shoutout.unterdrueckt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.ankuendigung": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: "duration", tone: "info" },
  "ads.uebersprungen": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.angekuendigt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info" },
  "ads.vorwarnung.kein_termin": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.zu_spaet": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.pause_begonnen": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.termin_verschoben": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.scope_fehlt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "ads.vorwarnung.zeitplan_fehler": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, tone: "error" },
  "ads.snooze": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Snooze", en: "Snooze" }, zahlSchluessel: null, tone: "info" },
  "text_commands.abgekuehlt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: "remainingSeconds", tone: "warning" },
  "text_commands.ausgeloest": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info" },
  "text_commands.deaktiviert": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info" },
  "text_commands.berechtigung": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "text_commands.bereits_vorhanden": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "text_commands.nicht_berechtigt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "text_commands.unbekannt": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
  "text_commands.ungueltig": { familie: "betrieb", tier: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, tone: "warning" },
};

export function eventText(code: string, language?: DashboardLanguage): string;
export function eventText(code: string, detail: EventDetail, language?: DashboardLanguage): string;
export function eventText(
  code: string,
  detailOderSprache: EventDetail | DashboardLanguage = {},
  language?: DashboardLanguage,
): string {
  const detail = typeof detailOderSprache === "string" ? {} : detailOderSprache;
  const aufloesungsSprache = typeof detailOderSprache === "string"
    ? detailOderSprache
    : language ?? dashboardLanguage();
  if (Object.prototype.hasOwnProperty.call(eventTexts[aufloesungsSprache], code)) {
    const text = eventTexts[aufloesungsSprache][code as EventCode];
    return typeof text === "function" ? text(detail) : text;
  }
  return code;
}

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

export const formatDatum = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium" });

export const formatTimestamp = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium", timeStyle: "short" });

export const formatZahl = (value: number): string =>
  new Intl.NumberFormat(dashboardLanguage()).format(value);
