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
import { TIMER_MAXIMUM_COUNT, type TimerIntervalState } from "./contracts";
import type { Timer } from "./contracts";
import { mapTimerRow, timerMutationInput, validateTimerText, type TimerRow } from "./service";
import { readTextBlockGraphRevision, textBlockGraphRevisionChanged, textBlockWriteGuard } from "../contracts/text-block-write-guard";
import { persistIntervalTimerPlan } from "./scheduling";
import { timerAlarmIdentity } from "./identity";

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

const streamTransitionGeneration = async (db: D1Database, channelId: string): Promise<number> => {
  const row = await db.prepare("SELECT transition_generation FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ transition_generation: number }>();
  return row?.transition_generation ?? 0;
};

const readTimer = async (db: D1Database, channelId: string, timerId: string): Promise<Timer | null> => {
  const row = await db.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
            last_run_at, created_at, updated_at
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
): Promise<{ at: number | null; streamId: string | null; state: TimerIntervalState | null; streamGeneration: number | null }> => {
  if (trigger.type === "interval") {
    const stream = await db.prepare("SELECT state, stream_id, transition_generation FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null; transition_generation: number }>();
    const state: TimerIntervalState | null = stream?.state === "online" ? "live" : stream?.state === "offline" ? "offline" : null;
    const part = state === null ? undefined : trigger[state];
    return part === undefined || state === null
      ? { at: null, streamId: null, state: null, streamGeneration: stream?.transition_generation ?? 0 }
      : { at: now + part.minutes * 60_000, streamId: state === "live" ? stream?.stream_id ?? null : null, state,
          streamGeneration: stream?.transition_generation ?? 0 };
  }
  if (trigger.type === "stream_start") {
    const stream = await db.prepare("SELECT state, started_at, stream_id, transition_generation FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; started_at: string | null; stream_id: string | null; transition_generation: number }>();
    if (stream?.state !== "online" || stream.stream_id === null) {
      return { at: null, streamId: null, state: null, streamGeneration: stream?.transition_generation ?? 0 };
    }
    const at = nextStreamStartAt(stream.started_at, now, triggerDelayMs(trigger));
    return { at, streamId: at === null ? null : stream.stream_id, state: null,
      streamGeneration: stream.transition_generation };
  }
  const row = await db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ time_zone: string }>();
  const timeZone = row?.time_zone ?? "Europe/Berlin";
  if (trigger.type === "time_of_day") return {
    at: nextDailyTimerAt(trigger, now, timeZone), streamId: null, state: null,
    streamGeneration: null,
  };
  return {
    at: nextTimerAt(trigger, {
      now,
      timeZone,
      eventTimes: await resolveEventTimes(channelId, now),
    }),
    streamId: null,
    state: null,
    streamGeneration: null,
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
  resetActivityBaseline = false,
  previousTimer?: Timer,
): Promise<void> => {
  const key = alarmKeyFor(timerId);
  const current = await readTimer(context.env.DB, channelId, timerId);
  if (current === null || current.revision !== revision) return;
  const { at: deadline, streamId, state, streamGeneration } = enabled
    ? await nextRunFor(context.env.DB, context.get("resolveEventTimes"), channelId, trigger, now)
    : {
        at: null,
        streamId: null,
        state: null,
        streamGeneration: trigger.type === "interval" || trigger.type === "stream_start"
          ? await streamTransitionGeneration(context.env.DB, channelId)
          : null,
      };
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  let activityCount: number | null | undefined;
  if (resetActivityBaseline && trigger.type === "interval") {
    try { activityCount = await stub.getChatActivityCount(); } catch { activityCount = null; }
  }
  const saved = resetActivityBaseline && trigger.type === "interval"
    ? await persistIntervalTimerPlan(
      context.env.DB,
      channelId,
      current,
      deadline,
      streamId,
      state,
      activityCount ?? null,
      streamGeneration ?? 0,
      current,
    )
    : (await context.env.DB.prepare(
      `UPDATE timers SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?, next_run_generation = ?,
                          next_run_plan_sequence = next_run_plan_sequence + 1
        WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = ?
          AND trigger_type IS ? AND next_run_at IS ? AND next_run_stream_id IS ? AND next_run_state IS ?
          AND next_run_generation IS ? AND next_run_plan_sequence = ?
          AND (? IS NULL OR COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?)`,
    ).bind(deadline === null ? null : new Date(deadline).toISOString(), deadline === null ? null : streamId,
      deadline === null ? null : state, deadline === null ? null : streamGeneration,
      channelId, timerId, revision, enabled ? 1 : 0, current.trigger.type,
      current.nextRunAt, current.nextRunStreamId, current.nextRunState,
      current.nextRunGeneration, current.nextRunPlanSequence,
      streamGeneration, streamGeneration).run()).meta.changes > 0;
  if (!saved) return;
  const planSequence = current.nextRunPlanSequence + 1;
  const expectedIdentity = previousTimer?.nextRunAt !== null && previousTimer !== undefined
    ? timerAlarmIdentity(previousTimer, Date.parse(previousTimer.nextRunAt), previousTimer.nextRunState,
      previousTimer.nextRunStreamId, previousTimer.nextRunGeneration)
    : current.nextRunAt === null ? null : timerAlarmIdentity(current, Date.parse(current.nextRunAt),
      current.nextRunState, current.nextRunStreamId, current.nextRunGeneration);
  if (deadline === null) await stub.clearModuleAlarm(MODULE_ID, key, revision, streamGeneration,
    expectedIdentity, planSequence);
  else await stub.scheduleModuleAlarm(MODULE_ID, ALARM_HANDLER, key, deadline, revision, streamGeneration,
    timerAlarmIdentity(current, deadline, state, streamId, streamGeneration), planSequence);
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

const textValidationError = (reason: "missing" | "input_dependent"): string =>
  reason === "input_dependent" ? "timer_text_input_dependent" : "timer_text_block_missing";

export const timerRoutes = new Hono<ModuleRouteEnvironment>();

timerRoutes.get("/timers", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const result = await context.env.DB.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_stream_id, next_run_state, next_run_generation, next_run_plan_sequence,
            last_run_at, created_at, updated_at
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
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const eventSourceId = input.trigger.type === "before_event" ? input.trigger.sourceId : null;
  if (eventSourceId !== null && !context.get("listEventTimeSources")().some((source) => source.id === eventSourceId)) {
    return context.json({ error: "timer_event_source_missing" }, 400);
  }
  const [countRow, variables] = await Promise.all([
    context.env.DB.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?").bind(channelId).first<{ count: number }>(),
    context.get("listRegisteredTemplateVariables")(channelId),
  ]);
  if ((countRow?.count ?? 0) >= TIMER_MAXIMUM_COUNT) return context.json({ error: "timer_limit_reached" }, 409);
  const validation = await validateTimerText(context.env.DB, channelId, input.messageText, variables);
  if (!validation.ok) return context.json({ error: textValidationError(validation.reason) }, 400);
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, [input.messageText]);

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
      (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
       next_run_at, last_run_at, last_chat_activity_count, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM timers WHERE channel_id = ?) < ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(timerId, channelId, input.name, input.messageText, input.trigger.type, triggerJson, input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0,
    activityCount, now, now, channelId, TIMER_MAXIMUM_COUNT, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.created" satisfies AuditAction,
    before: null,
    after: { timerId, name: input.name, messageText: input.messageText, triggerType: input.trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    if (await textBlockGraphRevisionChanged(context.env.DB, channelId, graphRevision)) {
      return context.json({ error: "timer_conflict" }, 409);
    }
    const currentCount = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (currentCount?.count ?? 0) >= TIMER_MAXIMUM_COUNT
      ? context.json({ error: "timer_limit_reached" }, 409)
      : context.json({ error: "timer_management_denied" }, 403);
  }
  await setScheduledAlarm(context, channelId, timerId, input.trigger, true, Date.parse(now), 1, true);
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
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const eventSourceId = input.trigger.type === "before_event" ? input.trigger.sourceId : null;
  if (eventSourceId !== null && !context.get("listEventTimeSources")().some((source) => source.id === eventSourceId)) {
    return context.json({ error: "timer_event_source_missing" }, 400);
  }
  const variables = await context.get("listRegisteredTemplateVariables")(channelId);
  const validation = await validateTimerText(context.env.DB, channelId, input.messageText, variables);
  if (!validation.ok) return context.json({ error: textValidationError(validation.reason) }, 400);
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, [input.messageText]);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE timers
        SET name = ?, message_text = ?, trigger_type = ?, trigger_json = ?, chat_target = ?, use_channel_default_target = ?,
            next_run_at = NULL, next_run_stream_id = NULL, next_run_state = NULL, next_run_generation = NULL,
            next_run_plan_sequence = next_run_plan_sequence + 1, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(input.name, input.messageText, input.trigger.type, JSON.stringify(input.trigger), input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0, now,
    channelId, timerId, revision, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.updated" satisfies AuditAction,
    before: { timerId, name: existing.name, messageText: existing.messageText, triggerType: existing.trigger.type, chatTarget: existing.chatTarget },
    after: { timerId, name: input.name, messageText: input.messageText, triggerType: input.trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const current = await readTimer(context.env.DB, channelId, timerId);
    return context.json({ error: current === null ? "timer_not_found" : "timer_conflict", ...(current === null ? {} : { timer: current }) }, 409);
  }
  await setScheduledAlarm(context, channelId, timerId, input.trigger, existing.enabled,
    Date.parse(now), existing.revision + 1, true, existing);
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
    `UPDATE timers SET enabled = ?, next_run_at = NULL, next_run_stream_id = NULL, next_run_state = NULL,
                       next_run_generation = NULL, next_run_plan_sequence = next_run_plan_sequence + 1,
                       revision = revision + 1, updated_at = ?
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
  await setScheduledAlarm(context, channelId, timerId, existing.trigger, enabled,
    Date.parse(now), existing.revision + 1, true, existing);
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
    before: { timerId, name: existing.name, messageText: existing.messageText, triggerType: existing.trigger.type, chatTarget: existing.chatTarget },
    after: null,
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) return context.json({ error: "timer_conflict" }, 409);
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  const expectedIdentity = existing.nextRunAt === null ? null : timerAlarmIdentity(existing,
    Date.parse(existing.nextRunAt), existing.nextRunState, existing.nextRunStreamId, existing.nextRunGeneration);
  await stub.clearModuleAlarm(MODULE_ID, alarmKeyFor(timerId), revision + 1, null,
    expectedIdentity, existing.nextRunPlanSequence + 1);
  return context.body(null, 204);
});
