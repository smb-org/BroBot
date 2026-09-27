import { z } from "zod";

import type { BotModule, ModuleScheduleInputChangeReason, ModuleTemplateUsageSource } from "../contract";
import type { Timer } from "./contracts";
import { timerTriggerSchema } from "./contracts";
import { timersModuleCatalog } from "./contracts/catalog";
import { mapTimerRow, validateTimerTemplateMutation, type TimerRow } from "./service";
import {
  eventTimeWindowEnd,
  isDailyTimerDeadlineCurrent,
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
const alarmKeyFor = (timerId: string): string => `timer:${timerId}`;
const eventTimeRefreshKeyFor = (timerId: string, eventAt: number): string => `${alarmKeyFor(timerId)}:refresh:${String(eventAt)}`;

const listTimers = async (db: D1Database, channelId: string): Promise<Timer[]> => {
  const result = await db.prepare(
    `SELECT timer_id, name, enabled, block_name, trigger_type, trigger_json, revision,
            next_run_at, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id`,
  ).bind(channelId).all<TimerRow>();
  return result.results.map(mapTimerRow);
};

type TimerAlarmContext = Parameters<NonNullable<BotModule["alarms"]>[number]["handle"]>[0];

const saveNextRunAt = async (
  db: D1Database,
  channelId: string,
  timer: Timer,
  at: number | null,
): Promise<boolean> => {
  const result = await db.prepare(
    "UPDATE timers SET next_run_at = ? WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = 1",
  ).bind(at === null ? null : new Date(at).toISOString(), channelId, timer.id, timer.revision).run();
  return result.meta.changes > 0;
};

const persistAndSchedule = async (
  timer: Timer,
  context: TimerAlarmContext,
  nextAt: number | null,
): Promise<boolean> => {
  if (!await saveNextRunAt(context.DB, context.channelId, timer, nextAt)) return false;
  const key = alarmKeyFor(timer.id);
  if (nextAt === null) await context.clear(key, timer.revision);
  else await context.schedule(key, nextAt, timer.revision);
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
): Promise<number | null> => {
  if (timer.trigger.type === "interval") {
    return await context.streamState() === "online"
      ? nextIntervalAt(previousDeadline, now, timer.trigger.minutes)
      : null;
  }
  if (timer.trigger.type === "stream_start") return null;
  const timeZone = await timeZoneFor(context);
  if (timer.trigger.type === "time_of_day") return nextDailyTimerAt(timer.trigger, now, timeZone);
  return nextTimerAt(timer.trigger, { now, timeZone, eventTimes: await context.resolveEventTimes(now) });
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
  const deadline = await nextDeadlineFor(timer, context, now, previousDeadline);
  const scheduled = await persistAndSchedule(timer, context, deadline);
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
  await scheduleNextRun(timer, context, Date.now(), deadline);
};

const isDueOccurrenceCurrent = async (
  timer: Timer,
  context: TimerAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<{ current: boolean; eventAt?: number; streamId?: string }> => {
  if (alarmKey !== alarmKeyFor(timer.id)) return { current: false };
  if (timer.trigger.type === "interval") {
    return { current: await context.streamState() === "online" };
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

export const handleTimerAlarm = async (
  context: TimerAlarmContext,
  alarmKey: string,
  deadline: number,
  ownerRevision?: number,
): Promise<void> => {
  const refreshMarker = ":refresh:";
  const refreshAt = alarmKey.indexOf(refreshMarker);
  const timerId = alarmKey.startsWith("timer:")
    ? alarmKey.slice("timer:".length, refreshAt < 0 ? undefined : refreshAt)
    : "";
  const isEventTimeRefresh = refreshAt >= 0;
  const row = timerId.length === 0 ? null : await context.DB.prepare(
    `SELECT timer_id, name, enabled, block_name, trigger_type, trigger_json, revision,
            next_run_at, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(context.channelId, timerId).first<TimerRow>();
  if (row === null) return;
  const timer = mapTimerRow(row);
  if (!timer.enabled) {
    await context.clear(alarmKeyFor(timer.id), timer.revision);
    return;
  }
  if (isEventTimeRefresh) {
    if (timer.trigger.type === "before_event") {
      await scheduleNextRun(timer, context, Date.now());
    }
    return;
  }
  if (alarmKey !== alarmKeyFor(timer.id)) return;
  if (ownerRevision !== undefined && ownerRevision !== timer.revision) {
    await scheduleNextRun(timer, context, Date.now());
    return;
  }
  if (row.next_run_at === null || Date.parse(row.next_run_at) !== deadline) {
    await scheduleNextRun(timer, context, Date.now());
    return;
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
    if (timer.trigger.type === "interval" && timer.trigger.minimumMessages !== undefined) {
      activityCount = await context.chatActivityCount();
      const countRow = await context.DB.prepare(
        "SELECT last_chat_activity_count FROM timers WHERE channel_id = ? AND timer_id = ?",
      ).bind(context.channelId, timer.id).first<{ last_chat_activity_count: number | null }>();
      if (countRow?.last_chat_activity_count === null || countRow?.last_chat_activity_count === undefined) {
        await context.DB.prepare("UPDATE timers SET last_chat_activity_count = ? WHERE channel_id = ? AND timer_id = ?")
          .bind(activityCount, context.channelId, timer.id).run();
        shouldSend = false;
      } else {
        shouldSend = activityCount - countRow.last_chat_activity_count >= timer.trigger.minimumMessages;
      }
    }
    if (shouldSend) {
      const rendered = await context.renderTemplate(`{${timer.blockName}}`, now);
      const idempotencyKey = timerOccurrenceKey(timer.id, deadline, occurrence.streamId);
      const result = await context.sendChat(rendered.text, idempotencyKey, rendered.attributions, async () => {
        const current = await context.DB.prepare(
          `SELECT enabled, revision, next_run_at FROM timers WHERE channel_id = ? AND timer_id = ?`,
        ).bind(context.channelId, timer.id).first<{ enabled: number; revision: number; next_run_at: string | null }>();
        return current?.enabled === 1 && current.revision === timer.revision &&
          current.next_run_at !== null && Date.parse(current.next_run_at) === deadline && Date.now() <= graceEndsAt;
      });
      sent = result.sent;
      if (!result.sent && result.retryable) {
        throw new Error(`Timer chat send failed: ${result.reason ?? "unknown"}.`);
      }
      if (sent && activityCount !== null) {
        await context.DB.prepare("UPDATE timers SET last_chat_activity_count = ? WHERE channel_id = ? AND timer_id = ?")
          .bind(activityCount, context.channelId, timer.id).run();
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

/**
 * `activation` replans a live session's stream-scoped timers after a module
 * gets (re-)enabled or a channel unpauses: the host only dispatches
 * `stream.online`/`stream.offline` to a module while it is both enabled and
 * unpaused, so a session that started during either off period leaves these
 * timers armed with nothing. Only timers still unarmed for this session are
 * touched -- one already scheduled (never missed the transition) keeps its
 * existing deadline.
 */
const refreshSchedules = async (
  context: TimerAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  const timers = await listTimers(context.DB, context.channelId);
  const now = Date.now();
  if (reason === "activation") {
    if (await context.streamState() !== "online") return;
    const stream = await context.streamStartedAt();
    for (const timer of timers) {
      if (!timer.enabled || timer.nextRunAt !== null) continue;
      if (timer.trigger.type === "interval") {
        await persistAndSchedule(timer, context, now + triggerDelayMs(timer.trigger));
      } else if (timer.trigger.type === "stream_start") {
        const deadline = nextStreamStartAt(stream.startedAt, now, triggerDelayMs(timer.trigger));
        if (deadline !== null) await persistAndSchedule(timer, context, deadline);
      }
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
  const result = await db.prepare("SELECT timer_id, name, block_name FROM timers WHERE channel_id = ?")
    .bind(channelId).all<{ timer_id: string; name: string; block_name: string }>();
  return result.results.map((row) => ({
    text: `{${row.block_name}}`,
    kind: "timer",
    label: row.name || row.timer_id,
  }));
};

export const timersModule: BotModule<typeof settingsSchema> = {
  id: TIMER_MODULE_ID,
  panelIcon: { paths: ["M12 6v6l4 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateUsageSources,
  validateTemplateContent: validateTimerTemplateMutation,
  navigationEntries: [{
    id: "timers",
    label: { de: timersModuleCatalog.de.label, en: timersModuleCatalog.en.label },
    description: { de: timersModuleCatalog.de.description, en: timersModuleCatalog.en.description },
    group: "channel",
    iconKind: "timers",
    keywords: ["timer", "timers", "schedule", "zeitplan", "zeitgeber"],
  }],
  eventSubTypes: ["stream.online", "stream.offline"],
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
    const timers = await listTimers(context.DB, event.channelId);
    if (event.subscriptionType === "stream.offline") {
      for (const timer of timers) {
        if (timer.trigger.type !== "interval" && timer.trigger.type !== "stream_start") continue;
        if (await saveNextRunAt(context.DB, event.channelId, timer, null)) {
          await context.clearAlarm(alarmKeyFor(timer.id), timer.revision);
        }
      }
      return { actions: [], diagnostics: [] };
    }
    const startedAt = typeof event.payload.started_at === "string" ? Date.parse(event.payload.started_at) : Number.NaN;
    if (!Number.isFinite(startedAt)) return { actions: [], diagnostics: [] };
    const streamId = typeof event.payload.id === "string" ? event.payload.id : null;
    if (streamId === null || streamId.length === 0) return { actions: [], diagnostics: [] };
    const activityCount = await context.chatActivityCount();
    await context.DB.prepare("UPDATE timers SET last_chat_activity_count = ? WHERE channel_id = ? AND trigger_type = 'interval'")
      .bind(activityCount, event.channelId).run();
    for (const timer of timers) {
      if (!timer.enabled || (timer.trigger.type !== "interval" && timer.trigger.type !== "stream_start")) continue;
      const deadline = startedAt + triggerDelayMs(timer.trigger);
      if (await saveNextRunAt(context.DB, event.channelId, timer, deadline)) {
        await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline, timer.revision);
      }
    }
    return { actions: [], diagnostics: [] };
  },
};

export { timerTriggerSchema };
export type { Timer, TimerMutationInput, TimerTrigger } from "./contracts";
