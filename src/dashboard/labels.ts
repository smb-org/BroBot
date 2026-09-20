import type { PanelChannelRole } from "../panel-contract";
import { dashboardGemeinsameTexte, dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";

/**
 * Rollen werden im Datenmodell klein geschrieben. In der Oberflaeche steht der
 * Begriff, nicht der Enum-Wert — an beiden Stellen derselbe, damit Panel und
 * Mitgliederliste nicht auseinanderlaufen.
 */
export const roleLabel = (role: PanelChannelRole): string => {
  return dashboardGemeinsameTexte().rollen[role];
};

export type BetreiberHandlung =
  | "kanal.freigegeben"
  | "kanal.vollzustimmung_geaendert"
  | "mitglied.hinzugefuegt"
  | "mitglied.rolle_geaendert"
  | "mitglied.entfernt";

export interface BetreiberTexte {
  titel: string;
  untertitel: (anzahl: string) => string;
  navigation: string;
  kanalübersicht: string;
  login: string;
  kennung: string;
  vollzustimmung: string;
  broadcaster: string;
  verwalter: string;
  bediener: string;
  ja: string;
  nein: string;
  identität: string;
  verbunden: string;
  zustimmungAusstehend: string;
  zustimmungAusstehendHinweis: string;
  laden: string;
  keineKanäle: string;
  fehler: string;
  kanalFreigeben: string;
  twitchLogin: string;
  suchen: string;
  sucheLäuft: string;
  nutzerGefunden: string;
  twitchId: (id: string) => string;
  vollzustimmungSetzen: string;
  kanalFreigebenFrage: (name: string) => string;
  kanalFreigebenBeschreibung: (name: string, id: string, mitZustimmung: string) => string;
  endgültigFreigeben: string;
  einladungslink: string;
  einladungslinkHinweis: string;
  kanalAuswählen: string;
  linkKopieren: string;
  linkKopiert: string;
  kanalBearbeiten: (name: string) => string;
  zustimmungUmschalten: string;
  mitglieder: string;
  mitgliederLaden: string;
  keineMitglieder: string;
  mitgliedHinzufügen: string;
  rolle: string;
  neueRolle: string;
  hinzufügen: string;
  ändern: string;
  entfernen: string;
  entfernenFrage: (name: string) => string;
  endgültigEntfernen: string;
  audit: string;
  auditLaden: string;
  auditLeer: string;
  zeitpunkt: string;
  handlung: string;
  akteur: string;
  weitereLaden: string;
  weitereWerdenGeladen: string;
  betreiber: string;
  mitglied: string;
  handlungLabel: Record<BetreiberHandlung, string>;
}

const betreiberKatalog: LocaleCatalog<BetreiberTexte> = {
  de: {
    titel: "Betreiberebene",
    untertitel: (anzahl) => `${anzahl} Kanäle verwalten`,
    navigation: "Betreiber",
    kanalübersicht: "Kanalübersicht",
    login: "Login",
    kennung: "Kennung",
    vollzustimmung: "Vollzustimmung",
    broadcaster: "Broadcaster",
    verwalter: "Verwalter",
    bediener: "Bediener",
    ja: "Ja",
    nein: "Nein",
    identität: "Broadcaster-Identität",
    verbunden: "Verbunden",
    zustimmungAusstehend: "Zustimmung ausstehend",
    zustimmungAusstehendHinweis: "Vollzustimmung ist gesetzt. Der Streamer muss den Einladungslink öffnen und Twitch bestätigen.",
    laden: "Betreiberdaten werden geladen …",
    keineKanäle: "Noch kein Kanal freigegeben.",
    fehler: "Die Betreiberdaten konnten nicht geladen werden.",
    kanalFreigeben: "Kanal freigeben",
    twitchLogin: "Twitch-Login",
    suchen: "Nutzer suchen",
    sucheLäuft: "Suche läuft …",
    nutzerGefunden: "Gefundener Nutzer",
    twitchId: (id) => `Twitch-ID ${id}`,
    vollzustimmungSetzen: "Vollzustimmung setzen",
    kanalFreigebenFrage: (name) => `Kanal für ${name} freigeben?`,
    kanalFreigebenBeschreibung: (name, id, mitZustimmung) => `${name} (${id}) wird ${mitZustimmung} Vollzustimmung angelegt.`,
    endgültigFreigeben: "Endgültig freigeben",
    einladungslink: "Einladungslink",
    einladungslinkHinweis: "Diesen Link bekommt der Streamer. Er startet die Twitch-Zustimmung für den gewählten Kanal.",
    kanalAuswählen: "Wähle zuerst eine Kanalzeile.",
    linkKopieren: "Link kopieren",
    linkKopiert: "Link kopiert",
    kanalBearbeiten: (name) => `Kanal bearbeiten: ${name}`,
    zustimmungUmschalten: "Vollzustimmung",
    mitglieder: "Mitglieder",
    mitgliederLaden: "Mitglieder werden geladen …",
    keineMitglieder: "Keine zusätzlichen Mitglieder freigegeben.",
    mitgliedHinzufügen: "Mitglied hinzufügen",
    rolle: "Rolle",
    neueRolle: "Rolle für neue Mitgliedschaft",
    hinzufügen: "Hinzufügen",
    ändern: "Ändern",
    entfernen: "Entfernen",
    entfernenFrage: (name) => `Zugriff für ${name} wirklich entfernen?`,
    endgültigEntfernen: "Endgültig entfernen",
    audit: "Betreiber-Audit",
    auditLaden: "Audit wird geladen …",
    auditLeer: "Noch keine Betreiberhandlungen protokolliert.",
    zeitpunkt: "Zeitpunkt",
    handlung: "Handlung",
    akteur: "Akteur",
    weitereLaden: "Weitere Audit-Einträge laden",
    weitereWerdenGeladen: "Weitere Audit-Einträge werden geladen …",
    betreiber: "Betreiber",
    mitglied: "Mitglied",
    handlungLabel: {
      "kanal.freigegeben": "Kanal freigegeben",
      "kanal.vollzustimmung_geaendert": "Vollzustimmung geändert",
      "mitglied.hinzugefuegt": "Mitglied hinzugefügt",
      "mitglied.rolle_geaendert": "Mitgliedsrolle geändert",
      "mitglied.entfernt": "Mitglied entfernt",
    },
  },
  en: {
    titel: "Operator level",
    untertitel: (anzahl) => `Manage ${anzahl} channels`,
    navigation: "Operator",
    kanalübersicht: "Channel overview",
    login: "Login",
    kennung: "Identifier",
    vollzustimmung: "Full consent",
    broadcaster: "Broadcaster",
    verwalter: "Manager",
    bediener: "Operator",
    ja: "Yes",
    nein: "No",
    identität: "Broadcaster identity",
    verbunden: "Connected",
    zustimmungAusstehend: "Consent pending",
    zustimmungAusstehendHinweis: "Full consent is set. The streamer must open the invitation link and confirm Twitch.",
    laden: "Loading operator data …",
    keineKanäle: "No channel has been released yet.",
    fehler: "Operator data could not be loaded.",
    kanalFreigeben: "Release channel",
    twitchLogin: "Twitch login",
    suchen: "Find user",
    sucheLäuft: "Searching …",
    nutzerGefunden: "Found user",
    twitchId: (id) => `Twitch ID ${id}`,
    vollzustimmungSetzen: "Set full consent",
    kanalFreigebenFrage: (name) => `Release the channel for ${name}?`,
    kanalFreigebenBeschreibung: (name, id, mitZustimmung) => `${name} (${id}) will be created ${mitZustimmung} full consent.`,
    endgültigFreigeben: "Release permanently",
    einladungslink: "Invitation link",
    einladungslinkHinweis: "Give this link to the streamer. It starts Twitch consent for the selected channel.",
    kanalAuswählen: "Select a channel row first.",
    linkKopieren: "Copy link",
    linkKopiert: "Link copied",
    kanalBearbeiten: (name) => `Edit channel: ${name}`,
    zustimmungUmschalten: "Full consent",
    mitglieder: "Members",
    mitgliederLaden: "Loading members …",
    keineMitglieder: "No additional members have access.",
    mitgliedHinzufügen: "Add member",
    rolle: "Role",
    neueRolle: "Role for new membership",
    hinzufügen: "Add",
    ändern: "Change",
    entfernen: "Remove",
    entfernenFrage: (name) => `Remove access for ${name}?`,
    endgültigEntfernen: "Remove permanently",
    audit: "Operator audit",
    auditLaden: "Loading audit …",
    auditLeer: "No operator actions have been logged yet.",
    zeitpunkt: "Time",
    handlung: "Action",
    akteur: "Actor",
    weitereLaden: "Load more audit entries",
    weitereWerdenGeladen: "Loading more audit entries …",
    betreiber: "Operator",
    mitglied: "Member",
    handlungLabel: {
      "kanal.freigegeben": "Channel released",
      "kanal.vollzustimmung_geaendert": "Full consent changed",
      "mitglied.hinzugefuegt": "Member added",
      "mitglied.rolle_geaendert": "Member role changed",
      "mitglied.entfernt": "Member removed",
    },
  },
};

export const betreiberTexte = (language: DashboardLanguage = dashboardLanguage()): BetreiberTexte => betreiberKatalog[language];

export const betreiberHandlungLabel = (
  handlung: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const texte = betreiberKatalog[language];
  return Object.prototype.hasOwnProperty.call(texte.handlungLabel, handlung)
    ? texte.handlungLabel[handlung as BetreiberHandlung]
    : handlung;
};
