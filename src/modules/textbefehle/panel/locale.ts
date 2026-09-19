import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";

interface TextbefehleTexte {
  titel: string;
  anlegen: string;
  name: string;
  text: string;
  abkuehlung: string;
  speichern: (name: string) => string;
  loeschen: (name: string) => string;
  leer: string;
  laden: string;
  fehler: string;
  speichernFehler: string;
  nameHinweis: string;
}

const texte: Record<DashboardLanguage, TextbefehleTexte> = {
  de: {
    titel: "Textbefehle",
    anlegen: "Befehl anlegen",
    name: "Name",
    text: "Antworttext",
    abkuehlung: "Abkühlzeit (Sekunden)",
    speichern: (name) => `Befehl !${name} speichern`,
    loeschen: (name) => `Befehl !${name} löschen`,
    leer: "Noch keine Textbefehle angelegt.",
    laden: "Textbefehle werden geladen …",
    fehler: "Die Textbefehle konnten nicht geladen werden.",
    speichernFehler: "Der Textbefehl konnte nicht gespeichert werden.",
    nameHinweis: "Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.",
  },
  en: {
    titel: "Text commands",
    anlegen: "Add command",
    name: "Name",
    text: "Response text",
    abkuehlung: "Cooldown (seconds)",
    speichern: (name) => `Save !${name}`,
    loeschen: (name) => `Delete !${name}`,
    leer: "No text commands yet.",
    laden: "Loading text commands …",
    fehler: "The text commands could not be loaded.",
    speichernFehler: "The text command could not be saved.",
    nameHinweis: "Lowercase letters, numbers, hyphen and underscore.",
  },
};

export const textbefehleTexte = (): TextbefehleTexte => texte[dashboardLanguage()];
