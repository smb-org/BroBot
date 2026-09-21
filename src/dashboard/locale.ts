import type { PanelChannelRole } from "../panel-contract";
import { browserModuleLanguage, type ModuleLanguage } from "../modules/contract";

export type DashboardLanguage = ModuleLanguage;
export type LocaleCatalog<T> = Record<DashboardLanguage, T>;

export interface DashboardCommonTexte {
  abbrechen: string;
  schliessen: string;
  speichern: string;
  rollen: Record<PanelChannelRole, string>;
}

const gemeinsameTexte: LocaleCatalog<DashboardCommonTexte> = {
  de: {
    abbrechen: "Abbrechen",
    schliessen: "Schließen",
    speichern: "Speichern",
    rollen: {
      broadcaster: "Broadcaster",
      verwalter: "Verwalter",
      bediener: "Bediener",
    },
  },
  en: {
    abbrechen: "Cancel",
    schliessen: "Close",
    speichern: "Save",
    rollen: {
      broadcaster: "Broadcaster",
      verwalter: "Manager",
      bediener: "Operator",
    },
  },
};

/**
 * Die Sprache des Panels, abgeleitet aus dem Browser (Entscheidung 0007).
 * Dies ist die einzige Stelle, die sie bestimmt — eine spätere bewusste
 * Sprachwahl je Nutzer ersetzt nur diese Funktion.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const dashboardGemeinsameTexte = (): DashboardCommonTexte => gemeinsameTexte[dashboardLanguage()];

export interface DashboardTexte {
  kopf: {
    verbindungLaeuft: string;
    verbindungWartet: string;
    verbindungGestort: string;
    kanalIdentitaet: string;
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
    broadcasterZustimmungFehlt: string;
    chatAboFehlt: string;
    gesund: string;
    zustandUnvollstaendig: string;
    nichtVerbunden: string;
    nichtEingerichtet: string;
    moderator: string;
    fehlend: string;
    aktiv: string;
    ausstehend: string;
    nichtErforderlich: string;
    vorhanden: string;
    botBerechtigungenFehlen: (anzahl: string) => string;
  };
  navigation: {
    hauptnavigation: string;
    brotkrume: string;
    uebersicht: string;
    kanal: string;
    system: string;
    mitglieder: string;
    module: string;
    ereignisse: string;
    kanalAuswaehlen: string;
    modulAuswaehlen: string;
    twitchAnmelden: string;
    twitchKonto: string;
    abmeldungLaeuft: string;
    abmelden: string;
  };
  overview: {
    einKanalFreigegeben: string;
    kanaeleFreigegeben: (anzahl: string) => string;
    kanaeleFreigegebenKurz: (anzahl: string) => string;
    keinKanalFreigegeben: string;
    keineMitgliedschaft: string;
    aktiveModule: string;
    zustandLaden: string;
  };
  moderation: {
    fuerKanalKeinePruefung: string;
    letztePruefung: (zeitpunkt: string) => string;
    pruefungLaeuft: string;
    moderatorstatusPruefen: string;
    naechstePruefungAb: (zeitpunkt: string) => string;
    pruefungGesperrt: string;
    broadcasterErneutAutorisieren: string;
    broadcasterZustimmungAnfordern: string;
  };
  bot: {
    keinGespeicherterStatus: string;
    zuletztAktualisiert: (zeitpunkt: string) => string;
    optionaleModule: string;
    normalerBetrieb: string;
    channelBotNoetig: string;
    botBerechtigungenBetreiber: string;
    botBerechtigungenVollstaendig: string;
  };
  fehler: {
    titel: string;
    warnung: string;
    sitzungUngueltig: string;
    datenLaden: string;
    letzter: string;
    keineUrsache: string;
    kanalNichtFreigegeben: string;
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
    broadcasterZustimmungFehlt: string;
    broadcastErklaerung: string;
    keinBotStatus: string;
    chatBotNoetig: string;
  };
  zeit: {
    aktualisiert: (relativeZeit: string) => string;
    vorSekunden: (anzahl: number) => string;
    vorMinuten: (anzahl: number) => string;
    vorStunden: (anzahl: number) => string;
  };
  system: {
    titel: string;
    nurLesend: string;
    zustandLaden: string;
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
    zeit: string;
    aktion: string;
    wer: string;
    auditLaden: string;
    keineAuditEintraege: string;
    aenderungsdaten: string;
    vorher: string;
    nachher: string;
    aeltereEintraege: string;
    aeltereEintraegeLaden: string;
    abonnements: string;
    keineAbonnements: string;
    abo: string;
    zustand: string;
    grund: string;
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
    anzahl: (anzahl: string) => string;
    protokoll: string;
    zeit: string;
    ereignis: string;
    modul: string;
    wer: string;
    automatisch: string;
    info: string;
    fehler: string;
    hinweis: string;
    unbekannt: string;
    code: string;
    zeitstempel: string;
    vorgang: string;
    beteiligte: string;
    verlauf: string;
    laden: string;
    keine: string;
    detail: string;
    aeltereLaden: string;
    aeltereWerdenGeladen: string;
    filter: string;
    herkunft: string;
    modulFilter: string;
    ton: string;
    person: string;
    alle: string;
    kanalereignisse: string;
    moduldiagnosen: string;
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
    realtimeNeue: (anzahl: string) => string;
  };
  anmeldung: {
    erforderlich: string;
    erklaerung: string;
    mitTwitchAnmelden: string;
    kanalzugriffPruefen: string;
    mitgliederLaden: string;
  };
  module: {
    modul: string;
    verfuegbar: string;
    laden: string;
    registriert: string;
    aktiv: string;
    inaktiv: string;
    aktivieren: string;
    deaktivieren: string;
    modulliste: string;
    modulUebersicht: string;
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

const dashboardTexteKatalog: LocaleCatalog<DashboardTexte> = {
  de: {
    kopf: {
      verbindungLaeuft: "Läuft",
      verbindungWartet: "Wartet",
      verbindungGestort: "Gestört",
      kanalIdentitaet: "Kanal",
      keineVerbindung: "Keine Verbindung",
      schalterAn: "An",
      schalterAus: "Aus",
    },
    status: {
      verbunden: "Verbunden", widerrufen: "Widerrufen", fehler: "Fehler",
      loginIdentitaetFehlt: "Login-Identität fehlt", nichtGeprueft: "Nicht geprüft", abgelaufen: "Abgelaufen",
      wartungUeberfaellig: "Wartung überfällig", erneuerungUeberfaellig: "Erneuerung überfällig", gueltig: "Gültig",
      moderatorrolleFehlt: "Moderatorrolle fehlt", chatAboFehler: "Chat-Abo-Fehler", chatAboWiderrufen: "Chat-Abo widerrufen",
      botFehler: "Bot-Fehler", botTokenWiderrufen: "Bot-Token widerrufen", broadcasterZustimmungFehlt: "Broadcaster-Zustimmung fehlt",
      chatAboFehlt: "Chat-Abo fehlt", gesund: "Gesund", zustandUnvollstaendig: "Zustand unvollständig",
      nichtVerbunden: "Nicht verbunden", nichtEingerichtet: "Nicht eingerichtet", moderator: "Moderator", fehlend: "Fehlt",
      aktiv: "Aktiv", ausstehend: "Ausstehend", nichtErforderlich: "Nicht erforderlich", vorhanden: "Vorhanden",
      botBerechtigungenFehlen: (anzahl) => `${anzahl} fehlen`,
    },
    navigation: {
      hauptnavigation: "Hauptnavigation", brotkrume: "Brotkrume", uebersicht: "Übersicht", kanal: "Kanal", system: "System",
      mitglieder: "Mitglieder", module: "Module", ereignisse: "Ereignisse", kanalAuswaehlen: "Kanal auswählen",
      modulAuswaehlen: "Modul auswählen",
      twitchAnmelden: "Mit Twitch anmelden", twitchKonto: "Twitch-Konto",
      abmeldungLaeuft: "Abmeldung …", abmelden: "Abmelden",
    },
    overview: {
      einKanalFreigegeben: "1 Kanal freigegeben",
      kanaeleFreigegeben: (anzahl) => `${anzahl} Kanäle sind für dich freigegeben.`,
      kanaeleFreigegebenKurz: (anzahl) => `${anzahl} Kanäle freigegeben`,
      keinKanalFreigegeben: "Noch kein Kanal freigegeben",
      keineMitgliedschaft: "Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.",
      aktiveModule: "Aktive Module", zustandLaden: "Kanalzustand wird geladen …",
    },
    moderation: {
      fuerKanalKeinePruefung: "Für diesen Kanal liegt noch keine Prüfung vor.",
      letztePruefung: (zeitpunkt) => `Letzte Prüfung: ${zeitpunkt}`,
      pruefungLaeuft: "Prüfung läuft …", moderatorstatusPruefen: "Moderatorstatus prüfen",
      naechstePruefungAb: (zeitpunkt) => `Nächste Prüfung ab ${zeitpunkt}.`,
      pruefungGesperrt: "Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.",
      broadcasterErneutAutorisieren: "Der Broadcaster muss Twitch erneut autorisieren.",
      broadcasterZustimmungAnfordern: "Broadcaster-Zustimmung anfordern",
    },
    bot: {
      keinGespeicherterStatus: "Es gibt noch keinen gespeicherten Botstatus.",
      zuletztAktualisiert: (zeitpunkt) => `Zuletzt aktualisiert: ${zeitpunkt}`,
      optionaleModule: "Für optionale Broadcaster-Module verbunden.",
      normalerBetrieb: "Optional; für den normalen Bot-Betrieb nicht erforderlich.",
      channelBotNoetig: "channel:bot wird vom Broadcaster benötigt.",
      botBerechtigungenBetreiber: "Der Betreiber muss die Anwendung neu autorisieren.",
      botBerechtigungenVollstaendig: "Alle angeforderten Bot-Berechtigungen sind vorhanden.",
    },
    fehler: {
      titel: "Fehler", warnung: "Warnung", sitzungUngueltig: "Deine Sitzung ist nicht mehr gültig.",
      datenLaden: "Die Daten konnten nicht geladen werden.", letzter: "Letzter Fehler",
      keineUrsache: "Keine gespeicherte Ursache", kanalNichtFreigegeben: "Dieser Kanal ist für dein Konto nicht freigegeben.",
    },
    statusKarte: {
      deineRolle: "Deine Rolle", broadcasterOauth: "Broadcaster-OAuth", chatZustimmung: "Chat-Zustimmung",
      botAccount: "Bot-Account", botBerechtigungen: "Bot-Berechtigungen", moderatorstatus: "Moderatorstatus", chatAbo: "Chat-Abo", tokenZustand: "Token-Zustand",
      broadcasterZustimmungFehlt: "Broadcaster-Zustimmung fehlt", broadcastErklaerung: "Für optionale Broadcaster-Module verbunden.",
      keinBotStatus: "Es gibt noch keinen gespeicherten Botstatus.", chatBotNoetig: "channel:bot wird vom Broadcaster benötigt.",
    },
    zeit: {
      aktualisiert: (relativeZeit) => `aktualisiert ${relativeZeit}`, vorSekunden: (anzahl) => `vor ${String(anzahl)} s`,
      vorMinuten: (anzahl) => `vor ${String(anzahl)} Min.`, vorStunden: (anzahl) => `vor ${String(anzahl)} Std.`,
    },
    system: {
      titel: "System", nurLesend: "nur lesend", zustandLaden: "Systemzustand wird geladen …", eigenschaften: "Eigenschaften",
      botGrund: "Bot-Grund", botAktualisiert: "Bot zuletzt aktualisiert", chatAboId: "Chat-Abo-ID", chatAboGrund: "Chat-Abo-Grund",
      chatAboAktualisiert: "Chat-Abo zuletzt aktualisiert", loginStatus: "Login-Token-Status", loginGrund: "Login-Token-Grund",
      loginGueltigBis: "Login-Token gültig bis", botGueltigBis: "Bot-Token gültig bis", auditLog: "Audit-Log",
      eintraege: "Einträge", zeit: "Zeit", aktion: "Aktion", wer: "Wer", auditLaden: "Audit-Log wird geladen …",
      keineAuditEintraege: "Noch keine Audit-Einträge gespeichert.", aenderungsdaten: "Änderungsdaten",
      vorher: "Vorher", nachher: "Nachher", aeltereEintraege: "Ältere Einträge laden",
      aeltereEintraegeLaden: "Ältere Einträge werden geladen …",
      abonnements: "Abonnements", keineAbonnements: "Keine Abonnements gespeichert.", abo: "Abo", zustand: "Zustand", grund: "Grund",
      aboInspector: "Abo-Details", aboTyp: "Roher Typ", aboVersion: "Version", aboId: "Abo-ID", aboAktualisiert: "Zuletzt geändert",
      twitchMeldung: "Twitch-Meldung", httpStatus: "HTTP-Status", botBerechtigungenInspector: "Fehlende Bot-Berechtigungen", fehlendeScopes: "Fehlende Scopes",
    },
    ereignisse: {
      titel: "Ereignisse", anzahl: (anzahl) => `${anzahl} Einträge`, protokoll: "Ereignisprotokoll", zeit: "Zeit", ereignis: "Ereignis",
      modul: "Modul", wer: "Wer", automatisch: "Automatisch", info: "Info", fehler: "Fehler", hinweis: "Hinweis", unbekannt: "Unbekannt", code: "Code", zeitstempel: "Zeitstempel", vorgang: "Vorgang", beteiligte: "Beteiligte", verlauf: "Verlauf",
      laden: "Ereignisse werden geladen …",
      keine: "Noch keine Ereignisse protokolliert.", detail: "Detail", aeltereLaden: "Ältere Ereignisse laden", aeltereWerdenGeladen: "Ältere Ereignisse werden geladen …",
      filter: "Filter", herkunft: "Herkunft", modulFilter: "Modul", ton: "Ton", person: "Person", alle: "Alle",
      kanalereignisse: "Kanalereignisse", moduldiagnosen: "Moduldiagnosen", aktiveFilter: "Aktive Filter:", filterZuruecksetzen: "Filter zurücksetzen",
      keineTreffer: "Keine Ereignisse passen zu den Filtern.", nachladenAmEnde: "Am Ende werden ältere Ereignisse nachgeladen.",
      feedEnde: "Ende des Ereignisverlaufs erreicht.",
      realtimeVerbindet: "Verbindet …", realtimeVerbunden: "Verbunden", realtimeWiederverbindung: "Verbindet neu …",
      realtimeOffline: "Offline", realtimeSitzungErneuern: "Sitzung erneuern", realtimeNeue: (anzahl) => `${anzahl} neue Ereignisse`,
    },
    anmeldung: {
      erforderlich: "Anmeldung erforderlich", erklaerung: "Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.",
      mitTwitchAnmelden: "Mit Twitch anmelden", kanalzugriffPruefen: "Kanalzugriff wird geprüft …", mitgliederLaden: "Mitglieder werden geladen …",
    },
    module: {
      modul: "Modul", verfuegbar: "Verfügbare Module", laden: "Module werden geladen …",
      registriert: "Für diesen Bot ist noch kein Modul registriert.", aktiv: "Aktiv", inaktiv: "Inaktiv",
      aktivieren: "aktivieren", deaktivieren: "deaktivieren", modulliste: "Modulliste",
      modulUebersicht: "Modulübersicht",
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
      kanalIdentitaet: "Channel",
      keineVerbindung: "No connection",
      schalterAn: "On",
      schalterAus: "Off",
    },
    status: {
      verbunden: "Connected", widerrufen: "Revoked", fehler: "Error", loginIdentitaetFehlt: "Login identity missing",
      nichtGeprueft: "Not checked", abgelaufen: "Expired", wartungUeberfaellig: "Maintenance overdue",
      erneuerungUeberfaellig: "Renewal overdue", gueltig: "Valid", moderatorrolleFehlt: "Moderator role missing",
      chatAboFehler: "Chat subscription error", chatAboWiderrufen: "Chat subscription revoked", botFehler: "Bot error",
      botTokenWiderrufen: "Bot token revoked", broadcasterZustimmungFehlt: "Broadcaster consent missing",
      chatAboFehlt: "Chat subscription missing", gesund: "Healthy", zustandUnvollstaendig: "Incomplete status",
      nichtVerbunden: "Not connected", nichtEingerichtet: "Not set up", moderator: "Moderator", fehlend: "Missing", aktiv: "Active",
      ausstehend: "Pending", nichtErforderlich: "Not required", vorhanden: "Present",
      botBerechtigungenFehlen: (anzahl) => `${anzahl} missing`,
    },
    navigation: {
      hauptnavigation: "Main navigation", brotkrume: "Breadcrumb", uebersicht: "Overview", kanal: "Channel", system: "System",
      mitglieder: "Members", module: "Modules", ereignisse: "Events", kanalAuswaehlen: "Select channel",
      modulAuswaehlen: "Select module",
      twitchAnmelden: "Sign in with Twitch", twitchKonto: "Twitch account",
      abmeldungLaeuft: "Signing out …", abmelden: "Sign out",
    },
    overview: {
      einKanalFreigegeben: "1 channel available",
      kanaeleFreigegeben: (anzahl) => `${anzahl} channels are available to you.`,
      kanaeleFreigegebenKurz: (anzahl) => `${anzahl} channels available`,
      keinKanalFreigegeben: "No channel available yet", keineMitgliedschaft: "This account is not a member of an available channel.",
      aktiveModule: "Active modules", zustandLaden: "Loading channel status …",
    },
    moderation: {
      fuerKanalKeinePruefung: "This channel has not been checked yet.", letztePruefung: (zeitpunkt) => `Last checked: ${zeitpunkt}`,
      pruefungLaeuft: "Checking …", moderatorstatusPruefen: "Check moderator status",
      naechstePruefungAb: (zeitpunkt) => `Next check available ${zeitpunkt}.`,
      pruefungGesperrt: "Only broadcasters and managers may check moderator status.",
      broadcasterErneutAutorisieren: "The broadcaster must authorize Twitch again.", broadcasterZustimmungAnfordern: "Request broadcaster consent",
    },
    bot: {
      keinGespeicherterStatus: "No bot status has been saved yet.", zuletztAktualisiert: (zeitpunkt) => `Last updated: ${zeitpunkt}`,
      optionaleModule: "Connected for optional broadcaster modules.", normalerBetrieb: "Optional; not required for normal bot operation.",
      channelBotNoetig: "channel:bot is required from the broadcaster.",
      botBerechtigungenBetreiber: "The operator must authorize the application again.",
      botBerechtigungenVollstaendig: "All requested bot permissions are present.",
    },
    fehler: {
      titel: "Error", warnung: "Warning", sitzungUngueltig: "Your session is no longer valid.", datenLaden: "The data could not be loaded.",
      letzter: "Last error", keineUrsache: "No saved cause", kanalNichtFreigegeben: "This channel is not available to your account.",
    },
    statusKarte: {
      deineRolle: "Your role", broadcasterOauth: "Broadcaster OAuth", chatZustimmung: "Chat consent", botAccount: "Bot account", botBerechtigungen: "Bot permissions",
      moderatorstatus: "Moderator status", chatAbo: "Chat subscription", tokenZustand: "Token status",
      broadcasterZustimmungFehlt: "Broadcaster consent missing", broadcastErklaerung: "Connected for optional broadcaster modules.",
      keinBotStatus: "No bot status has been saved yet.", chatBotNoetig: "channel:bot is required from the broadcaster.",
    },
    zeit: {
      aktualisiert: (relativeZeit) => `updated ${relativeZeit}`, vorSekunden: (anzahl) => `${String(anzahl)} sec ago`,
      vorMinuten: (anzahl) => `${String(anzahl)} min ago`, vorStunden: (anzahl) => `${String(anzahl)} hr ago`,
    },
    system: {
      titel: "System", nurLesend: "read-only", zustandLaden: "Loading system status …", eigenschaften: "Properties",
      botGrund: "Bot reason", botAktualisiert: "Bot last updated", chatAboId: "Chat subscription ID", chatAboGrund: "Chat subscription reason",
      chatAboAktualisiert: "Chat subscription last updated", loginStatus: "Login token status", loginGrund: "Login token reason",
      loginGueltigBis: "Login token valid until", botGueltigBis: "Bot token valid until", auditLog: "Audit log", eintraege: "entries",
      zeit: "Time", aktion: "Action", wer: "Who",
      auditLaden: "Loading audit log …", keineAuditEintraege: "No audit entries saved yet.", aenderungsdaten: "Change data",
      vorher: "Before", nachher: "After", aeltereEintraege: "Load older entries", aeltereEintraegeLaden: "Loading older entries …",
      abonnements: "Subscriptions", keineAbonnements: "No subscriptions saved.", abo: "Subscription", zustand: "State", grund: "Reason",
      aboInspector: "Subscription details", aboTyp: "Raw type", aboVersion: "Version", aboId: "Subscription ID", aboAktualisiert: "Last changed",
      twitchMeldung: "Twitch message", httpStatus: "HTTP status", botBerechtigungenInspector: "Missing bot permissions", fehlendeScopes: "Missing scopes",
    },
    ereignisse: {
      titel: "Events", anzahl: (anzahl) => `${anzahl} entries`, protokoll: "Event log", zeit: "Time", ereignis: "Event", modul: "Module",
      wer: "Who", automatisch: "Automatic", info: "Info", fehler: "Error", hinweis: "Notice", unbekannt: "Unknown", code: "Code", zeitstempel: "Timestamp", vorgang: "Operation", beteiligte: "Participants", verlauf: "History", laden: "Loading events …", keine: "No events logged yet.", detail: "Detail",
      aeltereLaden: "Load older events", aeltereWerdenGeladen: "Loading older events …",
      filter: "Filters", herkunft: "Origin", modulFilter: "Module", ton: "Tone", person: "Person", alle: "All",
      kanalereignisse: "Channel events", moduldiagnosen: "Module diagnostics", aktiveFilter: "Active filters:", filterZuruecksetzen: "Reset filters",
      keineTreffer: "No events match the filters.", nachladenAmEnde: "Older events load at the end.",
      feedEnde: "End of the event history reached.",
      realtimeVerbindet: "Connecting …", realtimeVerbunden: "Connected", realtimeWiederverbindung: "Reconnecting …",
      realtimeOffline: "Offline", realtimeSitzungErneuern: "Renew session", realtimeNeue: (anzahl) => `${anzahl} new events`,
    },
    anmeldung: {
      erforderlich: "Sign-in required", erklaerung: "Sign in with your Twitch account to see available channels.",
      mitTwitchAnmelden: "Sign in with Twitch", kanalzugriffPruefen: "Checking channel access …", mitgliederLaden: "Loading members …",
    },
    module: {
      modul: "Module", verfuegbar: "Available modules", laden: "Loading modules …", registriert: "No module is registered for this bot yet.",
      aktiv: "Active", inaktiv: "Inactive", aktivieren: "enable", deaktivieren: "disable", modulliste: "Module list",
      modulUebersicht: "Module overview",
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

export type EreignisCode =
  | "host.aktion.fehler"
  | "host.chat.fehlgeschlagen"
  | "host.chat.gesendet"
  | "host.modul.fehler"
  | "host.modul.unbekannt"
  | "host.overlay.nicht_ausgefuehrt"
  | "host.shoutout.fehlgeschlagen"
  | "host.shoutout.gesendet"
  | "kanalereignisse.raid.eingehend"
  | "kanalereignisse.raid.ausgehend"
  | "kanalereignisse.shoutout.gesendet"
  | "kanalereignisse.shoutout.empfangen"
  | "kanalereignisse.chat.sub"
  | "kanalereignisse.chat.resub"
  | "kanalereignisse.chat.gift_sub"
  | "kanalereignisse.chat.community_gift"
  | "kanalereignisse.chat.ankuendigung"
  | "kanalereignisse.chat.unbekannt"
  | "kanalereignisse.moderation.ban"
  | "kanalereignisse.moderation.timeout"
  | "kanalereignisse.moderation.untimeout"
  | "kanalereignisse.moderation.unban"
  | "kanalereignisse.moderation.delete"
  | "kanalereignisse.moderation.warn"
  | "kanalereignisse.moderation.unbekannt"
  | "kanalereignisse.automod.halte"
  | "kanalereignisse.verdacht.nachricht"
  | "kanalereignisse.verdacht.einstufung"
  | "kanalereignisse.verdacht.entwarnung"
  | "raid.ausgehend"
  | "raid.shoutout"
  | "raid.ungueltig"
  | "shoutout.unterdrueckt"
  | "werbung.ankuendigung"
  | "werbung.uebersprungen"
  | "werbung.vorwarnung.angekuendigt"
  | "werbung.vorwarnung.kein_termin"
  | "werbung.vorwarnung.zu_spaet"
  | "werbung.vorwarnung.pause_begonnen"
  | "werbung.vorwarnung.termin_verschoben"
  | "werbung.vorwarnung.scope_fehlt"
  | "werbung.vorwarnung.zeitplan_fehler"
  | "werbung.snooze"
  | "textbefehle.abgekuehlt"
  | "textbefehle.ausgeloest"
  | "textbefehle.deaktiviert"
  | "textbefehle.berechtigung"
  // Seit dem Wegfall der ändernden Chat-Befehle (#120) erzeugt niemand mehr
  // diese beiden Kennungen. Sie bleiben, weil das Ereignisprotokoll seine
  // Zeilen 14 Tage hält: Ohne Beschriftung wären bereits geschriebene
  // Einträge im Panel nicht mehr lesbar.
  | "textbefehle.bereits_vorhanden"
  | "textbefehle.nicht_berechtigt"
  | "textbefehle.unbekannt"
  | "textbefehle.ungueltig";

export type EreignisDetail = Readonly<Record<string, unknown>>;
export type EreignisText = string | ((detail: EreignisDetail) => string);

const textbefehlName = (detail: EreignisDetail): string | null =>
  typeof detail.name === "string" && detail.name.length > 0 ? detail.name : null;

const ereignisTextMitName = (
  detail: EreignisDetail,
  ohneName: string,
  mitName: (name: string) => string,
): string => {
  const name = textbefehlName(detail);
  return name === null ? ohneName : mitName(name);
};

const detailText = (detail: EreignisDetail, key: string, fallback: string): string =>
  typeof detail[key] === "string" && detail[key].length > 0 ? detail[key] : fallback;

const textbefehlStufe = (detail: EreignisDetail, key: string, fallback: string, language: DashboardLanguage): string => {
  const value = detail[key];
  const labels: Record<string, string> = language === "de"
    ? { alle: "alle", abonnent: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster", zuschauer: "Zuschauer" }
    : { alle: "everyone", abonnent: "subscribers", vip: "VIPs", moderator: "moderators", broadcaster: "broadcaster", zuschauer: "viewer" };
  const werte = Array.isArray(value) ? value : [value];
  const beschrifteteWerte = werte.filter((eintrag): eintrag is string => typeof eintrag === "string" && eintrag.length > 0);
  return beschrifteteWerte.length === 0
    ? fallback
    : beschrifteteWerte.map((eintrag) => labels[eintrag] ?? eintrag).join(", ");
};

const detailZahl = (detail: EreignisDetail, key: string, fallback: string): string =>
  typeof detail[key] === "number" && Number.isFinite(detail[key]) ? String(detail[key]) : fallback;

const detailDauer = (detail: EreignisDetail, einheit: string, fallback: string): string =>
  typeof detail.dauer === "number" && Number.isFinite(detail.dauer) ? `${String(detail.dauer)} ${einheit}` : fallback;

const detailGrund = (detail: EreignisDetail): string =>
  typeof detail.grund === "string" && detail.grund.length > 0
    ? `: ${detail.grund}`
    : "";

const detailGrundMit = (detail: EreignisDetail, praeposition: string): string =>
  typeof detail.grund === "string" && detail.grund.length > 0
    ? ` ${praeposition} ${detail.grund}`
    : "";

const detailEinstufung = (detail: EreignisDetail, fallback: string): string =>
  typeof detail.einstufung === "string" && detail.einstufung.length > 0 ? detail.einstufung : fallback;

const detailModerator = (detail: EreignisDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` von ${detail.moderator}` : fallback;

const detailModeratorEn = (detail: EreignisDetail, fallback: string): string =>
  typeof detail.moderator === "string" && detail.moderator.length > 0 ? ` by ${detail.moderator}` : fallback;

export const ereignisTexte: LocaleCatalog<Record<EreignisCode, EreignisText>> = {
  de: {
    "host.aktion.fehler": "Aktion fehlgeschlagen",
    "host.chat.fehlgeschlagen": "Chat-Nachricht fehlgeschlagen",
    "host.chat.gesendet": "Chat-Nachricht gesendet",
    "host.modul.fehler": "Modulfehler",
    "host.modul.unbekannt": "Unbekanntes Modul",
    "host.overlay.nicht_ausgefuehrt": "Overlay nicht ausgeführt",
    "host.shoutout.fehlgeschlagen": "Shoutout fehlgeschlagen",
    "host.shoutout.gesendet": "Shoutout gesendet",
    "kanalereignisse.raid.eingehend": (detail) => `Raid von ${detailText(detail, "quelle", "unbekannt")} mit ${detailZahl(detail, "zuschauer", "unbekannter Anzahl")} Zuschauern`,
    "kanalereignisse.raid.ausgehend": (detail) => `Raid zu ${detailText(detail, "ziel", "unbekannt")} mit ${detailZahl(detail, "zuschauer", "unbekannter Anzahl")} Zuschauern`,
    "kanalereignisse.shoutout.gesendet": (detail) => `Shoutout an ${detailText(detail, "ziel", "unbekannt")}`,
    "kanalereignisse.shoutout.empfangen": (detail) => `Shoutout von ${detailText(detail, "quelle", "unbekannt")}${typeof detail.zuschauer === "number" && Number.isFinite(detail.zuschauer) ? ` mit ${String(detail.zuschauer)} Zuschauern` : ""}`,
    "kanalereignisse.chat.sub": (detail) => `Sub von ${detailText(detail, "person", "unbekannt")}`,
    "kanalereignisse.chat.resub": (detail) => `Resub von ${detailText(detail, "person", "unbekannt")}`,
    "kanalereignisse.chat.gift_sub": (detail) => `Gift-Sub von ${detailText(detail, "spender", "unbekannt")} an ${detailText(detail, "empfaenger", "unbekannt")}`,
    "kanalereignisse.chat.community_gift": (detail) => `Community-Gift von ${detailText(detail, "spender", "unbekannt")} für ${detailZahl(detail, "anzahl", "unbekannte Anzahl")} Subs`,
    "kanalereignisse.chat.ankuendigung": (detail) => `Ankündigung von ${detailText(detail, "person", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "kanalereignisse.chat.unbekannt": (detail) => `Unbekannte Chat-Benachrichtigung: ${detailText(detail, "art", "unbekannt")}`,
    "kanalereignisse.moderation.ban": (detail) => `${detailText(detail, "person", "unbekannt")} gebannt von ${detailText(detail, "moderator", "unbekannt")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.timeout": (detail) => `${detailText(detail, "person", "unbekannt")} für ${detailDauer(detail, "Sekunden", "unbekannte Dauer")} getimeoutet von ${detailText(detail, "moderator", "unbekannt")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.untimeout": (detail) => `${detailText(detail, "person", "unbekannt")} aus dem Timeout genommen von ${detailText(detail, "moderator", "unbekannt")}`,
    "kanalereignisse.moderation.unban": (detail) => `${detailText(detail, "person", "unbekannt")} entbannt von ${detailText(detail, "moderator", "unbekannt")}`,
    "kanalereignisse.moderation.delete": (detail) => `Nachricht von ${detailText(detail, "person", "unbekannt")} gelöscht von ${detailText(detail, "moderator", "unbekannt")}: ${detailText(detail, "text", "ohne Text")}`,
    "kanalereignisse.moderation.warn": (detail) => `${detailText(detail, "person", "unbekannt")} verwarnt von ${detailText(detail, "moderator", "unbekannt")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.unbekannt": (detail) => `Unbekannte Moderationsaktion: ${detailText(detail, "aktion", "unbekannt")}`,
    "kanalereignisse.automod.halte": (detail) => `AutoMod hielt die Nachricht von ${detailText(detail, "person", "unbekannt")}${detailGrundMit(detail, "wegen")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "kanalereignisse.verdacht.nachricht": (detail) => `Nachricht von auffälligem Nutzer ${detailText(detail, "person", "unbekannt")} (${detailEinstufung(detail, "unbekannte Einstufung")}): ${detailText(detail, "text", "ohne Text")}`,
    "kanalereignisse.verdacht.einstufung": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} verschärft${detailModerator(detail, "")}: ${detailEinstufung(detail, "unbekannt")}`,
    "kanalereignisse.verdacht.entwarnung": (detail) => `Einstufung von ${detailText(detail, "person", "unbekannt")} aufgehoben${detailModerator(detail, "")}`,
    "raid.ausgehend": (detail) => `Ausgehender Raid zu ${detailText(detail, "zielKanalId", "unbekannt")}`,
    "raid.shoutout": (detail) => `Raid über der Schwelle (${detailZahl(detail, "zuschauer", "unbekannt")} von ${detailZahl(detail, "schwelle", "unbekannt")}): Shoutout und Chatzeile`,
    "raid.ungueltig": (detail) => `Raid verworfen: ${detailText(detail, "grund", "ungültige Daten")}`,
    "shoutout.unterdrueckt": (detail) => detail.grund === "abgeschaltet"
      ? "Shoutout abgeschaltet"
      : detail.grund === "unter_schwelle"
        ? `Shoutout unter der Schwelle (${detailZahl(detail, "zuschauer", "unbekannt")} von ${detailZahl(detail, "schwelle", "unbekannt")} Zuschauern)`
        : "Shoutout unterdrückt",
    "werbung.ankuendigung": (detail) => `Werbepause ${detail.automatisch === true ? "automatisch" : "manuell"} gestartet: ${detailZahl(detail, "dauer", "unbekannte Dauer")} Sekunden`,
    "werbung.uebersprungen": (detail) => `Werbepause übersprungen: ${detail.grund === "dauer_null" ? "Dauer ist null" : "Ereignisdaten sind ungültig"}`,
    "werbung.vorwarnung.angekuendigt": (detail) => `Vorwarnung: Werbung in ${detailZahl(detail, "sekunden", "unbekannter Zeit")} Sekunden`,
    "werbung.vorwarnung.kein_termin": "Keine nächste Werbepause geplant",
    "werbung.vorwarnung.zu_spaet": "Werbe-Vorwarnung unterdrückt: Termin zu nah",
    "werbung.vorwarnung.pause_begonnen": "Werbe-Vorwarnung unterdrückt: Werbepause hat begonnen",
    "werbung.vorwarnung.termin_verschoben": "Werbe-Vorwarnung unterdrückt: Termin wurde verschoben",
    "werbung.vorwarnung.scope_fehlt": "Werbe-Vorwarnung unterdrückt: channel:read:ads fehlt",
    "werbung.vorwarnung.zeitplan_fehler": (detail) => `Werbezeitplan nicht gelesen: ${detailText(detail, "grund", "unbekannter Fehler")}`,
    "werbung.snooze": (detail) => detail.ausgang === "erfolgreich" ? "Nächste Werbepause verschoben" : `Snooze nicht ausgeführt: ${detailText(detail, "grund", "unbekannter Fehler")}`,
    "textbefehle.abgekuehlt": (detail) => {
      const name = textbefehlName(detail);
      return name === null || typeof detail.restSekunden !== "number" || !Number.isFinite(detail.restSekunden)
        ? "Textbefehl abgekühlt"
        : `Befehl !${name} abgekühlt, noch ${String(detail.restSekunden)} s`;
    },
    "textbefehle.ausgeloest": (detail) => ereignisTextMitName(detail, "Befehl ausgeführt", (name) => `Befehl !${name} ausgeführt`),
    "textbefehle.deaktiviert": (detail) => ereignisTextMitName(detail, "Textbefehl ausgeschaltet", (name) => `Textbefehl !${name} ausgeschaltet`),
    "textbefehle.berechtigung": (detail) => ereignisTextMitName(detail, "Textbefehl nicht berechtigt", (name) => `Befehl !${name} nicht ausgelöst: Mindeststufe ${textbefehlStufe(detail, "geforderteStufe", "unbekannt", "de")}, vorhanden ${textbefehlStufe(detail, "vorhandeneStufe", "kein Chat-Status", "de")}`),
    "textbefehle.bereits_vorhanden": (detail) => ereignisTextMitName(detail, "Textbefehl bereits vorhanden", (name) => `Textbefehl !${name} bereits vorhanden`),
    "textbefehle.nicht_berechtigt": "Textbefehl nicht berechtigt",
    "textbefehle.unbekannt": (detail) => ereignisTextMitName(detail, "Textbefehl unbekannt", (name) => `Textbefehl !${name} unbekannt`),
    "textbefehle.ungueltig": "Textbefehl ungültig",
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
    "kanalereignisse.raid.eingehend": (detail) => `Raid from ${detailText(detail, "quelle", "unknown")} with ${detailZahl(detail, "zuschauer", "unknown number")} viewers`,
    "kanalereignisse.raid.ausgehend": (detail) => `Raid to ${detailText(detail, "ziel", "unknown")} with ${detailZahl(detail, "zuschauer", "unknown number")} viewers`,
    "kanalereignisse.shoutout.gesendet": (detail) => `Shoutout sent to ${detailText(detail, "ziel", "unknown")}`,
    "kanalereignisse.shoutout.empfangen": (detail) => `Shoutout received from ${detailText(detail, "quelle", "unknown")}${typeof detail.zuschauer === "number" && Number.isFinite(detail.zuschauer) ? ` with ${String(detail.zuschauer)} viewers` : ""}`,
    "kanalereignisse.chat.sub": (detail) => `Sub from ${detailText(detail, "person", "unknown")}`,
    "kanalereignisse.chat.resub": (detail) => `Resub from ${detailText(detail, "person", "unknown")}`,
    "kanalereignisse.chat.gift_sub": (detail) => `Gift sub from ${detailText(detail, "spender", "unknown")} to ${detailText(detail, "empfaenger", "unknown")}`,
    "kanalereignisse.chat.community_gift": (detail) => `Community gift from ${detailText(detail, "spender", "unknown")} for ${detailZahl(detail, "anzahl", "unknown number")} subs`,
    "kanalereignisse.chat.ankuendigung": (detail) => `Announcement from ${detailText(detail, "person", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "kanalereignisse.chat.unbekannt": (detail) => `Unknown chat notification: ${detailText(detail, "art", "unknown")}`,
    "kanalereignisse.moderation.ban": (detail) => `${detailText(detail, "person", "unknown")} banned by ${detailText(detail, "moderator", "unknown")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.timeout": (detail) => `${detailText(detail, "person", "unknown")} timed out for ${detailDauer(detail, "seconds", "unknown duration")} by ${detailText(detail, "moderator", "unknown")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.untimeout": (detail) => `${detailText(detail, "person", "unknown")} removed from timeout by ${detailText(detail, "moderator", "unknown")}`,
    "kanalereignisse.moderation.unban": (detail) => `${detailText(detail, "person", "unknown")} unbanned by ${detailText(detail, "moderator", "unknown")}`,
    "kanalereignisse.moderation.delete": (detail) => `Message from ${detailText(detail, "person", "unknown")} deleted by ${detailText(detail, "moderator", "unknown")}: ${detailText(detail, "text", "no text")}`,
    "kanalereignisse.moderation.warn": (detail) => `${detailText(detail, "person", "unknown")} warned by ${detailText(detail, "moderator", "unknown")}${detailGrund(detail)}`,
    "kanalereignisse.moderation.unbekannt": (detail) => `Unknown moderation action: ${detailText(detail, "aktion", "unknown")}`,
    "kanalereignisse.automod.halte": (detail) => `AutoMod held a message from ${detailText(detail, "person", "unknown")}${detailGrundMit(detail, "for")}${typeof detail.text === "string" && detail.text.length > 0 ? `: ${detail.text}` : ""}`,
    "kanalereignisse.verdacht.nachricht": (detail) => `Message from suspicious user ${detailText(detail, "person", "unknown")} (${detailEinstufung(detail, "unknown classification")}): ${detailText(detail, "text", "no text")}`,
    "kanalereignisse.verdacht.einstufung": (detail) => `Classification for ${detailText(detail, "person", "unknown")} tightened${detailModeratorEn(detail, "")}: ${detailEinstufung(detail, "unknown")}`,
    "kanalereignisse.verdacht.entwarnung": (detail) => `Classification for ${detailText(detail, "person", "unknown")} cleared${detailModeratorEn(detail, "")}`,
    "raid.ausgehend": (detail) => `Outgoing raid to ${detailText(detail, "zielKanalId", "unknown")}`,
    "raid.shoutout": (detail) => `Raid above threshold (${detailZahl(detail, "zuschauer", "unknown")} of ${detailZahl(detail, "schwelle", "unknown")}): shoutout and chat line`,
    "raid.ungueltig": (detail) => `Raid discarded: ${detailText(detail, "grund", "invalid data")}`,
    "shoutout.unterdrueckt": (detail) => detail.grund === "abgeschaltet"
      ? "Shoutout disabled"
      : detail.grund === "unter_schwelle"
        ? `Shoutout below threshold (${detailZahl(detail, "zuschauer", "unknown")} of ${detailZahl(detail, "schwelle", "unknown")} viewers)`
        : "Shoutout suppressed",
    "werbung.ankuendigung": (detail) => `Ad break ${detail.automatisch === true ? "automatically" : "manually"} started: ${detailZahl(detail, "dauer", "unknown duration")} seconds`,
    "werbung.uebersprungen": (detail) => `Ad break skipped: ${detail.grund === "dauer_null" ? "duration is zero" : "event data is invalid"}`,
    "werbung.vorwarnung.angekuendigt": (detail) => `Ad warning: ad in ${detailZahl(detail, "sekunden", "unknown time")} seconds`,
    "werbung.vorwarnung.kein_termin": "No next ad break scheduled",
    "werbung.vorwarnung.zu_spaet": "Ad warning suppressed: ad is too close",
    "werbung.vorwarnung.pause_begonnen": "Ad warning suppressed: ad break has started",
    "werbung.vorwarnung.termin_verschoben": "Ad warning suppressed: schedule changed",
    "werbung.vorwarnung.scope_fehlt": "Ad warning suppressed: channel:read:ads is missing",
    "werbung.vorwarnung.zeitplan_fehler": (detail) => `Ad schedule could not be read: ${detailText(detail, "grund", "unknown error")}`,
    "werbung.snooze": (detail) => detail.ausgang === "erfolgreich" ? "Next ad break postponed" : `Snooze not executed: ${detailText(detail, "grund", "unknown error")}`,
    "textbefehle.abgekuehlt": (detail) => {
      const name = textbefehlName(detail);
      return name === null || typeof detail.restSekunden !== "number" || !Number.isFinite(detail.restSekunden)
        ? "Text command on cooldown"
        : `Command !${name} on cooldown, ${String(detail.restSekunden)}s left`;
    },
    "textbefehle.ausgeloest": (detail) => ereignisTextMitName(detail, "Command executed", (name) => `Command !${name} executed`),
    "textbefehle.deaktiviert": (detail) => ereignisTextMitName(detail, "Text command disabled", (name) => `Text command !${name} disabled`),
    "textbefehle.berechtigung": (detail) => ereignisTextMitName(detail, "Text command not authorized", (name) => `Command !${name} not executed: minimum level ${textbefehlStufe(detail, "geforderteStufe", "unknown", "en")}, present ${textbefehlStufe(detail, "vorhandeneStufe", "no chat status", "en")}`),
    "textbefehle.bereits_vorhanden": (detail) => ereignisTextMitName(detail, "Text command already exists", (name) => `Text command !${name} already exists`),
    "textbefehle.nicht_berechtigt": "Text command not authorized",
    "textbefehle.unbekannt": (detail) => ereignisTextMitName(detail, "Unknown text command", (name) => `Unknown text command !${name}`),
    "textbefehle.ungueltig": "Invalid text command",
  },
};

export type EreignisFamilie = "gemeinschaft" | "raid" | "moderation" | "betrieb";
export type EreignisStufe = "voll" | "gezeichnet";
export type EreignisZahlSchluessel = "zuschauer" | "anzahl" | "dauer" | "restSekunden" | "stufe" | null;
export type EreignisBetriebston = "info" | "hinweis" | "fehler";

export interface EreignisTon {
  familie: EreignisFamilie;
  stufe: EreignisStufe;
  wort: LocaleCatalog<string>;
  zahlSchluessel: EreignisZahlSchluessel;
  ton?: EreignisBetriebston;
}

export const ereignisTon: Record<EreignisCode, EreignisTon> = {
  "host.aktion.fehler": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "host.chat.fehlgeschlagen": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "host.chat.gesendet": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, ton: "info" },
  "host.modul.fehler": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "host.modul.unbekannt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "host.overlay.nicht_ausgefuehrt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "host.shoutout.fehlgeschlagen": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "host.shoutout.gesendet": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, ton: "info" },
  "kanalereignisse.raid.eingehend": { familie: "raid", stufe: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "zuschauer" },
  "kanalereignisse.raid.ausgehend": { familie: "raid", stufe: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "zuschauer" },
  "kanalereignisse.shoutout.gesendet": { familie: "raid", stufe: "gezeichnet", wort: { de: "Shoutout", en: "Shoutout" }, zahlSchluessel: null },
  "kanalereignisse.shoutout.empfangen": { familie: "raid", stufe: "voll", wort: { de: "Shoutout", en: "Shoutout" }, zahlSchluessel: "zuschauer" },
  "kanalereignisse.chat.sub": { familie: "gemeinschaft", stufe: "voll", wort: { de: "Abo", en: "Sub" }, zahlSchluessel: "stufe" },
  "kanalereignisse.chat.resub": { familie: "gemeinschaft", stufe: "voll", wort: { de: "Resub", en: "Resub" }, zahlSchluessel: "stufe" },
  "kanalereignisse.chat.gift_sub": { familie: "gemeinschaft", stufe: "voll", wort: { de: "Gift-Sub", en: "Gift Sub" }, zahlSchluessel: "stufe" },
  "kanalereignisse.chat.community_gift": { familie: "gemeinschaft", stufe: "voll", wort: { de: "Gift", en: "Gift" }, zahlSchluessel: "anzahl" },
  "kanalereignisse.chat.ankuendigung": { familie: "gemeinschaft", stufe: "gezeichnet", wort: { de: "Ankündigung", en: "Announcement" }, zahlSchluessel: null },
  "kanalereignisse.chat.unbekannt": { familie: "gemeinschaft", stufe: "voll", wort: { de: "Unbekannt", en: "Unknown" }, zahlSchluessel: null },
  "kanalereignisse.moderation.ban": { familie: "moderation", stufe: "voll", wort: { de: "Bann", en: "Ban" }, zahlSchluessel: null },
  "kanalereignisse.moderation.timeout": { familie: "moderation", stufe: "voll", wort: { de: "Auszeit", en: "Timeout" }, zahlSchluessel: "dauer" },
  "kanalereignisse.moderation.untimeout": { familie: "moderation", stufe: "gezeichnet", wort: { de: "Entsperrt", en: "Untimeout" }, zahlSchluessel: null },
  "kanalereignisse.moderation.unban": { familie: "moderation", stufe: "gezeichnet", wort: { de: "Entbannt", en: "Unbanned" }, zahlSchluessel: null },
  "kanalereignisse.moderation.delete": { familie: "moderation", stufe: "voll", wort: { de: "Gelöscht", en: "Deleted" }, zahlSchluessel: null },
  "kanalereignisse.moderation.warn": { familie: "moderation", stufe: "voll", wort: { de: "Verwarnung", en: "Warning" }, zahlSchluessel: null },
  "kanalereignisse.moderation.unbekannt": { familie: "moderation", stufe: "voll", wort: { de: "Unbekannt", en: "Unknown" }, zahlSchluessel: null },
  "kanalereignisse.automod.halte": { familie: "moderation", stufe: "voll", wort: { de: "AutoMod", en: "AutoMod" }, zahlSchluessel: null },
  "kanalereignisse.verdacht.nachricht": { familie: "moderation", stufe: "voll", wort: { de: "Verdacht", en: "Suspicious" }, zahlSchluessel: null },
  "kanalereignisse.verdacht.einstufung": { familie: "moderation", stufe: "voll", wort: { de: "Einstufung", en: "Classified" }, zahlSchluessel: null },
  "kanalereignisse.verdacht.entwarnung": { familie: "moderation", stufe: "gezeichnet", wort: { de: "Entwarnt", en: "Cleared" }, zahlSchluessel: null },
  "raid.ausgehend": { familie: "raid", stufe: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "zuschauer", ton: "hinweis" },
  "raid.shoutout": { familie: "raid", stufe: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "zuschauer" },
  "raid.ungueltig": { familie: "raid", stufe: "gezeichnet", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: null, ton: "hinweis" },
  "shoutout.unterdrueckt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.ankuendigung": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: "dauer", ton: "info" },
  "werbung.uebersprungen": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.angekuendigt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, ton: "info" },
  "werbung.vorwarnung.kein_termin": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.zu_spaet": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.pause_begonnen": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.termin_verschoben": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.scope_fehlt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "werbung.vorwarnung.zeitplan_fehler": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Fehler", en: "Error" }, zahlSchluessel: null, ton: "fehler" },
  "werbung.snooze": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Snooze", en: "Snooze" }, zahlSchluessel: null, ton: "info" },
  "textbefehle.abgekuehlt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: "restSekunden", ton: "hinweis" },
  "textbefehle.ausgeloest": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, ton: "info" },
  "textbefehle.deaktiviert": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, ton: "info" },
  "textbefehle.berechtigung": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "textbefehle.bereits_vorhanden": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "textbefehle.nicht_berechtigt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "textbefehle.unbekannt": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
  "textbefehle.ungueltig": { familie: "betrieb", stufe: "gezeichnet", wort: { de: "Hinweis", en: "Notice" }, zahlSchluessel: null, ton: "hinweis" },
};

export function ereignisText(code: string, language?: DashboardLanguage): string;
export function ereignisText(code: string, detail: EreignisDetail, language?: DashboardLanguage): string;
export function ereignisText(
  code: string,
  detailOderSprache: EreignisDetail | DashboardLanguage = {},
  language?: DashboardLanguage,
): string {
  const detail = typeof detailOderSprache === "string" ? {} : detailOderSprache;
  const aufloesungsSprache = typeof detailOderSprache === "string"
    ? detailOderSprache
    : language ?? dashboardLanguage();
  if (Object.prototype.hasOwnProperty.call(ereignisTexte[aufloesungsSprache], code)) {
    const text = ereignisTexte[aufloesungsSprache][code as EreignisCode];
    return typeof text === "function" ? text(detail) : text;
  }
  return code;
}

export const dashboardTexte = (): DashboardTexte => dashboardTexteKatalog[dashboardLanguage()];

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

export const formatZeitpunkt = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium", timeStyle: "short" });

export const formatZahl = (value: number): string =>
  new Intl.NumberFormat(dashboardLanguage()).format(value);
