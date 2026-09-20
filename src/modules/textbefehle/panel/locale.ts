import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface TextbefehleTexte {
  titel: string;
  liste: string;
  anlegen: string;
  name: string;
  text: string;
  abkuehlung: string;
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
  nameHinweis: string;
  details: (name: string) => string;
  nie: string;
  vorSekunden: (anzahl: number) => string;
  vorMinuten: (anzahl: number) => string;
  vorStunden: (anzahl: number) => string;
  antwortFehlt: string;
  nameAntwortFehlt: string;
  spalten: {
    name: string;
    text: string;
    abkuehlung: string;
    zuletzt: string;
  };
}

const texte: LocaleCatalog<TextbefehleTexte> = {
  de: {
    titel: "Textbefehle",
    liste: "Befehle",
    anlegen: "Befehl anlegen",
    name: "Name",
    text: "Antworttext",
    abkuehlung: "Abkühlzeit (Sekunden)",
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
    nameHinweis: "Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.",
    details: (name) => `Eigenschaften von !${name}`,
    nie: "noch nie",
    vorSekunden: (anzahl) => `vor ${String(anzahl)} s`,
    vorMinuten: (anzahl) => `vor ${String(anzahl)} min`,
    vorStunden: (anzahl) => `vor ${String(anzahl)} h`,
    antwortFehlt: "Antworttext ausfüllen",
    nameAntwortFehlt: "Name und Antworttext ausfüllen",
    spalten: { name: "!Name", text: "Antwort", abkuehlung: "Abkühl.", zuletzt: "Zuletzt" },
  },
  en: {
    titel: "Text commands",
    liste: "Commands",
    anlegen: "Add command",
    name: "Name",
    text: "Response text",
    abkuehlung: "Cooldown (seconds)",
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
    nameHinweis: "Lowercase letters, numbers, hyphen and underscore.",
    details: (name) => `Properties for !${name}`,
    nie: "never",
    vorSekunden: (anzahl) => `${String(anzahl)} s ago`,
    vorMinuten: (anzahl) => `${String(anzahl)} min ago`,
    vorStunden: (anzahl) => `${String(anzahl)} h ago`,
    antwortFehlt: "Fill in a response",
    nameAntwortFehlt: "Fill in a name and response",
    spalten: { name: "!Name", text: "Response", abkuehlung: "Cooldown", zuletzt: "Last" },
  },
};

export const textbefehleTexte = (language: DashboardLanguage = dashboardLanguage()): TextbefehleTexte => texte[language];
