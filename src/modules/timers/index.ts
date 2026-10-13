import { z } from "zod";

import { columnVariableReferences } from "../contract";
import type { BotModule, ModuleScheduleInputChangeReason, ModuleTemplateUsageSource } from "../contract";
import type { Timer, TimerIntervalState } from "./contracts";
import { timersModuleCatalog } from "./contracts/catalog";
import { mapTimerRow, validateTimerTemplateMutation, type TimerRow } from "./service";
import {
  alarmKeyFor,
  eventTimeRefreshKeyFor,
  eventTimeWindowEnd,
  isDailyTimerDeadlineCurrent,
  intervalPartFor,
  nextDailyTimerAt,
  nextIntervalAt,
  nextStreamStartAt,
  nextTimerAt,
  timerOccurrenceKey,
  triggerDelayMs,
} from "./domain";
import { timerRoutes } from "./routes";
import { persistIntervalTimerPlan } from "./scheduling";
import { sameTimerAlarmIdentity, timerAlarmIdentity } from "./identity";

const settingsSchema = z.object({});
const TIMER_MODULE_ID = "timers";
const TIMER_ALARM_HANDLER = "run";
const TIMER_OCCURRENCE_GRACE_MS = 10 * 60_000;

const listTimers = async (db: D1Database, channelId: string): Promise<Timer[]> => {
  const result = await db.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
            last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id`,
  ).bind(channelId).all<TimerRow>();
  return result.results.map(mapTimerRow);
};
type TimerAlarmContext = Parameters<NonNullable<BotModule["alarms"]>[number]["handle"]>[0];

/**
 * `streamId` tags `next_run_at` with the stream it was armed for -- interval
 * and stream_start triggers are the only stream-scoped kinds, everything
 * else always stores a null stream id. Clearing the deadline (`at === null`)
 * always clears the stream id with it, so a cleared schedule can never look
 * armed for a stream it no longer belongs to.
 */
const saveNextRunAt = async (
  db: D1Database,
  channelId: string,
  timer: Timer,
  at: number | null,
  streamId: string | null = null,
  state: TimerIntervalState | null = null,
  expectedPlan: Timer,
  streamGeneration?: number,
): Promise<boolean> => {
  const generation = at !== null && (timer.trigger.type === "interval" || timer.trigger.type === "stream_start")
    ? streamGeneration ?? null
    : null;
  const result = await db.prepare(
    `UPDATE timers SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?, next_run_generation = ?,
                        next_run_plan_sequence = next_run_plan_sequence + 1
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = 1
        AND (? IS NULL OR COALESCE((SELECT transition_generation FROM channel_stream_state
                                     WHERE channel_id = timers.channel_id), 0) = ?)
        AND trigger_type IS ? AND next_run_at IS ? AND next_run_stream_id IS ? AND
            next_run_state IS ? AND next_run_generation IS ? AND next_run_plan_sequence = ?`,
  ).bind(at === null ? null : new Date(at).toISOString(), at === null ? null : streamId, at === null ? null : state,
    generation, channelId, timer.id, timer.revision, streamGeneration ?? null, streamGeneration ?? null,
    expectedPlan.trigger.type, expectedPlan.nextRunAt, expectedPlan.nextRunStreamId, expectedPlan.nextRunState,
    expectedPlan.nextRunGeneration, expectedPlan.nextRunPlanSequence).run();
  return result.meta.changes > 0;
};

const streamTransitionGeneration = async (db: D1Database, channelId: string): Promise<number> => {
  const row = await db.prepare("SELECT transition_generation FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ transition_generation: number }>();
  return row?.transition_generation ?? 0;
};

const streamStateSnapshot = async (
  db: D1Database,
  channelId: string,
): Promise<{
  state: "online" | "offline" | "unknown";
  streamId: string | null;
  generation: number;
}> => {
  const row = await db.prepare(
    "SELECT state, stream_id, transition_generation FROM channel_stream_state WHERE channel_id = ?",
  ).bind(channelId).first<{
    state: "online" | "offline" | "unknown";
    stream_id: string | null;
    transition_generation: number;
  }>();
  return {
    state: row?.state ?? "unknown",
    streamId: row?.stream_id ?? null,
    generation: row?.transition_generation ?? 0,
  };
};

const persistedTimerAlarmIdentity = (timer: Timer) => timer.nextRunAt === null
  ? null
  : timerAlarmIdentity(timer, Date.parse(timer.nextRunAt), timer.nextRunState,
    timer.nextRunStreamId, timer.nextRunGeneration);

const persistAndSchedule = async (
  timer: Timer,
  context: TimerAlarmContext,
  nextAt: number | null,
  streamId: string | null = null,
  state: TimerIntervalState | null = null,
  expectedStreamGeneration?: number,
): Promise<boolean> => {
  const streamScoped = timer.trigger.type === "interval" || timer.trigger.type === "stream_start";
  const streamGeneration = streamScoped
    ? expectedStreamGeneration ?? await streamTransitionGeneration(context.DB, context.channelId)
    : null;
  const generation = nextAt !== null && streamScoped ? streamGeneration : null;
  if (!await saveNextRunAt(context.DB, context.channelId, timer, nextAt, streamId, state,
    timer, streamGeneration ?? undefined)) return false;
  const key = alarmKeyFor(timer.id);
  const planSequence = timer.nextRunPlanSequence + 1;
  const expectedIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
    timer, Date.parse(timer.nextRunAt), timer.nextRunState, timer.nextRunStreamId, timer.nextRunGeneration,
  );
  if (nextAt === null) await context.clear(key, timer.revision, streamGeneration, expectedIdentity, planSequence);
  else await context.schedule(key, nextAt, timer.revision, streamGeneration,
    timerAlarmIdentity(timer, nextAt, state, streamId, generation), planSequence);
  return true;
};

const persistIntervalReplanAndSchedule = async (
  timer: Timer,
  context: TimerAlarmContext,
  nextAt: number | null,
  streamId: string | null,
  state: TimerIntervalState | null,
  streamGeneration?: number,
): Promise<boolean> => {
  if (timer.trigger.type !== "interval") return false;
  const expectedGeneration = streamGeneration ?? await streamTransitionGeneration(context.DB, context.channelId);
  const activityCount = await context.chatActivityCount();
  if (!await persistIntervalTimerPlan(context.DB, context.channelId, timer, nextAt, streamId, state,
    activityCount, expectedGeneration, timer)) return false;
  const key = alarmKeyFor(timer.id);
  const planSequence = timer.nextRunPlanSequence + 1;
  const expectedIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
    timer, Date.parse(timer.nextRunAt), timer.nextRunState, timer.nextRunStreamId, timer.nextRunGeneration,
  );
  if (nextAt === null) await context.clear(key, timer.revision, expectedGeneration, expectedIdentity, planSequence);
  else await context.schedule(key, nextAt, timer.revision, expectedGeneration,
    timerAlarmIdentity(timer, nextAt, state, streamId, expectedGeneration), planSequence);
  return true;
};

const timeZoneFor = async (context: TimerAlarmContext): Promise<string> => {
  const row = await context.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
    .bind(context.channelId).first<{ time_zone: string }>();
  return row?.time_zone ?? "Europe/Berlin";
};

const nextDeadlineFor = async (
  timer: Timer,
  context: TimerAlarmContext,
  now: number,
  previousDeadline = now,
): Promise<{
  at: number | null;
  streamId: string | null;
  state: TimerIntervalState | null;
  streamGeneration?: number;
}> => {
  if (timer.trigger.type === "interval") {
    const stream = await streamStateSnapshot(context.DB, context.channelId);
    const state: TimerIntervalState | null = stream.state === "online" ? "live" : stream.state === "offline" ? "offline" : null;
    if (state === null) return { at: null, streamId: null, state: null, streamGeneration: stream.generation };
    const part = intervalPartFor(timer.trigger, state);
    if (part === undefined) return { at: null, streamId: null, state: null, streamGeneration: stream.generation };
    const currentIdentity = persistedTimerAlarmIdentity(timer);
    const candidateIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
      timer, Date.parse(timer.nextRunAt), state, state === "live" ? stream.streamId : null, stream.generation,
    );
    const samePlan = sameTimerAlarmIdentity(currentIdentity, candidateIdentity);
    const deadline = samePlan
      ? nextIntervalAt(previousDeadline, now, part.minutes)
      : now + part.minutes * 60_000;
    return { at: deadline, streamId: state === "live" ? stream.streamId : null, state, streamGeneration: stream.generation };
  }
  if (timer.trigger.type === "stream_start") return { at: null, streamId: null, state: null };
  const timeZone = await timeZoneFor(context);
  if (timer.trigger.type === "time_of_day") return { at: nextDailyTimerAt(timer.trigger, now, timeZone), streamId: null, state: null };
  return { at: nextTimerAt(timer.trigger, { now, timeZone, eventTimes: await context.resolveEventTimes(now) }), streamId: null, state: null };
};

/**
 * Plans the next run and, for a `before_event` timer whose source reports no
 * occurrence inside its own horizon, schedules a replan check at that
 * horizon instead of leaving the timer without any alarm at all -- an event
 * source's horizon is bounded (e.g. a fixed number of days ahead), so a long
 * enough gap in its occurrences would otherwise leave the timer dormant even
 * once the source starts reporting events again.
 */
const scheduleNextRun = async (
  timer: Timer,
  context: TimerAlarmContext,
  now: number,
  previousDeadline = now,
): Promise<boolean> => {
  const { at: deadline, streamId, state, streamGeneration } = await nextDeadlineFor(timer, context, now, previousDeadline);
  if (timer.trigger.type === "interval") {
    const nextState = deadline === null ? null : state;
    const nextStreamId = deadline === null ? null : streamId;
    const planChanged = timer.nextRunAt === null
      ? deadline !== null || timer.nextRunState !== null || timer.nextRunStreamId !== null
      : deadline === null || timer.nextRunState !== nextState || timer.nextRunStreamId !== nextStreamId ||
        timer.nextRunGeneration !== (streamGeneration ?? null);
    if (planChanged) {
      const scheduled = await persistIntervalReplanAndSchedule(timer, context, deadline, streamId, state, streamGeneration);
      if (scheduled) return true;
      return false;
    }
  }
  const scheduled = await persistAndSchedule(timer, context, deadline, streamId, state, streamGeneration);
  if (scheduled && deadline === null && timer.trigger.type === "before_event") {
    const horizon = eventTimeWindowEnd(now);
    await context.schedule(eventTimeRefreshKeyFor(timer.id, horizon), horizon);
  }
  return scheduled;
};

const rescheduleAfterRun = async (
  timer: Timer,
  context: TimerAlarmContext,
  deadline: number,
): Promise<void> => {
  if (await scheduleNextRun(timer, context, Date.now(), deadline)) return;
  const row = await context.DB.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
            last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(context.channelId, timer.id).first<TimerRow>();
  if (row === null) return;
  const current = mapTimerRow(row);
  if (sameTimerAlarmIdentity(persistedTimerAlarmIdentity(timer), persistedTimerAlarmIdentity(current)) &&
      current.nextRunPlanSequence === timer.nextRunPlanSequence) return;
  // A template-only rename can advance the timer revision while its alarm is
  // already running. If that made the old revision's reschedule a no-op, arm
  // the next occurrence from the current row, without overriding a timer edit
  // that already changed or cleared the stored deadline.
  await scheduleNextRun(current, context, Date.now(), deadline);
};

/**
 * Rearms a stream-scoped timer (interval, stream_start) for `stream` and
 * resets its chat baseline, exactly like the accepted `stream.online` path,
 * so leftover chat from whatever stream the previous schedule belonged to
 * cannot satisfy `minimumMessages` for this one. Shared by the activation
 * replan and by the alarm handler's own stream-id mismatch check below,
 * since both rearm a stale schedule the same way.
 */
const rearmStreamScopedTimer = async (
  timer: Timer,
  context: TimerAlarmContext,
  now: number,
  stream: { streamId: string; startedAt: string | null },
  streamGeneration?: number,
): Promise<void> => {
  if (timer.trigger.type === "interval") {
    await rearmIntervalTimer(timer, context, now, "live", stream.streamId, streamGeneration);
    return;
  }
  if (timer.trigger.type !== "stream_start") return;
  const expectedDeadline = stream.startedAt === null
    ? Number.NaN
    : Date.parse(stream.startedAt) + triggerDelayMs(timer.trigger);
  const deadline = nextStreamStartAt(stream.startedAt, now, triggerDelayMs(timer.trigger)) ??
    (timer.nextRunAt !== null && Date.parse(timer.nextRunAt) === expectedDeadline ? expectedDeadline : null);
  await persistAndSchedule(timer, context, deadline, deadline === null ? null : stream.streamId, null, streamGeneration);
};

const replanStreamStartTimer = async (timer: Timer, context: TimerAlarmContext, now: number): Promise<void> => {
  if (timer.trigger.type !== "stream_start") return;
  const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
  const generation = await streamTransitionGeneration(context.DB, context.channelId);
  if (state === "online" && stream.streamId !== null) {
    const identity = persistedTimerAlarmIdentity(timer);
    const candidateIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
      timer, Date.parse(timer.nextRunAt), null, stream.streamId, generation,
    );
    const planMatchesStream = sameTimerAlarmIdentity(identity, candidateIdentity);
    if (planMatchesStream) {
      const storedPlan = await context.getAlarmPlan?.(alarmKeyFor(timer.id));
      if (storedPlan !== undefined && storedPlan !== null &&
          sameTimerAlarmIdentity(identity, storedPlan.identity) &&
          storedPlan.planSequence === timer.nextRunPlanSequence) return;
      await persistAndSchedule(timer, context, Date.parse(timer.nextRunAt as string),
        timer.nextRunStreamId, null, generation);
      return;
    }
    await rearmStreamScopedTimer(timer, context, now,
      { streamId: stream.streamId, startedAt: stream.startedAt }, generation);
  } else if (state === "offline" &&
      (timer.nextRunAt !== null || timer.nextRunGeneration !== null)) {
    await persistAndSchedule(timer, context, null, null, null, generation);
  }
};

const rearmIntervalTimer = async (
  timer: Timer,
  context: TimerAlarmContext,
  now: number,
  state: TimerIntervalState,
  streamId: string | null,
  streamGeneration?: number,
): Promise<void> => {
  if (timer.trigger.type !== "interval") return;
  const part = intervalPartFor(timer.trigger, state);
  const deadline = part === undefined ? null : now + part.minutes * 60_000;
  await persistIntervalReplanAndSchedule(timer, context, deadline, state === "live" ? streamId : null, state, streamGeneration);
};

/**
 * Re-checks the live stream right before sending, in the same validity check
 * as the revision and deadline -- `renderTemplate` and the chat-activity
 * lookup above it can take long enough for the stream to end or roll over to
 * a new one between the due-occurrence check and the actual send.
 */
const isStreamStillCurrentFor = async (
  timer: Timer,
  context: TimerAlarmContext,
  occurrenceStreamId: string | undefined,
  expectedGeneration: number,
): Promise<boolean> => {
  if (timer.trigger.type === "interval") {
    if (timer.nextRunState === "offline") {
      const [state, generation] = await Promise.all([
        context.streamState(), streamTransitionGeneration(context.DB, context.channelId),
      ]);
      return state === "offline" && generation === expectedGeneration;
    }
    if (timer.nextRunState !== "live") return false;
    const [state, stream, generation] = await Promise.all([
      context.streamState(), context.streamStartedAt(), streamTransitionGeneration(context.DB, context.channelId),
    ]);
    return state === "online" && stream.streamId === (occurrenceStreamId ?? null) &&
      generation === expectedGeneration;
  }
  if (timer.trigger.type === "stream_start") {
    const [state, stream, generation] = await Promise.all([
      context.streamState(), context.streamStartedAt(), streamTransitionGeneration(context.DB, context.channelId),
    ]);
    return state === "online" && stream.streamId !== null && stream.streamId === occurrenceStreamId &&
      generation === expectedGeneration;
  }
  if (timer.trigger.type === "time_of_day") {
    return timer.trigger.alsoOffline || await context.streamState() === "online";
  }
  return true;
};

const isDueOccurrenceCurrent = async (
  timer: Timer,
  context: TimerAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<{ current: boolean; eventAt?: number; streamId?: string }> => {
  if (alarmKey !== alarmKeyFor(timer.id)) return { current: false };
  if (timer.trigger.type === "interval") {
    const state = await context.streamState();
    if (timer.nextRunState === "offline") {
      return { current: state === "offline" && timer.nextRunStreamId === null };
    }
    if (timer.nextRunState !== "live" || state !== "online") return { current: false };
    const stream = await context.streamStartedAt();
    return {
      current: timer.nextRunStreamId !== null && stream.streamId === timer.nextRunStreamId,
      ...(stream.streamId === null ? {} : { streamId: stream.streamId }),
    };
  }
  if (timer.trigger.type === "time_of_day") {
    const [timeZone, state] = await Promise.all([timeZoneFor(context), context.streamState()]);
    return {
      current: isDailyTimerDeadlineCurrent(timer.trigger, deadline, timeZone) &&
        (timer.trigger.alsoOffline || state === "online"),
    };
  }
  if (timer.trigger.type === "stream_start") {
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    if (state !== "online" || stream.startedAt === null || stream.streamId === null) return { current: false };
    const expected = Date.parse(stream.startedAt) + triggerDelayMs(timer.trigger);
    return {
      current: expected === deadline && timer.nextRunStreamId === stream.streamId,
      streamId: stream.streamId,
    };
  }
  const events = await context.resolveEventTimes(Date.now());
  const leadMs = timer.trigger.minutes * 60_000;
  const sourceId = timer.trigger.sourceId;
  const matchingEvent = events.find((event) => event.id === sourceId && Date.parse(event.at) - leadMs === deadline);
  return {
    current: matchingEvent !== undefined,
    ...(matchingEvent === undefined ? {} : { eventAt: Date.parse(matchingEvent.at) }),
  };
};

const handleTimerAlarmWithStaleRetry = async (
  context: TimerAlarmContext,
  alarmKey: string,
  deadline: number,
  ownerRevision: number | undefined,
  staleContentRetries: number,
): Promise<void> => {
  const refreshMarker = ":refresh:";
  const refreshAt = alarmKey.indexOf(refreshMarker);
  const timerId = alarmKey.startsWith("timer:")
    ? alarmKey.slice("timer:".length, refreshAt < 0 ? undefined : refreshAt)
    : "";
  const isEventTimeRefresh = refreshAt >= 0;
  const row = timerId.length === 0 ? null : await context.DB.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
            last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(context.channelId, timerId).first<TimerRow>();
  if (row === null) return;
  const timer = mapTimerRow(row);
  if (isEventTimeRefresh) {
    if (timer.enabled && timer.trigger.type === "before_event") {
      await scheduleNextRun(timer, context, Date.now());
    }
    return;
  }
  if (alarmKey !== alarmKeyFor(timer.id)) return;
  if (!timer.enabled) {
    const generation = timer.trigger.type === "interval" || timer.trigger.type === "stream_start"
      ? await streamTransitionGeneration(context.DB, context.channelId)
      : null;
    await context.clear(alarmKeyFor(timer.id), timer.revision, generation,
      context.alarmIdentity ?? null, timer.nextRunPlanSequence);
    return;
  }
  const currentStreamGeneration = await streamTransitionGeneration(context.DB, context.channelId);
  const streamScoped = timer.trigger.type === "interval" || timer.trigger.type === "stream_start";
  if (streamScoped && context.streamGeneration !== undefined &&
      context.streamGeneration !== currentStreamGeneration) {
    if (timer.trigger.type === "interval") await scheduleNextRun(timer, context, Date.now());
    else await replanStreamStartTimer(timer, context, Date.now());
    return;
  }
  if (streamScoped && timer.nextRunGeneration !== currentStreamGeneration) {
    if (timer.trigger.type === "interval") await scheduleNextRun(timer, context, Date.now());
    else await replanStreamStartTimer(timer, context, Date.now());
    return;
  }
  const currentIdentity = persistedTimerAlarmIdentity(timer);
  const storedAlarmPlan = context.alarmIdentity === undefined
    ? await context.getAlarmPlan?.(alarmKeyFor(timer.id))
    : null;
  const suppliedIdentity = context.alarmIdentity === undefined
    ? storedAlarmPlan?.identity ?? null
    : context.alarmIdentity;
  const alarmPlanSequence = context.alarmPlanSequence ?? storedAlarmPlan?.planSequence ?? undefined;
  const alarmIsCurrent = currentIdentity !== null &&
    sameTimerAlarmIdentity(suppliedIdentity, currentIdentity) &&
    alarmPlanSequence === timer.nextRunPlanSequence &&
    (ownerRevision === undefined || ownerRevision === currentIdentity.revision) &&
    currentIdentity.deadline === deadline;
  if (!alarmIsCurrent) {
    if (timer.nextRunAt === null) {
      await persistAndSchedule(timer, context, null, null, null,
        streamScoped ? currentStreamGeneration : undefined);
    } else {
      await persistAndSchedule(timer, context, Date.parse(timer.nextRunAt), timer.nextRunStreamId,
        timer.nextRunState, timer.nextRunGeneration ?? undefined);
    }
    return;
  }
  const scheduledStreamGeneration = currentIdentity.generation ?? currentStreamGeneration;
  // The alarm fired on a deadline that still matches the stored row, but a
  // short gap between streams can leave that deadline armed for a stream
  // that already ended (see `refreshSchedules`'s activation replan for the
  // same scenario). Treat a stream-id mismatch as unarmed here too, instead
  // of relying on the due-occurrence check below to merely suppress the
  // send -- that would strand the timer without a fresh deadline until the
  // next `stream.online` notification, missing the entire current stream.
  if (timer.trigger.type === "interval") {
    const state = await context.streamState();
    if (state === "offline" && timer.nextRunState !== "offline") {
      await rearmIntervalTimer(timer, context, Date.now(), "offline", null, scheduledStreamGeneration);
      return;
    }
    if (state === "online" && timer.nextRunState !== "live") {
      const stream = await context.streamStartedAt();
      await rearmIntervalTimer(timer, context, Date.now(), "live", stream.streamId, scheduledStreamGeneration);
      return;
    }
    if (state === "unknown") {
      await scheduleNextRun(timer, context, Date.now());
      return;
    }
    if (state === "online") {
      const stream = await context.streamStartedAt();
      if (stream.streamId !== null && stream.streamId !== row.next_run_stream_id) {
        await rearmIntervalTimer(timer, context, Date.now(), "live", stream.streamId, scheduledStreamGeneration);
        return;
      }
    }
  } else if (timer.trigger.type === "stream_start") {
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    if (state === "online" && stream.streamId !== null && stream.streamId !== row.next_run_stream_id) {
      await rearmStreamScopedTimer(timer, context, Date.now(),
        { streamId: stream.streamId, startedAt: stream.startedAt }, scheduledStreamGeneration);
      return;
    }
  }
  const occurrence = await isDueOccurrenceCurrent(timer, context, alarmKey, deadline);
  const now = Date.now();
  const graceEndsAt = timer.trigger.type === "before_event"
    ? occurrence.eventAt ?? deadline
    : deadline + TIMER_OCCURRENCE_GRACE_MS;
  if (now > graceEndsAt) {
    await rescheduleAfterRun(timer, context, deadline);
    return;
  }
  let sent = false;
  if (occurrence.current) {
    let shouldSend = true;
    let activityCount: number | null = null;
    const intervalState = timer.trigger.type === "interval" ? timer.nextRunState : null;
    const minimumMessages = timer.trigger.type === "interval" && intervalState !== null
      ? intervalPartFor(timer.trigger, intervalState)?.minimumMessages
      : undefined;
    if (timer.trigger.type === "interval" && minimumMessages !== undefined) {
      activityCount = await context.chatActivityCount();
      const countRow = await context.DB.prepare(
        "SELECT last_chat_activity_count FROM timers WHERE channel_id = ? AND timer_id = ?",
      ).bind(context.channelId, timer.id).first<{ last_chat_activity_count: number | null }>();
      if (countRow?.last_chat_activity_count === null || countRow?.last_chat_activity_count === undefined) {
        await context.DB.prepare(
          `UPDATE timers SET last_chat_activity_count = ?
            WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = 1
              AND trigger_type = ? AND next_run_at = ? AND next_run_stream_id IS ? AND next_run_state IS ?
              AND next_run_generation IS ? AND next_run_plan_sequence = ?
              AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
        ).bind(activityCount, context.channelId, timer.id, timer.revision, timer.trigger.type,
          new Date(deadline).toISOString(), timer.nextRunStreamId, intervalState,
          timer.nextRunGeneration, timer.nextRunPlanSequence, scheduledStreamGeneration).run();
        shouldSend = false;
      } else {
        shouldSend = activityCount - countRow.last_chat_activity_count >= minimumMessages;
      }
    }
    if (shouldSend) {
      const rendered = await context.renderTemplate(timer.messageText, now);
      const idempotencyKey = timerOccurrenceKey(timer.id, deadline,
        timer.trigger.type === "interval" ? undefined : occurrence.streamId);
      const result = await context.sendChat(rendered.text, idempotencyKey, rendered.attributions, async () => {
        const current = await context.DB.prepare(
          `SELECT enabled, revision, trigger_type, next_run_at, next_run_stream_id, next_run_state,
                  next_run_generation, next_run_plan_sequence
             FROM timers WHERE channel_id = ? AND timer_id = ?`,
        ).bind(context.channelId, timer.id).first<{
          enabled: number;
          revision: number;
          trigger_type: string;
          next_run_at: string | null;
          next_run_stream_id: string | null;
          next_run_state: TimerIntervalState | null;
          next_run_generation: number | null;
          next_run_plan_sequence: number;
        }>();
        const stillScheduled = current?.enabled === 1 && current.revision === timer.revision &&
          current.trigger_type === timer.trigger.type &&
          current.next_run_at !== null && Date.parse(current.next_run_at) === deadline &&
          current.next_run_stream_id === timer.nextRunStreamId &&
          current.next_run_state === timer.nextRunState &&
          current.next_run_generation === timer.nextRunGeneration &&
          current.next_run_plan_sequence === alarmPlanSequence &&
          Date.now() <= graceEndsAt;
        return stillScheduled && (!streamScoped || await isStreamStillCurrentFor(
          timer, context, occurrence.streamId, scheduledStreamGeneration,
        ));
      }, timer.chatTarget ?? undefined);
      sent = result.sent;
      if (!sent && result.reason === "stale_before_send" && staleContentRetries < 3) {
        const latestRow = await context.DB.prepare(
          `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
                  next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
                  last_run_at, created_at, updated_at
             FROM timers WHERE channel_id = ? AND timer_id = ?`,
        ).bind(context.channelId, timer.id).first<TimerRow>();
        if (latestRow !== null && latestRow.enabled === 1 && latestRow.revision !== timer.revision &&
            latestRow.message_text !== timer.messageText && latestRow.next_run_at !== null &&
            Date.parse(latestRow.next_run_at) === deadline) {
          await handleTimerAlarmWithStaleRetry(context, alarmKey, deadline, latestRow.revision, staleContentRetries + 1);
          return;
        }
      }
      if (!result.sent && result.retryable) {
        throw new Error(`Timer chat send failed: ${result.reason ?? "unknown"}.`);
      }
      if (sent && activityCount !== null) {
        await context.DB.prepare(
          `UPDATE timers SET last_chat_activity_count = ?
            WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = 1
              AND trigger_type = ? AND next_run_at = ? AND next_run_stream_id IS ? AND next_run_state IS ?
              AND next_run_generation IS ? AND next_run_plan_sequence = ?
              AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
        ).bind(activityCount, context.channelId, timer.id, timer.revision, timer.trigger.type,
          new Date(deadline).toISOString(), timer.nextRunStreamId, intervalState,
          timer.nextRunGeneration, timer.nextRunPlanSequence, scheduledStreamGeneration).run();
      }
    }
  }
  const completedAt = Date.now();
  await rescheduleAfterRun(timer, context, deadline);
  if (timer.trigger.type === "before_event" && occurrence.eventAt !== undefined) {
    await context.schedule(eventTimeRefreshKeyFor(timer.id, occurrence.eventAt), occurrence.eventAt + 30_000);
  }
  if (sent) {
    await context.DB.prepare("UPDATE timers SET last_run_at = ? WHERE channel_id = ? AND timer_id = ?")
      .bind(new Date(completedAt).toISOString(), context.channelId, timer.id).run();
  }
};

export const handleTimerAlarm = async (
  context: TimerAlarmContext,
  alarmKey: string,
  deadline: number,
  ownerRevision?: number,
): Promise<void> => {
  await handleTimerAlarmWithStaleRetry(context, alarmKey, deadline, ownerRevision, 0);
};

/**
 * `activation` replans a live session's stream-scoped timers after a module
 * gets (re-)enabled or a channel unpauses: the host only dispatches
 * `stream.online`/`stream.offline` to a module while it is both enabled and
 * unpaused, so a session that started during either off period leaves these
 * timers armed with nothing -- or, if the module missed both the offline and
 * a following online notification, still armed with a deadline left over
 * from the previous stream. A leftover deadline is not reliably before the
 * current stream's start: a short gap between streams can leave it after,
 * so comparing timestamps cannot tell stale apart from already-armed. The
 * stored stream id can, and does not depend on the gap's length. A timer
 * whose stream id doesn't match the current stream is rearmed exactly like
 * the accepted `stream.online` path, including its chat baseline reset, so
 * leftover previous-stream chat cannot satisfy `minimumMessages` for the new
 * session.
 */
const refreshSchedules = async (
  context: TimerAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  const timers = await listTimers(context.DB, context.channelId);
  const now = Date.now();
  if (reason === "activation" || reason === "stream_state") {
    const streamGeneration = await streamTransitionGeneration(context.DB, context.channelId);
    const currentState = await context.streamState();
    if (currentState !== "online" && currentState !== "offline") return;
    const state: TimerIntervalState = currentState === "online" ? "live" : "offline";
    const stream = state === "live" ? await context.streamStartedAt() : null;
    if (state === "live" && stream?.streamId === null) return;
    for (const timer of timers) {
      if (!timer.enabled || (timer.trigger.type !== "interval" && timer.trigger.type !== "stream_start")) continue;
      if (timer.trigger.type === "interval") {
        const streamId = state === "live" ? stream?.streamId ?? null : null;
        const identity = persistedTimerAlarmIdentity(timer);
        const candidateIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
          timer, Date.parse(timer.nextRunAt), state, streamId, streamGeneration,
        );
        const planMatchesState = sameTimerAlarmIdentity(identity, candidateIdentity);
        if (planMatchesState) {
          const storedPlan = await context.getAlarmPlan?.(alarmKeyFor(timer.id));
          if (storedPlan !== undefined && storedPlan !== null &&
              sameTimerAlarmIdentity(identity, storedPlan.identity) &&
              storedPlan.planSequence === timer.nextRunPlanSequence) continue;
          await persistAndSchedule(timer, context, Date.parse(timer.nextRunAt as string),
            timer.nextRunStreamId, timer.nextRunState, streamGeneration);
          continue;
        }
        await rearmIntervalTimer(timer, context, now, state, streamId, streamGeneration);
        continue;
      }
      if (state !== "live" || stream === null || stream.streamId === null) {
        const storedPlan = await context.getAlarmPlan?.(alarmKeyFor(timer.id));
        if (timer.nextRunAt !== null || timer.nextRunGeneration !== null || storedPlan !== undefined && storedPlan !== null) {
          await persistAndSchedule(timer, context, null, null, null, streamGeneration);
        }
        continue;
      }
      const identity = persistedTimerAlarmIdentity(timer);
      const candidateIdentity = timer.nextRunAt === null ? null : timerAlarmIdentity(
        timer, Date.parse(timer.nextRunAt), null, stream.streamId, streamGeneration,
      );
      const planMatchesStream = sameTimerAlarmIdentity(identity, candidateIdentity);
      if (planMatchesStream) {
        const storedPlan = await context.getAlarmPlan?.(alarmKeyFor(timer.id));
        if (storedPlan !== undefined && storedPlan !== null &&
            sameTimerAlarmIdentity(identity, storedPlan.identity) &&
            storedPlan.planSequence === timer.nextRunPlanSequence) continue;
        await persistAndSchedule(timer, context, Date.parse(timer.nextRunAt as string),
          timer.nextRunStreamId, null, streamGeneration);
        continue;
      }
      await rearmStreamScopedTimer(timer, context, now, { streamId: stream.streamId, startedAt: stream.startedAt }, streamGeneration);
    }
    return;
  }
  for (const timer of timers) {
    if (!timer.enabled || (timer.trigger.type !== "time_of_day" && timer.trigger.type !== "before_event") ||
        (reason === "event_times" && timer.trigger.type !== "before_event")) continue;
    await scheduleNextRun(timer, context, now);
  }
};

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const result = await db.prepare("SELECT timer_id, name, message_text FROM timers WHERE channel_id = ?")
    .bind(channelId).all<{ timer_id: string; name: string; message_text: string }>();
  return result.results.map((row) => ({
    text: row.message_text,
    kind: "timer",
    label: row.name || row.timer_id,
  }));
};

const timerVariableReferences = columnVariableReferences({
  moduleId: TIMER_MODULE_ID,
  tableName: "timers",
  idColumn: "timer_id",
  itemNameColumn: "name",
  textColumn: "message_text",
  maxTextLength: 500,
});

export const timersModule: BotModule<typeof settingsSchema> = {
  id: TIMER_MODULE_ID,
  navigationCategory: "chat",
  panelIcon: { paths: ["M12 6v6l4 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateUsageSources,
  variableReferences: timerVariableReferences,
  validateTemplateContent: validateTimerTemplateMutation,
  navigationEntries: [{
    id: "timers",
    label: { de: timersModuleCatalog.de.label, en: timersModuleCatalog.en.label },
    description: { de: timersModuleCatalog.de.description, en: timersModuleCatalog.en.description },
    iconKind: "timers",
    keywords: ["timer", "timers", "schedule", "zeitplan", "zeitplanung"],
  }],
  // Interval activity thresholds need the shared count even when no other chat module is enabled.
  eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline"],
  alarms: [{
    key: TIMER_ALARM_HANDLER,
    retryDelaysMs: [5_000, 15_000, 60_000],
    handle: handleTimerAlarm,
    onScheduleInputsChanged: refreshSchedules,
  }],
  routes: timerRoutes,
  panel: () => import("./panel"),
  handleEvent: async (event, context) => {
    if (event.subscriptionType !== "stream.online" && event.subscriptionType !== "stream.offline") {
      return { actions: [], diagnostics: [] };
    }
    if (context.streamStateTransitionAccepted !== true) return { actions: [], diagnostics: [] };
    const streamGeneration = context.streamStateTransitionGeneration ??
      await streamTransitionGeneration(context.DB, event.channelId);
    const timers = await listTimers(context.DB, event.channelId);
    if (event.subscriptionType === "stream.offline") {
      const activityCount = await context.chatActivityCount();
      for (const timer of timers) {
        if (timer.trigger.type === "interval") {
          const deadline = timer.enabled && timer.trigger.offline !== undefined
            ? Date.now() + timer.trigger.offline.minutes * 60_000
            : null;
          const state = deadline === null ? null : "offline";
          if (!await persistIntervalTimerPlan(context.DB, event.channelId, timer, deadline, null, state,
            activityCount, streamGeneration, timer)) continue;
          const planSequence = timer.nextRunPlanSequence + 1;
          const expectedIdentity = persistedTimerAlarmIdentity(timer);
          if (deadline === null) await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration,
            expectedIdentity, planSequence);
          else await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision,
            streamGeneration, timerAlarmIdentity(timer, deadline, state, null, streamGeneration), planSequence);
        } else if (timer.trigger.type === "stream_start" &&
            await saveNextRunAt(context.DB, event.channelId, timer, null, null, null, timer, streamGeneration)) {
          await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration,
            persistedTimerAlarmIdentity(timer), timer.nextRunPlanSequence + 1);
        }
      }
      return { actions: [], diagnostics: [] };
    }
    const startedAt = typeof event.payload.started_at === "string" ? Date.parse(event.payload.started_at) : Number.NaN;
    if (!Number.isFinite(startedAt)) return { actions: [], diagnostics: [] };
    const streamId = typeof event.payload.id === "string" ? event.payload.id : null;
    if (streamId === null || streamId.length === 0) return { actions: [], diagnostics: [] };
    const activityCount = await context.chatActivityCount();
    for (const timer of timers) {
      if (timer.trigger.type === "interval") {
        const now = Date.now();
        const livePart = timer.trigger.live;
        const firstDeadline = livePart === undefined ? null : startedAt + livePart.minutes * 60_000;
        const deadline = !timer.enabled || livePart === undefined || firstDeadline === null
          ? null
          : firstDeadline > now ? firstDeadline : now + livePart.minutes * 60_000;
        const state = deadline === null ? null : "live";
        if (!await persistIntervalTimerPlan(context.DB, event.channelId, timer, deadline,
          deadline === null ? null : streamId, state, activityCount, streamGeneration, timer)) continue;
        const planSequence = timer.nextRunPlanSequence + 1;
        const expectedIdentity = persistedTimerAlarmIdentity(timer);
        if (deadline === null) await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration,
          expectedIdentity, planSequence);
        else await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision,
          streamGeneration, timerAlarmIdentity(timer, deadline, state, streamId, streamGeneration), planSequence);
        continue;
      }
      if (!timer.enabled || timer.trigger.type !== "stream_start") continue;
      const deadline = startedAt + triggerDelayMs(timer.trigger);
      if (await saveNextRunAt(context.DB, event.channelId, timer, deadline, streamId, null, timer, streamGeneration)) {
        await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision,
          streamGeneration, timerAlarmIdentity(timer, deadline, null, streamId, streamGeneration),
          timer.nextRunPlanSequence + 1);
      }
    }
    return { actions: [], diagnostics: [] };
  },
};
