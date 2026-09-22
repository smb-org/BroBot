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
    startedAt: event.event.startedAt,
    endsAt: event.event.endsAt,
    triggerLogin: event.event.triggerLogin,
  };
};

const diagnosticCode = (event: ReturnType<typeof decideAdBreak>): string =>
  event.kind === "announce" ? "ads.ankuendigung" : "ads.uebersprungen";

const textWithDuration = (template: string, durationSeconds: number): string => {
  const text = template.trim();
  return text.includes("{duration}")
    ? text.replaceAll("{duration}", String(durationSeconds))
    : `${text} (${String(durationSeconds)} Sekunden)`;
};

export const processAdBreak = (
  event: ModuleEvent<AdsSettings>,
): ModuleResult => {
  const decision = decideAdBreak(event.payload);
  if (decision.kind === "skip") {
    return {
      actions: [],
      diagnostics: [{ code: diagnosticCode(decision), detail: diagnoseDetail(decision) }],
    };
  }

  const template = decision.event.automatic ? event.settings.automatic : event.settings.manual;
  return {
    actions: [{ kind: "chat", text: textWithDuration(template, decision.event.durationSeconds) }],
    diagnostics: [{ code: diagnosticCode(decision), detail: diagnoseDetail(decision) }],
  };
};
