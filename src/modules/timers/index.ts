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

const settingsSchema = z.object({});
const TIMER_MODULE_ID = "timers";
const TIMER_ALARM_HANDLER = "run";
const TIMER_OCCURRENCE_GRACE_MS = 10 * 60_000;

const listTimers = async (db: D1Database, channelId: string): Promise<Timer[]> => {
  const result = await db.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, last_run_at, created_at, updated_at
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
  streamGeneration?: number,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE timers SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = 1
        AND (? IS NULL OR COALESCE((SELECT transition_generation FROM channel_stream_state
                                     WHERE channel_id = timers.channel_id), 0) = ?)`,
  ).bind(at === null ? null : new Date(at).toISOString(), at === null ? null : streamId, at === null ? null : state,
    channelId, timer.id, timer.revision, streamGeneration ?? null, streamGeneration ?? null).run();
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

const persistAndSchedule = async (
  timer: Timer,
  context: TimerAlarmContext,
  nextAt: number | null,
  streamId: string | null = null,
  state: TimerIntervalState | null = null,
  expectedStreamGeneration?: number,
): Promise<boolean> => {
  const streamGeneration = expectedStreamGeneration ?? await streamTransitionGeneration(context.DB, context.channelId);
  if (!await saveNextRunAt(context.DB, context.channelId, timer, nextAt, streamId, state, streamGeneration)) return false;
  const key = alarmKeyFor(timer.id);
  if (nextAt === null) await context.clear(key, timer.revision, streamGeneration);
  else await context.schedule(key, nextAt, timer.revision, streamGeneration);
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
    const deadline = timer.nextRunState === state
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
            next_run_at, next_run_stream_id, next_run_state, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(context.channelId, timer.id).first<TimerRow>();
  if (row === null || row.revision === timer.revision || row.next_run_at === null ||
      Date.parse(row.next_run_at) !== deadline) return;
  // A template-only rename can advance the timer revision while its alarm is
  // already running. If that made the old revision's reschedule a no-op, arm
  // the next occurrence from the current row, without overriding a timer edit
  // that already changed or cleared the stored deadline.
  await scheduleNextRun(mapTimerRow(row), context, Date.now(), deadline);
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
  const deadline = nextStreamStartAt(stream.startedAt, now, triggerDelayMs(timer.trigger));
  if (deadline !== null) await persistAndSchedule(timer, context, deadline, stream.streamId, null, streamGeneration);
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
  const expectedGeneration = streamGeneration ?? await streamTransitionGeneration(context.DB, context.channelId);
  if (!await persistAndSchedule(timer, context, deadline, state === "live" ? streamId : null, state, expectedGeneration)) return;
  const activityCount = await context.chatActivityCount();
  await context.DB.prepare(
    `UPDATE timers SET last_chat_activity_count = ?, chat_baseline_stream_id = ?
      WHERE channel_id = ? AND timer_id = ? AND next_run_state = ?
        AND next_run_at IS ?
        AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
  ).bind(activityCount, state === "live" ? streamId : null, context.channelId, timer.id, state,
    deadline === null ? null : new Date(deadline).toISOString(), expectedGeneration).run();
};

/**
 * A schedule from before the stream-id migration (or otherwise still missing
 * one) whose recorded deadline already falls inside `stream` -- the old,
 * start-time-only heuristic, kept as a one-time fallback so a legacy row
 * that is genuinely still armed for the current stream doesn't get rearmed
 * out from under itself: that would defer an interval occurrence by a full
 * interval, or silently drop a stream_start occurrence whose due time has
 * already passed (rearming computes a *new* deadline, which is in the past
 * by then). A row that already carries a stream id is judged on that id
 * alone; this never overrides an actual mismatch.
 */
const isLegacyArmedForStream = (
  storedStreamId: string | null,
  nextRunAt: number,
  stream: { startedAt: string | null },
): boolean =>
  storedStreamId === null && (stream.startedAt === null || nextRunAt >= Date.parse(stream.startedAt));

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
): Promise<boolean> => {
  if (timer.trigger.type === "interval") {
    if (timer.nextRunState === "offline") return await context.streamState() === "offline";
    if (timer.nextRunState !== "live") return false;
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    return state === "online" && stream.streamId === (occurrenceStreamId ?? null);
  }
  if (timer.trigger.type === "stream_start") {
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    return state === "online" && stream.streamId !== null && stream.streamId === occurrenceStreamId;
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
    if (timer.nextRunState === "offline") return { current: state === "offline" };
    if (timer.nextRunState !== "live" || state !== "online") return { current: false };
    const stream = await context.streamStartedAt();
    return {
      current: timer.nextRunStreamId === null || stream.streamId === timer.nextRunStreamId,
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
    return { current: expected === deadline, streamId: stream.streamId };
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
            next_run_at, next_run_stream_id, next_run_state, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(context.channelId, timerId).first<TimerRow>();
  if (row === null) return;
  const timer = mapTimerRow(row);
  if (!timer.enabled) {
    const generation = await streamTransitionGeneration(context.DB, context.channelId);
    await context.clear(alarmKeyFor(timer.id), timer.revision, generation);
    return;
  }
  if (isEventTimeRefresh) {
    if (timer.trigger.type === "before_event") {
      await scheduleNextRun(timer, context, Date.now());
    }
    return;
  }
  const currentStreamGeneration = await streamTransitionGeneration(context.DB, context.channelId);
  const streamScoped = timer.trigger.type === "interval" || timer.trigger.type === "stream_start";
  if (streamScoped && context.streamGeneration !== undefined &&
      context.streamGeneration !== currentStreamGeneration) {
    await scheduleNextRun(timer, context, Date.now());
    return;
  }
  const scheduledStreamGeneration = context.streamGeneration ?? currentStreamGeneration;
  if (alarmKey !== alarmKeyFor(timer.id)) return;
  if (ownerRevision !== undefined && ownerRevision !== timer.revision) {
    // Variable-template renames advance the content revision without changing
    // the persisted deadline. Keep that due occurrence when it still matches.
    if (row.next_run_at === null || Date.parse(row.next_run_at) !== deadline) {
      await scheduleNextRun(timer, context, Date.now());
      return;
    }
  }
  if (row.next_run_at === null || Date.parse(row.next_run_at) !== deadline) {
    await scheduleNextRun(timer, context, Date.now());
    return;
  }
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
        if (isLegacyArmedForStream(row.next_run_stream_id, deadline, stream)) {
          await saveNextRunAt(context.DB, context.channelId, timer, deadline, stream.streamId, "live", scheduledStreamGeneration);
        } else {
          await rearmIntervalTimer(timer, context, Date.now(), "live", stream.streamId, scheduledStreamGeneration);
          return;
        }
      }
    }
  } else if (timer.trigger.type === "stream_start") {
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    if (state === "online" && stream.streamId !== null && stream.streamId !== row.next_run_stream_id) {
      if (isLegacyArmedForStream(row.next_run_stream_id, deadline, stream)) {
        // A legacy row (from before the stream-id column existed) whose
        // deadline is already due inside the current stream: backfill the
        // id instead of rearming, so this occurrence still fires on time.
        await saveNextRunAt(context.DB, context.channelId, timer, deadline, stream.streamId, null, scheduledStreamGeneration);
      } else {
        await rearmStreamScopedTimer(timer, context, Date.now(), { streamId: stream.streamId, startedAt: stream.startedAt }, scheduledStreamGeneration);
        return;
      }
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
              AND next_run_at = ? AND next_run_state = ?
              AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
        ).bind(activityCount, context.channelId, timer.id, timer.revision, new Date(deadline).toISOString(),
          intervalState, scheduledStreamGeneration).run();
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
          `SELECT enabled, revision, next_run_at, next_run_state FROM timers WHERE channel_id = ? AND timer_id = ?`,
        ).bind(context.channelId, timer.id).first<{
          enabled: number;
          revision: number;
          next_run_at: string | null;
          next_run_state: TimerIntervalState | null;
        }>();
        const stillScheduled = current?.enabled === 1 && current.revision === timer.revision &&
          current.next_run_at !== null && Date.parse(current.next_run_at) === deadline &&
          (intervalState === null || current.next_run_state === intervalState) &&
          (timer.trigger.type !== "interval" ||
            await streamTransitionGeneration(context.DB, context.channelId) === scheduledStreamGeneration) &&
          Date.now() <= graceEndsAt;
        return stillScheduled && await isStreamStillCurrentFor(timer, context, occurrence.streamId);
      }, timer.chatTarget ?? undefined);
      sent = result.sent;
      if (!sent && result.reason === "stale_before_send" && staleContentRetries < 3) {
        const latestRow = await context.DB.prepare(
          `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
                  next_run_at, next_run_stream_id, next_run_state, last_run_at, created_at, updated_at
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
              AND next_run_at = ? AND next_run_state = ?
              AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
        ).bind(activityCount, context.channelId, timer.id, timer.revision, new Date(deadline).toISOString(),
          intervalState, scheduledStreamGeneration).run();
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
        if (timer.nextRunAt !== null && timer.nextRunState === state &&
            (state === "offline" || timer.nextRunStreamId === streamId)) continue;
        if (state === "live" && timer.nextRunAt !== null && timer.nextRunState === "live" &&
            stream !== null && isLegacyArmedForStream(timer.nextRunStreamId, Date.parse(timer.nextRunAt), stream)) {
          await saveNextRunAt(context.DB, context.channelId, timer, Date.parse(timer.nextRunAt), streamId, "live", streamGeneration);
          continue;
        }
        await rearmIntervalTimer(timer, context, now, state, streamId, streamGeneration);
        continue;
      }
      if (state !== "live" || stream === null || stream.streamId === null) {
        await persistAndSchedule(timer, context, null, null, null, streamGeneration);
        continue;
      }
      // A null `nextRunAt` is unarmed regardless of what stream id happens
      // to be stored alongside it (an edit or disable can leave one behind).
      if (timer.nextRunAt !== null && timer.nextRunStreamId === stream.streamId) continue;
      if (timer.nextRunAt !== null && isLegacyArmedForStream(timer.nextRunStreamId, Date.parse(timer.nextRunAt), stream)) {
        await saveNextRunAt(context.DB, context.channelId, timer, Date.parse(timer.nextRunAt), stream.streamId, null, streamGeneration);
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
          await context.DB.prepare(
            `UPDATE timers SET last_chat_activity_count = ?, chat_baseline_stream_id = NULL
              WHERE channel_id = ? AND timer_id = ?
                AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
          ).bind(activityCount, event.channelId, timer.id, streamGeneration).run();
          if (timer.enabled && timer.trigger.offline !== undefined) {
            const deadline = Date.now() + timer.trigger.offline.minutes * 60_000;
            if (await saveNextRunAt(context.DB, event.channelId, timer, deadline, null, "offline", streamGeneration)) {
              await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision, streamGeneration);
            }
          } else if (await saveNextRunAt(context.DB, event.channelId, timer, null, null, null, streamGeneration)) {
            await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration);
          }
        } else if (timer.trigger.type === "stream_start" &&
            await saveNextRunAt(context.DB, event.channelId, timer, null, null, null, streamGeneration)) {
          await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration);
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
        await context.DB.prepare(
          `UPDATE timers SET last_chat_activity_count = ?, chat_baseline_stream_id = ?
            WHERE channel_id = ? AND timer_id = ?
              AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?`,
        ).bind(activityCount, streamId, event.channelId, timer.id, streamGeneration).run();
        if (!timer.enabled || timer.trigger.live === undefined) {
          if (await saveNextRunAt(context.DB, event.channelId, timer, null, null, null, streamGeneration)) {
            await context.clearAlarm(alarmKeyFor(timer.id), timer.revision, streamGeneration);
          }
          continue;
        }
        const now = Date.now();
        const firstDeadline = startedAt + timer.trigger.live.minutes * 60_000;
        const deadline = firstDeadline > now ? firstDeadline : now + timer.trigger.live.minutes * 60_000;
        if (await saveNextRunAt(context.DB, event.channelId, timer, deadline, streamId, "live", streamGeneration)) {
          await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision, streamGeneration);
        }
        continue;
      }
      if (!timer.enabled || timer.trigger.type !== "stream_start") continue;
      const deadline = startedAt + triggerDelayMs(timer.trigger);
      if (await saveNextRunAt(context.DB, event.channelId, timer, deadline, streamId, null, streamGeneration)) {
        await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision, streamGeneration);
      }
    }
    return { actions: [], diagnostics: [] };
  },
};
