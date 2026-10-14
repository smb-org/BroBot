import { COMMERCIAL_FAILURE_REASONS } from "../contracts/values";
import { PanelApiError } from "../contracts/panel-error";
import { apiErrorText, clipFailureReasonText, commercialFailureReasonText, dashboardTexts, type DashboardLanguage } from "./locale";

export interface ImmediateActionErrorFeedback {
  message: string;
  until: number | null;
}

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const immediateActionErrorFeedback = (
  error: unknown,
  moduleId: string,
  fallback: string,
  language: DashboardLanguage,
): ImmediateActionErrorFeedback => {
  if (!(error instanceof PanelApiError)) return { message: fallback, until: null };
  const details = recordValue(error.details);
  const reason = details?.reason;
  const nested = recordValue(details?.detail);
  const texts = dashboardTexts(language).streamManager.actionErrorActions;

  if (moduleId === "ads" && reason === "commercial_cooldown") {
    const rawUntil = nested?.commercialCooldownUntil;
    const until = typeof rawUntil === "number" && Number.isFinite(rawUntil) && rawUntil > Date.now() ? rawUntil : null;
    if (until !== null) return { message: texts.commercialCooldown("{time}"), until };
  }

  if (moduleId === "ads" && typeof reason === "string" &&
      (reason === "scope_missing" || COMMERCIAL_FAILURE_REASONS.includes(reason as typeof COMMERCIAL_FAILURE_REASONS[number]))) {
    const catalogReason = commercialFailureReasonText(reason, language);
    return {
      message: reason === "scope_missing" ? `${catalogReason}. ${texts.commercialScopeNextStep}` : catalogReason,
      until: null,
    };
  }

  if (moduleId === "clips" && typeof reason === "string") {
    const catalogReason = clipFailureReasonText(reason, language);
    if (catalogReason !== null) {
      return {
        message: reason === "scope_missing" ? `${catalogReason}. ${texts.clipScopeNextStep}` : catalogReason,
        until: null,
      };
    }
  }

  return { message: apiErrorText(error.code, fallback, language), until: null };
};
