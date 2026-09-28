import { Hono, type Context } from "hono";
import { canManage } from "../../contracts/values";
import type { AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment, ModuleRouteVariables } from "../contract";
import {
  alarmKeyFor,
  eventTimeRefreshKeyFor,
  eventTimeWindowEnd,
  nextDailyTimerAt,
  nextStreamStartAt,
  nextTimerAt,
  triggerDelayMs,
} from "./domain";
import { TIMER_MAXIMUM_COUNT, timerTriggerSchema } from "./contracts";
import type { Timer } from "./contracts";
import { mapTimerRow, timerMutationInput, validateTimerBlock, type TimerRow } from "./service";

const MODULE_ID = "timers";
const ALARM_HANDLER = "run";
const nowIso = (): string => new Date().toISOString();

const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const manageDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "timer_management_denied" }, 403);

type ResolveEventTimes = ModuleRouteVariables["resolveEventTimes"];
type TimerRouteContext = Context<ModuleRouteEnvironment>;

const readTimer = async (db: D1Database, channelId: string, timerId: string): Promise<Timer | null> => {
  const row = await db.prepare(
    `SELECT timer_id, name, enabled, block_name, trigger_type, trigger_json, chat_target, revision,
            next_run_at, next_run_stream_id, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(channelId, timerId).first<TimerRow>();
  return row === null ? null : mapTimerRow(row);
};

/** `streamId` is only meaningful alongside a non-null `at` -- callers must not persist it otherwise. */
const nextRunFor = async (
  db: D1Database,
  resolveEventTimes: ResolveEventTimes,
  channelId: string,
  trigger: Timer["trigger"],
  now: number,
): Promise<{ at: number | null; streamId: string | null }> => {
  if (trigger.type === "interval") {
    const stream = await db.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null }>();
    return stream?.state === "online"
      ? { at: now + trigger.minutes * 60_000, streamId: stream.stream_id }
      : { at: null, streamId: null };
  }
  if (trigger.type === "stream_start") {
    const stream = await db.prepare("SELECT state, started_at, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; started_at: string | null; stream_id: string | null }>();
    if (stream?.state !== "online" || stream.stream_id === null) return { at: null, streamId: null };
    const at = nextStreamStartAt(stream.started_at, now, triggerDelayMs(trigger));
    return { at, streamId: at === null ? null : stream.stream_id };
  }
  const row = await db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ time_zone: string }>();
  const timeZone = row?.time_zone ?? "Europe/Berlin";
  if (trigger.type === "time_of_day") return { at: nextDailyTimerAt(trigger, now, timeZone), streamId: null };
  return {
    at: nextTimerAt(trigger, {
      now,
      timeZone,
      eventTimes: await resolveEventTimes(channelId, now),
    }),
    streamId: null,
  };
};

const setScheduledAlarm = async (
  context: TimerRouteContext,
  channelId: string,
  timerId: string,
  trigger: Timer["trigger"],
  enabled: boolean,
  now: number,
  revision: number,
): Promise<void> => {
  const key = alarmKeyFor(timerId);
  const { at: deadline, streamId } = enabled
    ? await nextRunFor(context.env.DB, context.get("resolveEventTimes"), channelId, trigger, now)
    : { at: null, streamId: null };
  const result = await context.env.DB.prepare(
    "UPDATE timers SET next_run_at = ?, next_run_stream_id = ? WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = ?",
  ).bind(deadline === null ? null : new Date(deadline).toISOString(), deadline === null ? null : streamId,
    channelId, timerId, revision, enabled ? 1 : 0).run();
  if (result.meta.changes === 0) return;
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  if (deadline === null) await stub.clearModuleAlarm(MODULE_ID, key, revision);
  else await stub.scheduleModuleAlarm(MODULE_ID, ALARM_HANDLER, key, deadline, revision);
  // A before_event timer whose source reports no occurrence within its own
  // horizon must not go dormant (e.g. a sunrise timer created during polar
  // night): schedule the same horizon-replan check the alarm handler's own
  // replan path uses (scheduleNextRun in ./index), so create, edit and
  // enable keep looking instead of leaving the timer without any alarm.
  if (enabled && deadline === null && trigger.type === "before_event") {
    const horizon = eventTimeWindowEnd(now);
    await stub.scheduleModuleAlarm(MODULE_ID, ALARM_HANDLER, eventTimeRefreshKeyFor(timerId, horizon), horizon);
  }
};

const inputDependentError = (reason: "missing" | "input_dependent"): string =>
  reason === "input_dependent" ? "timer_block_input_dependent" : "timer_block_missing";

export const timerRoutes = new Hono<ModuleRouteEnvironment>();

timerRoutes.get("/timers", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const result = await context.env.DB.prepare(
    `SELECT timer_id, name, enabled, block_name, trigger_type, trigger_json, chat_target, revision,
            next_run_at, next_run_stream_id, last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id`,
  ).bind(channelId).all<TimerRow>();
  return context.json({ timers: result.results.map(mapTimerRow) });
});

timerRoutes.get("/event-time-sources", (context) =>
  context.json({ sources: context.get("listEventTimeSources")() }),
);

timerRoutes.post("/timers", async (context) => {
  if (!canManage(context.get("channelRole"))) return manageDenied(context);
  const channelId = context.req.param("channelId") ?? "";
  const input = timerMutationInput(await readBody(context.req.raw));
  if (input === null) return context.json({ error: "timer_invalid" }, 400);
  const eventSourceId = input.trigger.type === "before_event" ? input.trigger.sourceId : null;
  if (eventSourceId !== null && !context.get("listEventTimeSources")().some((source) => source.id === eventSourceId)) {
    return context.json({ error: "timer_event_source_missing" }, 400);
  }
  const [countRow, variables] = await Promise.all([
    context.env.DB.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?").bind(channelId).first<{ count: number }>(),
    context.get("listRegisteredTemplateVariables")(channelId),
  ]);
  if ((countRow?.count ?? 0) >= TIMER_MAXIMUM_COUNT) return context.json({ error: "timer_limit_reached" }, 409);
  const validation = await validateTimerBlock(context.env.DB, channelId, input.blockName, variables);
  if (!validation.ok) return context.json({ error: inputDependentError(validation.reason) }, 400);

  const timerId = crypto.randomUUID();
  const now = nowIso();
  const triggerJson = JSON.stringify(input.trigger);
  const actor = context.get("actor");
  const authorization = context.get("authorizeManagementMutation")(channelId, actor, now);
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  let activityCount: number | null = null;
  try { activityCount = await stub.getChatActivityCount(); } catch { /* A missing baseline is initialized on first run. */ }
  const mutation = context.env.DB.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, block_name, trigger_type, trigger_json, chat_target, revision,
       next_run_at, last_run_at, last_chat_activity_count, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM timers WHERE channel_id = ?) < ? ${authorization.sql}`,
  ).bind(timerId, channelId, input.name, input.blockName, input.trigger.type, triggerJson, input.chatTarget,
    activityCount, now, now, channelId, TIMER_MAXIMUM_COUNT, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.created" satisfies AuditAction,
    before: null,
    after: { timerId, name: input.name, blockName: input.blockName, triggerType: input.trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const currentCount = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (currentCount?.count ?? 0) >= TIMER_MAXIMUM_COUNT
      ? context.json({ error: "timer_limit_reached" }, 409)
      : context.json({ error: "timer_management_denied" }, 403);
  }
  await setScheduledAlarm(context, channelId, timerId, input.trigger, true, Date.parse(now), 1);
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer }, 201);
});

timerRoutes.patch("/timers/:timerId", async (context) => {
  if (!canManage(context.get("channelRole"))) return manageDenied(context);
  const channelId = context.req.param("channelId") ?? "";
  const timerId = context.req.param("timerId");
  const existing = await readTimer(context.env.DB, channelId, timerId);
  if (existing === null) return context.json({ error: "timer_not_found" }, 404);
  const body = await readBody(context.req.raw);
  const revision = isRecord(body) ? body.revision : null;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) return context.json({ error: "timer_invalid" }, 400);
  const input = timerMutationInput(body);
  if (input === null) return context.json({ error: "timer_invalid" }, 400);
  const eventSourceId = input.trigger.type === "before_event" ? input.trigger.sourceId : null;
  if (eventSourceId !== null && !context.get("listEventTimeSources")().some((source) => source.id === eventSourceId)) {
    return context.json({ error: "timer_event_source_missing" }, 400);
  }
  const variables = await context.get("listRegisteredTemplateVariables")(channelId);
  const validation = await validateTimerBlock(context.env.DB, channelId, input.blockName, variables);
  if (!validation.ok) return context.json({ error: inputDependentError(validation.reason) }, 400);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE timers
        SET name = ?, block_name = ?, trigger_type = ?, trigger_json = ?, chat_target = ?,
            next_run_at = NULL, next_run_stream_id = NULL, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? ${authorization.sql}`,
  ).bind(input.name, input.blockName, input.trigger.type, JSON.stringify(input.trigger), input.chatTarget, now,
    channelId, timerId, revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.updated" satisfies AuditAction,
    before: { timerId, name: existing.name, blockName: existing.blockName, triggerType: existing.trigger.type, chatTarget: existing.chatTarget },
    after: { timerId, name: input.name, blockName: input.blockName, triggerType: input.trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const current = await readTimer(context.env.DB, channelId, timerId);
    return context.json({ error: current === null ? "timer_not_found" : "timer_conflict", ...(current === null ? {} : { timer: current }) }, 409);
  }
  await setScheduledAlarm(context, channelId, timerId, input.trigger, existing.enabled, Date.parse(now), existing.revision + 1);
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer });
});

timerRoutes.patch("/timers/:timerId/enabled", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const timerId = context.req.param("timerId");
  const existing = await readTimer(context.env.DB, channelId, timerId);
  if (existing === null) return context.json({ error: "timer_not_found" }, 404);
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || typeof body.enabled !== "boolean" ||
      !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
    return context.json({ error: "timer_invalid" }, 400);
  }
  const enabled = body.enabled;
  const revision = body.revision as number;
  const now = nowIso();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE timers SET enabled = ?, next_run_at = NULL, next_run_stream_id = NULL, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled <> ? ${authorization.sql}`,
  ).bind(enabled ? 1 : 0, now, channelId, timerId, revision, enabled ? 1 : 0, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: (enabled ? "timers.timer.enabled" : "timers.timer.disabled") satisfies AuditAction,
    before: { timerId, name: existing.name, enabled: existing.enabled },
    after: { timerId, name: existing.name, enabled },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const current = await readTimer(context.env.DB, channelId, timerId);
    return current === null
      ? context.json({ error: "timer_not_found" }, 404)
      : current.revision !== revision ? context.json({ error: "timer_conflict", timer: current }, 409) : context.json({ timer: current });
  }
  await setScheduledAlarm(context, channelId, timerId, existing.trigger, enabled, Date.parse(now), existing.revision + 1);
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer });
});

timerRoutes.delete("/timers/:timerId", async (context) => {
  if (!canManage(context.get("channelRole"))) return manageDenied(context);
  const channelId = context.req.param("channelId") ?? "";
  const timerId = context.req.param("timerId");
  const existing = await readTimer(context.env.DB, channelId, timerId);
  if (existing === null) return context.json({ error: "timer_not_found" }, 404);
  const revision = Number(context.req.query("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) return context.json({ error: "timer_invalid" }, 400);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `DELETE FROM timers WHERE channel_id = ? AND timer_id = ? AND revision = ? ${authorization.sql}`,
  ).bind(channelId, timerId, revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.removed" satisfies AuditAction,
    before: { timerId, name: existing.name, blockName: existing.blockName, triggerType: existing.trigger.type, chatTarget: existing.chatTarget },
    after: null,
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) return context.json({ error: "timer_conflict" }, 409);
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await stub.clearModuleAlarm(MODULE_ID, alarmKeyFor(timerId), revision + 1);
  return context.body(null, 204);
});

export { timerTriggerSchema };
