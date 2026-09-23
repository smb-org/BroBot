import type { EventCode } from "../../contracts/values";
import type { ModuleEvent, ModuleResult } from "../contract";
import type { AdsSettings } from "./contracts";
import { decideAdBreak, renderAdBreakText } from "./domain";

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

const diagnosticCode = (event: ReturnType<typeof decideAdBreak>): EventCode =>
  event.kind === "announce" ? "ads.announcement" : "ads.skipped";

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
    actions: [{ kind: "chat", text: renderAdBreakText(template, decision.event.durationSeconds) }],
    diagnostics: [{ code: diagnosticCode(decision), detail: diagnoseDetail(decision) }],
  };
};
