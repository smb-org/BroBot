import type { ResolvedModuleEventTime, ModuleAlarmIdentity } from "../contract";
import type { TimerIntervalState, TimerTrigger } from "./contracts";
import {
  eventTimeWindowEnd,
  intervalPartFor,
  nextDailyTimerAt,
  nextIntervalAt,
  nextTimerAt,
  triggerDelayMs,
} from "./domain";
import { sameTimerAlarmIdentity } from "./identity";

/** How long after its deadline a timer occurrence may still be sent. */
export const TIMER_OCCURRENCE_GRACE_MS = 10 * 60_000;

export interface DurableTimerConfig {
  id: string;
  name: string;
  enabled: boolean;
  messageText: string;
  chatTarget: "all_chats" | "source_only" | null;
  trigger: TimerTrigger;
  revision: number;
}

export interface DurableTimerStream {
  state: "online" | "offline" | "unknown";
  streamId: string | null;
  startedAt: string | null;
  generation: number;
}

export interface TimerOccurrence {
  identity: ModuleAlarmIdentity;
  sequence: number;
}

export interface TimerSkipAuditIntent {
  operationId: string;
  actorUserId: string;
  changedAt: string;
  timerId: string;
  timerName: string;
  timerRevision: number;
  skippedOccurrenceAt: string;
  nextOccurrenceAt: string | null;
  retryAttempt: number;
}

interface TimerSendClaim {
  occurrence: TimerOccurrence;
  token: string;
  activityCount: number;
}

export interface DurableTimerEntry {
  config: DurableTimerConfig;
  plannedOccurrence: TimerOccurrence | null;
  /** The planned occurrence the operator explicitly marked to skip. */
  skippedOccurrence?: TimerOccurrence | null;
  /** Effective next-up value while the skipped occurrence remains alarmed. */
  effectiveNextOccurrence?: TimerOccurrence | null;
  /** Idempotency key proving that the committed skip has an audit entry or durable intent. */
  skipAuditOperationId?: string | null;
  inFlightClaim: TimerSendClaim | null;
  planSequence: number;
  mirrorSequence: number;
  activityBaselines: Record<TimerIntervalState, number>;
  lastRunAt: string | null;
  /** Stream id whose stream_start occurrence is done (sent or skipped); never planned again. Absent in old state. */
  completedStreamId?: string | null;
  refreshAt: number | null;
}

export interface DurableTimerState {
  initialized: boolean;
  stream: DurableTimerStream;
  activityCounts: Record<TimerIntervalState, number>;
  timers: Record<string, DurableTimerEntry>;
  tombstones: Record<string, { revision: number; deletedAt: number }>;
  /** Durable outbox committed in the same transaction as its skip marker. */
  pendingSkipAudits?: Record<string, TimerSkipAuditIntent>;
}

export interface TimerScheduleInputs {
  now: number;
  timeZone: string;
  eventTimes: readonly ResolvedModuleEventTime[];
}

export interface TimerPlan {
  identity: ModuleAlarmIdentity | null;
  refreshAt: number | null;
}

export const TIMER_DURABLE_STATE_KEY = "timers:schedule";
export const TIMER_ACTIVITY_COUNTS_KEY = "timers:activity-counts";
export const TIMER_OCCURRENCE_HANDLER = "module:timers:run";
export const TIMER_ALARM_PREFIX = "module:timers:";

export const emptyDurableTimerState = (): DurableTimerState => ({
  initialized: false,
  stream: { state: "unknown", streamId: null, startedAt: null, generation: 0 },
  activityCounts: { live: 0, offline: 0 },
  timers: {},
  tombstones: {},
  pendingSkipAudits: {},
});

export const sameTimerOccurrence = (
  left: TimerOccurrence | null | undefined,
  right: TimerOccurrence | null | undefined,
): boolean => left !== null && left !== undefined && right !== null && right !== undefined &&
  left.sequence === right.sequence && sameTimerAlarmIdentity(left.identity, right.identity);

/** Compares the scheduled occurrence itself, independent of plan revision or sequence changes. */
export const sameTimerScheduledOccurrence = (
  left: TimerOccurrence | null | undefined,
  right: TimerOccurrence | null | undefined,
): boolean => left !== null && left !== undefined && right !== null && right !== undefined &&
  left.identity.timerId === right.identity.timerId && left.identity.triggerType === right.identity.triggerType &&
  left.identity.state === right.identity.state && left.identity.streamId === right.identity.streamId &&
  left.identity.generation === right.identity.generation && left.identity.deadline === right.identity.deadline;

export const makeTimerPlan = (
  config: DurableTimerConfig,
  stream: DurableTimerStream,
  previous: TimerOccurrence | null,
  inputs: TimerScheduleInputs,
  mode: "reset" | "preserve_cadence" | "after_occurrence" = "reset",
  completedStreamId: string | null = null,
): TimerPlan => {
  const { now, timeZone, eventTimes } = inputs;
  if (!config.enabled) return { identity: null, refreshAt: null };
  let deadline: number | null = null;
  let state: TimerIntervalState | null = null;
  let streamId: string | null = null;
  let generation: number | null = null;
  let refreshAt: number | null = null;
  const previousMatchesTrigger = previous !== null && previous.identity.timerId === config.id &&
    previous.identity.triggerType === config.trigger.type;

  if (config.trigger.type === "interval") {
    state = stream.state === "online" ? "live" : stream.state === "offline" ? "offline" : null;
    if (state !== null) {
      const part = intervalPartFor(config.trigger, state);
      if (part !== undefined) {
        streamId = state === "live" ? stream.streamId : null;
        generation = stream.generation;
        const previousMatches = previous !== null &&
          (mode === "preserve_cadence" || previous.identity.revision === config.revision) &&
          previous.identity.triggerType === config.trigger.type && previous.identity.state === state &&
          previous.identity.streamId === streamId && previous.identity.generation === generation;
        if (previousMatches && mode === "after_occurrence") {
          deadline = nextIntervalAt(previous.identity.deadline, now, part.minutes);
        } else if (previousMatches && mode === "preserve_cadence") {
          deadline = previous.identity.deadline;
        } else {
          deadline = now + part.minutes * 60_000;
        }
      }
    }
  } else if (config.trigger.type === "stream_start") {
    if (stream.state === "online" && stream.streamId !== null && stream.startedAt !== null &&
        stream.streamId !== completedStreamId) {
      const dueAt = Date.parse(stream.startedAt) + triggerDelayMs(config.trigger);
      const previousMatches = previous !== null &&
        (mode === "preserve_cadence" || previous.identity.revision === config.revision) &&
        previous.identity.triggerType === config.trigger.type && previous.identity.streamId === stream.streamId &&
        previous.identity.generation === stream.generation;
      if (previousMatches && mode === "after_occurrence") deadline = null;
      else if (previousMatches && mode === "preserve_cadence") deadline = previous.identity.deadline;
      else if (Number.isFinite(dueAt) && dueAt + TIMER_OCCURRENCE_GRACE_MS >= now) deadline = Math.max(dueAt, now);
      streamId = stream.streamId;
      generation = stream.generation;
    }
  } else if (config.trigger.type === "time_of_day") {
    deadline = mode === "preserve_cadence" && previousMatchesTrigger
      ? previous.identity.deadline
      : nextDailyTimerAt(config.trigger, now, timeZone);
  } else {
    deadline = mode === "preserve_cadence" && previousMatchesTrigger
      ? previous.identity.deadline
      : nextTimerAt(config.trigger, { now, timeZone, eventTimes });
    if (deadline === null) refreshAt = eventTimeWindowEnd(now);
  }

  if (deadline === null || !Number.isFinite(deadline)) return { identity: null, refreshAt };
  return {
    identity: {
      timerId: config.id,
      revision: config.revision,
      triggerType: config.trigger.type,
      state,
      streamId,
      generation,
      deadline,
    },
    refreshAt,
  };
};

/** Compares stream start times at second precision (Helix and EventSub differ in sub-second digits). */
export const sameStreamStartedAt = (left: string | null, right: string | null): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.floor(a / 1000) === Math.floor(b / 1000);
};
