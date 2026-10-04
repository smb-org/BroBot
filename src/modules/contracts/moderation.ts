import { z } from "zod";

import type { ModerationFailureReason } from "../../contracts/values";
import type { ModuleLanguage } from "../contract";

export const MODERATION_TIMEOUT_MAX_SECONDS = 1_209_600;

export interface ModerationTimeoutExpectation {
  reason: string;
  durationSeconds: number;
  startedAt: string;
}

export interface TimeoutDurationRange {
  minSeconds: number;
  maxSeconds: number;
}

export type ModerationOutcome = "applied" | "rejected" | "ambiguous";

export interface ModerationResult {
  outcome: ModerationOutcome;
  reason: ModerationFailureReason | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

export const timeoutDurationRangeSchema = (limitSeconds = MODERATION_TIMEOUT_MAX_SECONDS) =>
  z.object({
    minSeconds: z.number().int(),
    maxSeconds: z.number().int(),
  }).refine(({ minSeconds, maxSeconds }) =>
    Number.isSafeInteger(limitSeconds) && limitSeconds >= 1 &&
    minSeconds >= 1 && minSeconds <= maxSeconds && maxSeconds <= limitSeconds,
  { message: "Timeout duration must be within the allowed range." });

export const rollTimeoutSeconds = (
  range: TimeoutDurationRange,
  random: (maximumExclusive: number) => number,
): number => {
  const parsed = timeoutDurationRangeSchema().parse(range);
  if (parsed.minSeconds === parsed.maxSeconds) return parsed.minSeconds;
  const width = parsed.maxSeconds - parsed.minSeconds + 1;
  const offset = random(width);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= width) {
    throw new RangeError("The random timeout value must be within its exclusive bound.");
  }
  return parsed.minSeconds + offset;
};

const DURATION_UNITS = [
  { seconds: 86_400, de: "Tg.", en: "d" },
  { seconds: 3_600, de: "Std.", en: "h" },
  { seconds: 60, de: "Min.", en: "min" },
  { seconds: 1, de: "s", en: "s" },
] as const;

export const formatTimeoutDuration = (seconds: number, language: ModuleLanguage): string => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError("Timeout duration must be a nonnegative safe integer.");
  }
  let remaining = seconds;
  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    const count = Math.floor(remaining / unit.seconds);
    if (count === 0 && (unit.seconds !== 1 || parts.length > 0)) continue;
    parts.push(`${String(count)} ${unit[language]}`);
    remaining %= unit.seconds;
  }
  return parts.join(" ");
};
