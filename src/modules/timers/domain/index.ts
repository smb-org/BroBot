import type { ResolvedModuleEventTime } from "../../contract";
import type { TimerTrigger } from "../contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const localDateInTimeZone = (instant: number, timeZone: string): string => {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${String(values.year)}-${String(values.month)}-${String(values.day)}`;
};

export const shiftLocalDate = (date: string, amount: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) throw new RangeError("Invalid local calendar date.");
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount));
  return `${String(shifted.getUTCFullYear())}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
};

const weekdayFor = (localDate: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (match === null) throw new RangeError("Invalid local calendar date.");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
};

const wallTimeInTimeZone = (localDate: string, time: string, timeZone: string): number => {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  const clock = /^(\d{2}):(\d{2})$/u.exec(time);
  if (date === null || clock === null) throw new RangeError("Invalid local date or time.");
  const target = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(clock[1]), Number(clock[2]));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const requestedMinute = Number(clock[1]) * 60 + Number(clock[2]);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = target + hours * 60 * 60_000;
    const parts = Object.fromEntries(formatter.formatToParts(sample).map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    offsets.add(localAsUtc - sample);
  }
  const candidates = [...offsets].map((offset) => {
    const at = target - offset;
    const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
    return {
      at,
      date: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`,
      minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
  });
  const matching = candidates.filter((candidate) => candidate.date === localDate && candidate.minute === requestedMinute);
  if (matching.length > 0) return matching.sort((left, right) => left.at - right.at)[0]?.at ?? target;
  // A forward clock change can remove a wall time. Use the first observed
  // local time after the requested minute (for example 02:30 becomes 03:30).
  const afterGap = candidates.filter((candidate) => candidate.date === localDate && candidate.minute > requestedMinute)
    .sort((left, right) => left.minute - right.minute || left.at - right.at);
  return afterGap[0]?.at ?? target;
};

export const nextDailyTimerAt = (
  trigger: Extract<TimerTrigger, { type: "time_of_day" }>,
  from: number,
  timeZone: string,
): number | null => {
  const firstDate = localDateInTimeZone(from, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = shiftLocalDate(firstDate, offset);
    if (trigger.weekdays.length > 0 && !trigger.weekdays.includes(weekdayFor(date))) continue;
    const at = wallTimeInTimeZone(date, trigger.time, timeZone);
    if (at > from) return at;
  }
  return null;
};

export const nextBeforeEventAt = (
  trigger: Extract<TimerTrigger, { type: "before_event" }>,
  events: readonly ResolvedModuleEventTime[],
  now: number,
): number | null => {
  const leadMs = trigger.minutes * 60_000;
  return events
    .filter((event) => event.id === trigger.sourceId)
    .map((event) => Date.parse(event.at) - leadMs)
    .filter((at) => Number.isFinite(at) && at > now)
    .sort((left, right) => left - right)[0] ?? null;
};

export const nextIntervalAt = (deadline: number, now: number, everyMinutes: number): number => {
  const intervalMs = everyMinutes * 60_000;
  if (deadline > now) return deadline;
  return deadline + (Math.floor((now - deadline) / intervalMs) + 1) * intervalMs;
};

export const nextTimerAt = (
  trigger: TimerTrigger,
  input: {
    now: number;
    timeZone: string;
    eventTimes?: readonly ResolvedModuleEventTime[];
  },
): number | null => {
  if (trigger.type === "time_of_day") return nextDailyTimerAt(trigger, input.now, input.timeZone);
  if (trigger.type === "before_event") return nextBeforeEventAt(trigger, input.eventTimes ?? [], input.now);
  return null;
};

export const timerOccurrenceKey = (timerId: string, dueAt: number): string =>
  `${timerId}:${String(Math.trunc(dueAt))}`;

export const triggerDelayMs = (trigger: Extract<TimerTrigger, { type: "interval" | "stream_start" }>): number =>
  trigger.minutes * 60_000;

export const nextStreamStartAt = (startedAt: string | null, now: number, delayMs: number): number | null => {
  if (startedAt === null) return null;
  const start = Date.parse(startedAt);
  const dueAt = start + delayMs;
  return Number.isFinite(start) && dueAt > now ? dueAt : null;
};

export const eventTimeWindowEnd = (now: number): number => now + 14 * DAY_MS;
