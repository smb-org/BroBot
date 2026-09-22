import type { ModuleEvent, ModuleResult } from "../contract";
import type { AdsSettings } from "./contracts";
import { decideAdBreak } from "./domain";

const diagnoseDetail = (
  event: ReturnType<typeof decideAdBreak>,
): Record<string, string | number | boolean | null> => {
  if (event.kind === "skip") {
    return {
      reason: event.reason,
      duration: event.durationSeconds,
      automatic: event.automatic,
    };
  }
  return {
    duration: event.event.durationSeconds,
    automatic: event.event.automatic,
    gestartet: event.event.startedAt,
    endsAt: event.event.endsAt,
    ausloeser: event.event.triggerLogin,
  };
};

const diagnosticCode = (event: ReturnType<typeof decideAdBreak>): string =>
  event.kind === "announce" ? "ads.ankuendigung" : "ads.uebersprungen";

const textMitDauer = (vorlage: string, dauerSekunden: number): string => {
  const text = vorlage.trim();
  return text.includes("{duration}")
    ? text.replaceAll("{duration}", String(dauerSekunden))
    : `${text} (${String(dauerSekunden)} Sekunden)`;
};

export const processAdBreak = (
  event: ModuleEvent<AdsSettings>,
): ModuleResult => {
  const entscheidung = decideAdBreak(event.payload);
  if (entscheidung.kind === "skip") {
    return {
      actions: [],
      diagnostics: [{ code: diagnosticCode(entscheidung), detail: diagnoseDetail(entscheidung) }],
    };
  }

  const vorlage = entscheidung.event.automatic ? event.settings.automatic : event.settings.manual;
  return {
    actions: [{ kind: "chat", text: textMitDauer(vorlage, entscheidung.event.durationSeconds) }],
    diagnostics: [{ code: diagnosticCode(entscheidung), detail: diagnoseDetail(entscheidung) }],
  };
};
