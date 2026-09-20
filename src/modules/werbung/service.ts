import type { ModuleEvent, ModuleResult } from "../contract";
import type { WerbungSettings } from "./contracts";
import { entscheideWerbepause } from "./domain";

const diagnoseDetail = (
  event: ReturnType<typeof entscheideWerbepause>,
): Record<string, string | number | boolean | null> => {
  if (event.kind === "skip") {
    return {
      grund: event.reason,
      dauer: event.dauerSekunden,
      automatisch: event.automatisch,
    };
  }
  return {
    dauer: event.event.dauerSekunden,
    automatisch: event.event.automatisch,
    gestartet: event.event.gestartetAm,
    ende: event.event.endetAm,
    ausloeser: event.event.ausloeserLogin,
  };
};

const diagnosticCode = (event: ReturnType<typeof entscheideWerbepause>): string =>
  event.kind === "announce" ? "werbung.ankuendigung" : "werbung.uebersprungen";

const textMitDauer = (vorlage: string, dauerSekunden: number): string => {
  const text = vorlage.trim();
  return text.includes("{dauer}")
    ? text.replaceAll("{dauer}", String(dauerSekunden))
    : `${text} (${String(dauerSekunden)} Sekunden)`;
};

export const verarbeiteWerbepause = (
  event: ModuleEvent<WerbungSettings>,
): ModuleResult => {
  const entscheidung = entscheideWerbepause(event.payload);
  if (entscheidung.kind === "skip") {
    return {
      actions: [],
      diagnostics: [{ code: diagnosticCode(entscheidung), detail: diagnoseDetail(entscheidung) }],
    };
  }

  const vorlage = entscheidung.event.automatisch ? event.settings.automatisch : event.settings.manuell;
  return {
    actions: [{ kind: "chat", text: textMitDauer(vorlage, entscheidung.event.dauerSekunden) }],
    diagnostics: [{ code: diagnosticCode(entscheidung), detail: diagnoseDetail(entscheidung) }],
  };
};
