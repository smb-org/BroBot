import { PanelApiError } from "../../../contracts/panel-error";
import type { AdsPanelTexts } from "./locale";

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const rateLimitWaitMessage = (error: unknown, labels: AdsPanelTexts): string | null => {
  if (!(error instanceof PanelApiError)) return null;
  const details = recordValue(error.details);
  const detail = recordValue(details?.detail);
  const retryAfter = detail?.retryAfter;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= Date.now()) return null;
  return labels.rateLimited(Math.max(1, Math.ceil((retryAfter - Date.now()) / 1000)));
};

export const adFailureReason = (error: unknown): string | null => {
  if (!(error instanceof PanelApiError)) return null;
  const details = recordValue(error.details);
  return typeof details?.reason === "string" ? details.reason : null;
};
