import type { EventCode } from "../../contracts/values";
import { templateVariableNames, type ModuleDiagnostic, type ModuleEvent, type ModuleLanguage, type ModuleResult } from "../contract";
import type { AdsSettings } from "./contracts";
import { decideAdBreak, renderAdBreakText } from "./domain";
import { adsChatLanguage } from "./contracts/language";

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

export function processAdBreak(event: ModuleEvent<AdsSettings>): ModuleResult;
export function processAdBreak(
  event: ModuleEvent<AdsSettings>,
  render: (text: string, values: Readonly<Record<string, string | number>>) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }>,
  language: ModuleLanguage,
): Promise<ModuleResult>;
export function processAdBreak(
  event: ModuleEvent<AdsSettings>,
  render?: (text: string, values: Readonly<Record<string, string | number>>) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }>,
  language: ModuleLanguage = "de",
): ModuleResult | Promise<ModuleResult> {
  const decision = decideAdBreak(event.payload);
  if (decision.kind === "skip") {
    return {
      actions: [],
      diagnostics: [{ code: diagnosticCode(decision), detail: diagnoseDetail(decision) }],
    };
  }

  const template = decision.event.automatic ? event.settings.automatic : event.settings.manual;
  const makeResult = (text: string, templateDiagnostics: readonly ModuleDiagnostic[] = []): ModuleResult => ({
    actions: [{ kind: "chat", text }],
    diagnostics: [...templateDiagnostics, { code: diagnosticCode(decision), detail: diagnoseDetail(decision) }],
  });
  if (render !== undefined) {
    return render(template, { duration: decision.event.durationSeconds }).then(({ text, diagnostics }) => {
      const hasDuration = templateVariableNames(template.trim()).includes("duration");
      const completed = hasDuration ? text : `${text} (${String(decision.event.durationSeconds)} ${adsChatLanguage[language].seconds})`;
      return makeResult(completed, diagnostics);
    });
  }
  return makeResult(renderAdBreakText(template, decision.event.durationSeconds));
}
