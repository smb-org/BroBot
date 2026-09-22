import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { TextbefehlMindeststufe } from "../contracts";

interface TextbefehleTexte {
  titel: string;
  liste: string;
  anlegen: string;
  name: string;
  kind: string;
  artText: string;
  artListe: string;
  text: string;
  abkuehlung: string;
  mindeststufe: string;
  mindeststufeFuer: (name: string) => string;
  mindeststufeGesperrt: string;
  stufen: Record<TextbefehlMindeststufe, string>;
  schalter: (name: string, enabled: boolean) => string;
  verwaltungGesperrt: string;
  speichern: (name: string) => string;
  loeschen: (name: string) => string;
  loeschenTitel: (name: string) => string;
  loeschenBestaetigung: (name: string) => string;
  loeschungBestaetigen: (name: string) => string;
  leer: string;
  laden: string;
  fehler: string;
  speichernFehler: string;
  loeschenFehler: string;
  zahlFehlt: string;
  nameHinweis: string;
  details: (name: string) => string;
  nie: string;
  vorSekunden: (anzahl: number) => string;
  vorMinuten: (anzahl: number) => string;
  vorStunden: (anzahl: number) => string;
  antwortFehlt: string;
  nameFehlt: string;
  nameAntwortFehlt: string;
  spalten: {
    name: string;
    kind: string;
    text: string;
    abkuehlung: string;
    zuletzt: string;
    mindeststufe: string;
    aktiv: string;
  };
}

const texte: LocaleCatalog<TextbefehleTexte> = {
  de: {
    titel: "Textbefehle",
    liste: "Befehle",
    anlegen: "Befehl anlegen",
    name: "Name",
    kind: "Art",
    artText: "Antworttext",
    artListe: "Befehlsliste",
    text: "Antworttext",
    abkuehlung: "Abkühlzeit (Sekunden)",
    mindeststufe: "Mindeststufe",
    mindeststufeFuer: (name) => `Mindeststufe für Befehl !${name}`,
    mindeststufeGesperrt: "Nur Broadcaster und Verwalter dürfen Mindeststufen ändern.",
    stufen: { everyone: "Alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    schalter: (name, enabled) => `Befehl !${name}: ${enabled ? "eingeschaltet" : "ausgeschaltet"}`,
    verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.",
    speichern: (name) => `Befehl !${name} speichern`,
    loeschen: (name) => `Befehl !${name} löschen`,
    loeschenTitel: (name) => `Befehl !${name} löschen?`,
    loeschenBestaetigung: (name) => `Der Textbefehl !${name} wird dauerhaft gelöscht. Diese Handlung kann nicht rückgängig gemacht werden.`,
    loeschungBestaetigen: (name) => `Befehl !${name} endgültig löschen`,
    leer: "Noch keine Textbefehle angelegt.",
    laden: "Textbefehle werden geladen …",
    fehler: "Die Textbefehle konnten nicht geladen werden.",
    speichernFehler: "Der Textbefehl konnte nicht gespeichert werden.",
    loeschenFehler: "Der Textbefehl konnte nicht gelöscht werden.",
    zahlFehlt: "Zahl eingeben",
    nameHinweis: "Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.",
    details: (name) => `Eigenschaften von !${name}`,
    nie: "noch nie",
    vorSekunden: (anzahl) => `vor ${String(anzahl)} s`,
    vorMinuten: (anzahl) => `vor ${String(anzahl)} min`,
    vorStunden: (anzahl) => `vor ${String(anzahl)} h`,
    antwortFehlt: "Antworttext ausfüllen",
    nameFehlt: "Namen ausfüllen",
    nameAntwortFehlt: "Name und Antworttext ausfüllen",
    spalten: { name: "!Name", kind: "Art", text: "Antwort", abkuehlung: "Abkühl.", zuletzt: "Zuletzt", mindeststufe: "Mindeststufe", aktiv: "Schalter" },
  },
  en: {
    titel: "Text commands",
    liste: "Commands",
    anlegen: "Add command",
    name: "Name",
    kind: "Type",
    artText: "Response text",
    artListe: "Command list",
    text: "Response text",
    abkuehlung: "Cooldown (seconds)",
    mindeststufe: "Minimum level",
    mindeststufeFuer: (name) => `Minimum level for !${name}`,
    mindeststufeGesperrt: "Only broadcasters and managers may change minimum levels.",
    stufen: { everyone: "Everyone", subscriber: "Subscribers", vip: "VIPs", moderator: "Moderators", broadcaster: "Broadcaster" },
    schalter: (name, enabled) => `Command !${name}: ${enabled ? "enabled" : "disabled"}`,
    verwaltungGesperrt: "Only broadcasters and managers may add, edit, or delete commands.",
    speichern: (name) => `Save !${name}`,
    loeschen: (name) => `Delete !${name}`,
    loeschenTitel: (name) => `Delete !${name}?`,
    loeschenBestaetigung: (name) => `The text command !${name} will be deleted permanently. This action cannot be undone.`,
    loeschungBestaetigen: (name) => `Delete !${name} permanently`,
    leer: "No text commands yet.",
    laden: "Loading text commands …",
    fehler: "The text commands could not be loaded.",
    speichernFehler: "The text command could not be saved.",
    loeschenFehler: "The text command could not be deleted.",
    zahlFehlt: "Enter a number",
    nameHinweis: "Lowercase letters, numbers, hyphen and underscore.",
    details: (name) => `Properties for !${name}`,
    nie: "never",
    vorSekunden: (anzahl) => `${String(anzahl)} s ago`,
    vorMinuten: (anzahl) => `${String(anzahl)} min ago`,
    vorStunden: (anzahl) => `${String(anzahl)} h ago`,
    antwortFehlt: "Fill in a response",
    nameFehlt: "Fill in a name",
    nameAntwortFehlt: "Fill in a name and response",
    spalten: { name: "!Name", kind: "Type", text: "Response", abkuehlung: "Cooldown", zuletzt: "Last", mindeststufe: "Minimum level", aktiv: "Switch" },
  },
};

export const textbefehleTexte = (language: DashboardLanguage = dashboardLanguage()): TextbefehleTexte => texte[language];
