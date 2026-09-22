import type { AdBreaksEvent } from "../contracts";
import type { AdsSettings } from "../contracts";

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export type AdBreaksDecision =
  | { kind: "skip"; reason: "dauer_null" | "dauer_ungueltig" | "start_ungueltig"; durationSeconds: number | null; automatic: boolean }
  | { kind: "announce"; event: AdBreaksEvent };

export const decideAdBreak = (
  payload: Readonly<Record<string, unknown>>,
): AdBreaksDecision => {
  const duration = finiteNumber(payload.duration_seconds) ? payload.duration_seconds : null;
  const automatic = payload.is_automatic === true;
  if (duration === null || duration < 0) {
    return { kind: "skip", reason: "dauer_ungueltig", durationSeconds: duration, automatic };
  }
  if (duration === 0) return { kind: "skip", reason: "dauer_null", durationSeconds: 0, automatic };

  const startedAt = nonEmptyString(payload.started_at);
  const start = startedAt === null ? Number.NaN : Date.parse(startedAt);
  if (startedAt === null || !Number.isFinite(start)) {
    return { kind: "skip", reason: "start_ungueltig", durationSeconds: duration, automatic };
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

export interface AdPrewarningSchedule {
  nextAdAt: string | null;
  lastAdAt: string | null;
}

export interface AdPrewarningInput {
  settings: Pick<AdsSettings, "prewarning" | "leadSeconds" | "prewarningText">;
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
  if (!input.settings.prewarning) return skip("disabled");
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
    text: input.settings.prewarningText.replaceAll("{seconds}", String(seconds)),
    seconds,
    scheduledAt: input.schedule.nextAdAt ?? new Date(nextAdAtMs).toISOString(),
  };
};
