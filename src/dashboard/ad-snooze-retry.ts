import { PanelApiError } from "../contracts/panel-error";
import { dashboardLanguage } from "./locale";

export const adSnoozeRetryMessage = (error: unknown, timeZone: string, messageForTime: (time: string) => string): string | null => {
  if (!(error instanceof PanelApiError) || error.status !== 429) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const detail = (details as Record<string, unknown>).detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const retryAfter = (detail as Record<string, unknown>).retryAfter;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= Date.now()) return null;
  const time = new Intl.DateTimeFormat(dashboardLanguage(), { hour: "2-digit", minute: "2-digit", timeZone }).format(retryAfter);
  return messageForTime(time);
};
