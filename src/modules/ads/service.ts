import type { ModuleEvent, ModuleResult } from "../contract";
import type { WerbungSettings } from "./contracts";
import { entscheideWerbepause } from "./domain";

const diagnoseDetail = (
  event: ReturnType<typeof entscheideWerbepause>,
): Record<string, string | number | boolean | null> => {
  if (event.kind === "skip") {
    return {
      reason: event.reason,
      dauer: event.dauerSekunden,
      automatic: event.automatic,
    };
  }
  return {
    dauer: event.event.dauerSekunden,
    automatic: event.event.automatic,
    gestartet: event.event.gestartetAm,
    ende: event.event.endetAm,
    ausloeser: event.event.ausloeserLogin,
  };
};

const diagnosticCode = (event: ReturnType<typeof entscheideWerbepause>): string =>
  event.kind === "announce" ? "ads.ankuendigung" : "ads.uebersprungen";

const textMitDauer = (vorlage: string, dauerSekunden: number): string => {
  const text = vorlage.trim();
  return text.includes("{duration}")
    ? text.replaceAll("{duration}", String(dauerSekunden))
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

  const vorlage = entscheidung.event.automatic ? event.settings.automatic : event.settings.manual;
  return {
    actions: [{ kind: "chat", text: textMitDauer(vorlage, entscheidung.event.dauerSekunden) }],
    diagnostics: [{ code: diagnosticCode(entscheidung), detail: diagnoseDetail(entscheidung) }],
  };
};
