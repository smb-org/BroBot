import { z } from "zod";

import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import type { Timer } from "./contracts";
import { timerTriggerSchema } from "./contracts";
import { timersModuleCatalog } from "./contracts/catalog";
import { mapTimerRow, type TimerRow } from "./service";
import { nextDailyTimerAt, nextIntervalAt, nextTimerAt, timerOccurrenceKey, triggerDelayMs } from "./domain";
import { timerRoutes } from "./routes";

const settingsSchema = z.object({});
const TIMER_MODULE_ID = "timers";
const TIMER_ALARM_HANDLER = "run";
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

const saveNextRunAt = async (db: D1Database, channelId: string, timerId: string, at: number | null): Promise<void> => {
  await db.prepare("UPDATE timers SET next_run_at = ? WHERE channel_id = ? AND timer_id = ?")
    .bind(at === null ? null : new Date(at).toISOString(), channelId, timerId).run();
};

const rescheduleAfterRun = async (
  timer: Timer,
  context: Parameters<NonNullable<BotModule["alarms"]>[number]["handle"]>[0],
  deadline: number,
): Promise<void> => {
  const now = Date.now();
  let nextAt: number | null = null;
  if (timer.trigger.type === "interval") {
    if (await context.streamState() === "online") {
      nextAt = nextIntervalAt(deadline, now, timer.trigger.minutes);
    }
  } else if (timer.trigger.type === "time_of_day") {
    const row = await context.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
      .bind(context.channelId).first<{ time_zone: string }>();
    nextAt = nextDailyTimerAt(timer.trigger, now, row?.time_zone ?? "Europe/Berlin");
  } else if (timer.trigger.type === "before_event") {
    const channel = await context.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
      .bind(context.channelId).first<{ time_zone: string }>();
    nextAt = nextTimerAt(timer.trigger, {
      now,
      timeZone: channel?.time_zone ?? "Europe/Berlin",
      eventTimes: await context.resolveEventTimes(now),
    });
  }

  const alarmKey = alarmKeyFor(timer.id);
  if (nextAt === null) {
    await context.clear(alarmKey);
  } else {
    await context.schedule(alarmKey, nextAt);
  }
  await context.DB.prepare(
    "UPDATE timers SET next_run_at = ? WHERE channel_id = ? AND timer_id = ?",
  ).bind(
    nextAt === null ? null : new Date(nextAt).toISOString(),
    context.channelId,
    timer.id,
  ).run();
};

const isDueOccurrenceCurrent = async (
  timer: Timer,
  context: Parameters<NonNullable<BotModule["alarms"]>[number]["handle"]>[0],
  alarmKey: string,
  deadline: number,
): Promise<{ current: boolean; eventAt?: number }> => {
  if (alarmKey !== alarmKeyFor(timer.id)) return { current: false };
  if (timer.trigger.type === "interval") {
    return { current: await context.streamState() === "online" };
  }
  if (timer.trigger.type === "time_of_day") {
    return { current: timer.trigger.alsoOffline || await context.streamState() === "online" };
  }
  if (timer.trigger.type === "stream_start") {
    const [state, stream] = await Promise.all([context.streamState(), context.streamStartedAt()]);
    if (state !== "online" || stream.startedAt === null || stream.streamId === null) return { current: false };
    const expected = Date.parse(stream.startedAt) + triggerDelayMs(timer.trigger);
    return { current: expected === deadline };
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
  context: Parameters<NonNullable<BotModule["alarms"]>[number]["handle"]>[0],
  alarmKey: string,
  deadline: number,
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
  if (!timer.enabled) return;
  if (isEventTimeRefresh) {
    if (timer.trigger.type === "before_event") await rescheduleAfterRun(timer, context, deadline);
    return;
  }
  if (alarmKey !== alarmKeyFor(timer.id) || row.next_run_at === null || Date.parse(row.next_run_at) !== deadline) return;
  const occurrence = await isDueOccurrenceCurrent(timer, context, alarmKey, deadline);
  const now = Date.now();
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
      const idempotencyKey = timerOccurrenceKey(timer.id, deadline);
      const result = await context.sendChat(rendered.text, idempotencyKey, rendered.attributions);
      sent = result.sent;
      if (!result.sent && result.reason !== "already_attempted") {
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
  navigationEntries: [{
    id: "timers",
    label: { de: timersModuleCatalog.de.label, en: timersModuleCatalog.en.label },
    description: { de: timersModuleCatalog.de.description, en: timersModuleCatalog.en.description },
    group: "channel",
    iconKind: "timers",
    keywords: ["timer", "timers", "schedule", "zeitplan", "zeitgeber"],
  }],
  eventSubTypes: ["stream.online", "stream.offline"],
  alarms: [{ key: TIMER_ALARM_HANDLER, retryDelaysMs: [5_000, 15_000, 60_000], handle: handleTimerAlarm }],
  routes: timerRoutes,
  panel: () => import("./panel"),
  handleEvent: async (event, context) => {
    if (event.subscriptionType !== "stream.online" && event.subscriptionType !== "stream.offline") {
      return { actions: [], diagnostics: [] };
    }
    const timers = await listTimers(context.DB, event.channelId);
    if (event.subscriptionType === "stream.offline") {
      for (const timer of timers) {
        if (timer.trigger.type !== "interval" && timer.trigger.type !== "stream_start") continue;
        await context.clearAlarm(alarmKeyFor(timer.id));
        await saveNextRunAt(context.DB, event.channelId, timer.id, null);
      }
      return { actions: [], diagnostics: [] };
    }
    const startedAt = typeof event.payload.started_at === "string" ? Date.parse(event.payload.started_at) : Number.NaN;
    if (!Number.isFinite(startedAt)) return { actions: [], diagnostics: [] };
    const streamId = typeof event.payload.id === "string" ? event.payload.id : null;
    if (streamId === null || streamId.length === 0) return { actions: [], diagnostics: [] };
    for (const timer of timers) {
      if (!timer.enabled || (timer.trigger.type !== "interval" && timer.trigger.type !== "stream_start")) continue;
      const deadline = startedAt + triggerDelayMs(timer.trigger);
      await context.scheduleAlarm(TIMER_ALARM_HANDLER, alarmKeyFor(timer.id), deadline);
      await saveNextRunAt(context.DB, event.channelId, timer.id, deadline);
    }
    return { actions: [], diagnostics: [] };
  },
};

export { timerTriggerSchema };
export type { Timer, TimerMutationInput, TimerTrigger } from "./contracts";
