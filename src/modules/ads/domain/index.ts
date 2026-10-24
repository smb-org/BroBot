import type { AdsSkippedReason } from "../../../contracts/values";
import { isMessageEnabled } from "../../../contracts/message-enabled";
import type { ADS_TEMPLATE_FIELDS, AdBreaksEvent, AdsSettings } from "../contracts";
import { renderTemplate, templateVariableNames, type ModuleLanguage } from "../contract";
import type { TemplateValues } from "../contract";
import { adsChatLanguage } from "../contracts/language";

export const localizeAdDurationGrammar = (text: string, duration: number, language: ModuleLanguage): string => {
  const unit = duration === 1 ? adsChatLanguage[language].second : adsChatLanguage[language].seconds;
  const units = language === "de" ? "Sekunden?" : "seconds?";
  return text.replace(new RegExp(`\\b${String(duration)}\\s+${units}\\b`, "gu"), `${String(duration)} ${unit}`);
};

export const renderAdBreakText = (template: string, duration: number, language: ModuleLanguage = "de"): string => {
  const normalized = template.trim();
  const values: TemplateValues<typeof ADS_TEMPLATE_FIELDS.automatic> = { "ads.duration": duration };
  const rendered = templateVariableNames(normalized).includes("ads.duration")
    ? renderTemplate(normalized, values)
    : `${renderTemplate(normalized, {})} (${String(duration)} ${duration === 1 ? adsChatLanguage[language].second : adsChatLanguage[language].seconds})`;
  return localizeAdDurationGrammar(rendered, duration, language);
};

export const renderPrewarningText = (
  template: string,
  values: TemplateValues<typeof ADS_TEMPLATE_FIELDS.prewarningText>,
): string => renderTemplate(template, values);

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export type AdBreaksDecision =
  | { kind: "skip"; reason: AdsSkippedReason; durationSeconds: number | null; automatic: boolean }
  | { kind: "announce"; event: AdBreaksEvent };

export const decideAdBreak = (
  payload: Readonly<Record<string, unknown>>,
): AdBreaksDecision => {
  const duration = finiteNumber(payload.duration_seconds) ? payload.duration_seconds : null;
  const automatic = payload.is_automatic === true;
  if (duration === null || duration < 0) {
    return { kind: "skip", reason: "duration_invalid", durationSeconds: duration, automatic };
  }
  if (duration === 0) return { kind: "skip", reason: "duration_zero", durationSeconds: 0, automatic };

  const startedAt = nonEmptyString(payload.started_at);
  const start = startedAt === null ? Number.NaN : Date.parse(startedAt);
  if (startedAt === null || !Number.isFinite(start)) {
    return { kind: "skip", reason: "start_invalid", durationSeconds: duration, automatic };
  }

  const triggerLogin = nonEmptyString(payload.requester_user_login) ??
    nonEmptyString(payload.requester_user_name);
  return {
    kind: "announce",
    event: {
      durationSeconds: duration,
      startedAt,
      endsAt: new Date(start + duration * 1000).toISOString(),
      automatic,
      triggerLogin,
    },
  };
};

interface AdPrewarningSchedule {
  nextAdAt: string | null;
  lastAdAt: string | null;
}

export interface AdPrewarningInput {
  settings: Pick<AdsSettings, "leadSeconds" | "prewarningText" | "prewarningTextEnabled">;
  scopeAvailable: boolean;
  nowAtMs: number;
  plannedAtMs: number;
  schedule: AdPrewarningSchedule;
}

export type AdPrewarningDecision =
  | { kind: "skip"; reason: "disabled" | "scope_missing" | "no_schedule" | "too_late" | "break_started" | "rescheduled"; detail: Readonly<Record<string, string | number | boolean | null>> }
  | { kind: "announce"; text: string; seconds: number; scheduledAt: string };

const dateMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The alarm never fires early, but regularly fires a few milliseconds late.
 * Without slack, the remaining time would therefore *always* be just under
 * the lead time, and the prewarning would fail every time in production,
 * while a test with exact timestamps would pass.
 */
const MINIMUM_LEAD_MS = 5_000;

/** Two timestamps within this window count as the same schedule. */
const SCHEDULE_TOLERANCE_MS = 2_000;

const skip = (
  reason: Exclude<AdPrewarningDecision, { kind: "announce" }>["reason"],
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): AdPrewarningDecision => ({ kind: "skip", reason, detail });

export const decideAdPrewarning = (
  input: AdPrewarningInput,
): AdPrewarningDecision => {
  if (!isMessageEnabled(input.settings, "prewarningText", "prewarningTextEnabled")) return skip("disabled");
  if (!input.scopeAvailable) return skip("scope_missing", { scope: "channel:read:ads" });

  const nextAdAtMs = dateMs(input.schedule.nextAdAt);
  if (nextAdAtMs === null) return skip("no_schedule");

  const lastAdAtMs = dateMs(input.schedule.lastAdAt);
  if (lastAdAtMs !== null && lastAdAtMs >= input.plannedAtMs) {
    return skip("break_started", { lastAdBreakAt: input.schedule.lastAdAt });
  }
  if (Math.abs(nextAdAtMs - input.plannedAtMs) > SCHEDULE_TOLERANCE_MS) {
    return skip("rescheduled", {
      scheduledFor: new Date(input.plannedAtMs).toISOString(),
      current: input.schedule.nextAdAt,
    });
  }

  const remainingMs = nextAdAtMs - input.nowAtMs;
  if (remainingMs < MINIMUM_LEAD_MS) {
    return skip("too_late", { remainingSeconds: Math.max(0, Math.round(remainingMs / 1000)) });
  }

  // The announcement uses the actually remaining time, not the configured
  // lead time: if the alarm fires later or Twitch shifted the schedule
  // slightly, the text would otherwise be wrong.
  const seconds = Math.round(remainingMs / 1000);
  return {
    kind: "announce",
    text: renderPrewarningText(input.settings.prewarningText, { "ads.seconds": seconds }),
    seconds,
    scheduledAt: input.schedule.nextAdAt ?? new Date(nextAdAtMs).toISOString(),
  };
};
