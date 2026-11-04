import type { ModuleLanguage } from "../../contract";

export const pollsCockpitActionTexts: Readonly<Record<ModuleLanguage, {
  startName: string;
  resolveName: string;
  error: string;
  scopeMissing: (scopes: readonly string[]) => string;
  scopeCheckFailed: string;
  noOpenPrediction: string;
  openPredictionCheckFailed: string;
  emptyEntries: string;
  modulePageLink: string;
  choosePrediction: string;
}>> = {
  de: {
    startName: "Umfrage/Prediction starten",
    resolveName: "Prediction auflösen",
    error: "Die Polls-Aktion konnte nicht abgeschlossen werden.",
    scopeMissing: (scopes) => `Verbinde das Broadcaster-Konto und erteile ${scopes.join(" und ")}.`,
    scopeCheckFailed: "Die Broadcaster-Berechtigungen konnten nicht geprüft werden. Aktualisiere die Kanalberechtigungen.",
    noOpenPrediction: "Es gibt keine offene Prediction zum Auflösen.",
    openPredictionCheckFailed: "Offene Predictions konnten nicht geprüft werden. Aktualisiere den Status.",
    emptyEntries: "Es gibt keine vorbereiteten Einträge.",
    modulePageLink: "Einträge auf der Polls-Seite vorbereiten",
    choosePrediction: "Prediction auswählen",
  },
  en: {
    startName: "Start poll/prediction",
    resolveName: "Resolve prediction",
    error: "The polls action could not be completed.",
    scopeMissing: (scopes) => `Connect the broadcaster account and grant ${scopes.join(" and ")}.`,
    scopeCheckFailed: "Broadcaster permissions could not be checked. Refresh the channel permissions.",
    noOpenPrediction: "There is no open prediction to resolve.",
    openPredictionCheckFailed: "Open predictions could not be checked. Refresh the status.",
    emptyEntries: "There are no prepared entries.",
    modulePageLink: "Prepare entries on the Polls page",
    choosePrediction: "Choose a prediction",
  },
};
