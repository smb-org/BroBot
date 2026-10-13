import { Hono } from "hono";
import { canManage } from "../../contracts/values";
import type { AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { TIMER_MAXIMUM_COUNT } from "./contracts";
import type { Timer } from "./contracts";
import {
  mapTimerRow,
  preserveOfflineIntervalForLegacyMutation,
  timerForApiResponse,
  timerMutationInput,
  timerTriggerJson,
  validateTimerText,
  type TimerRow,
} from "./service";
import { readTextBlockGraphRevision, textBlockGraphRevisionChanged, textBlockWriteGuard } from "../contracts/text-block-write-guard";
import type { DurableTimerConfig } from "./durable";
import { clearTimerScheduleReconciliation, timerScheduleReconciliationMutation } from "../contracts/timer-schedule-reconciliation";

const MODULE_ID = "timers";
const nowIso = (): string => new Date().toISOString();

const retryTimerSchedulerMutation = async (
  db: D1Database,
  channelId: string,
  mutationId: string,
  timerId: string,
  revision: number,
  operation: () => Promise<void>,
  reconcile: () => Promise<void>,
): Promise<boolean> => {
  try {
    await operation();
    await clearTimerScheduleReconciliation(db, channelId, timerId, revision, mutationId, "activation");
    return true;
  } catch {
    try {
      await operation();
      await clearTimerScheduleReconciliation(db, channelId, timerId, revision, mutationId, "activation");
      return true;
    } catch {
      try {
        await reconcile();
        await clearTimerScheduleReconciliation(db, channelId, timerId, revision, mutationId, "activation");
        return true;
      } catch {
        return false;
      }
    }
  }
};

const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const manageDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "timer_management_denied" }, 403);

const durableConfig = (timer: Timer): DurableTimerConfig => ({
  id: timer.id,
  name: timer.name,
  enabled: timer.enabled,
  messageText: timer.messageText,
  chatTarget: timer.chatTarget,
  trigger: timer.trigger,
  revision: timer.revision,
});

const readTimer = async (db: D1Database, channelId: string, timerId: string): Promise<Timer | null> => {
  const row = await db.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_state,
            last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? AND timer_id = ?`,
  ).bind(channelId, timerId).first<TimerRow>();
  return row === null ? null : mapTimerRow(row);
};

const textValidationError = (reason: "missing" | "input_dependent"): string =>
  reason === "input_dependent" ? "timer_text_input_dependent" : "timer_text_block_missing";

export const timerRoutes = new Hono<ModuleRouteEnvironment>();

timerRoutes.get("/timers", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const result = await context.env.DB.prepare(
    `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
            next_run_at, next_run_state,
            last_run_at, created_at, updated_at
       FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id`,
  ).bind(channelId).all<TimerRow>();
  return context.json({ timers: result.results.map((row) => timerForApiResponse(mapTimerRow(row))) });
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
  const mutationId = crypto.randomUUID();
  const triggerJson = timerTriggerJson(input.trigger);
  const actor = context.get("actor");
  const authorization = context.get("authorizeManagementMutation")(channelId, actor, now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, chat_target, use_channel_default_target, revision,
       next_run_at, next_run_state, schedule_mirror_sequence, last_run_at, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, NULL, NULL, 0, NULL, ?, ?
       WHERE (SELECT COUNT(*) FROM timers WHERE channel_id = ?) < ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(timerId, channelId, input.name, input.messageText, input.trigger.type, triggerJson, input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0, now, now, channelId, TIMER_MAXIMUM_COUNT, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.created" satisfies AuditAction,
    before: null,
    after: { timerId, name: input.name, messageText: input.messageText, triggerType: input.trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([
    mutation,
    timerScheduleReconciliationMutation(context.env.DB, channelId, mutationId, now, true, "activation", { timerId, revision: 1 }),
    audit,
  ]);
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
  const config = {
    id: timerId,
    name: input.name,
    enabled: true,
    messageText: input.messageText,
    chatTarget: input.chatTarget,
    trigger: input.trigger,
    revision: 1,
  } satisfies DurableTimerConfig;
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await retryTimerSchedulerMutation(
    context.env.DB,
    channelId,
    mutationId,
    timerId,
    config.revision,
    () => stub.upsertTimerConfig(config),
    () => stub.reconcileTimerSchedules("activation"),
  );
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer: timer === null ? null : timerForApiResponse(timer) }, 201);
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
  const trigger = preserveOfflineIntervalForLegacyMutation(
    input.trigger,
    existing.trigger,
    isRecord(body) ? body.trigger : undefined,
  );
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const eventSourceId = trigger.type === "before_event" ? trigger.sourceId : null;
  if (eventSourceId !== null && !context.get("listEventTimeSources")().some((source) => source.id === eventSourceId)) {
    return context.json({ error: "timer_event_source_missing" }, 400);
  }
  const variables = await context.get("listRegisteredTemplateVariables")(channelId);
  const validation = await validateTimerText(context.env.DB, channelId, input.messageText, variables);
  if (!validation.ok) return context.json({ error: textValidationError(validation.reason) }, 400);
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, [input.messageText]);
  const now = nowIso();
  const mutationId = crypto.randomUUID();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE timers
        SET name = ?, message_text = ?, trigger_type = ?, trigger_json = ?, chat_target = ?, use_channel_default_target = ?,
            revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(input.name, input.messageText, trigger.type, timerTriggerJson(trigger), input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0, now,
    channelId, timerId, revision, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: "timers.timer.updated" satisfies AuditAction,
    before: { timerId, name: existing.name, messageText: existing.messageText, triggerType: existing.trigger.type, chatTarget: existing.chatTarget },
    after: { timerId, name: input.name, messageText: input.messageText, triggerType: trigger.type, chatTarget: input.chatTarget },
  }, now);
  const results = await context.env.DB.batch([
    mutation,
    timerScheduleReconciliationMutation(context.env.DB, channelId, mutationId, now, true, "activation", {
      timerId,
      revision: existing.revision + 1,
    }),
    audit,
  ]);
  if (results[0]?.meta.changes === 0) {
    const current = await readTimer(context.env.DB, channelId, timerId);
    return context.json({ error: current === null ? "timer_not_found" : "timer_conflict", ...(current === null ? {} : { timer: timerForApiResponse(current) }) }, 409);
  }
  const config = {
    id: timerId,
    name: input.name,
    enabled: existing.enabled,
    messageText: input.messageText,
    chatTarget: input.chatTarget,
    trigger,
    revision: existing.revision + 1,
  } satisfies DurableTimerConfig;
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await retryTimerSchedulerMutation(
    context.env.DB,
    channelId,
    mutationId,
    timerId,
    config.revision,
    () => stub.upsertTimerConfig(config),
    () => stub.reconcileTimerSchedules("activation"),
  );
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer: timer === null ? null : timerForApiResponse(timer) });
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
  const mutationId = crypto.randomUUID();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE timers SET enabled = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled <> ? ${authorization.sql}`,
  ).bind(enabled ? 1 : 0, now, channelId, timerId, revision, enabled ? 1 : 0, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: MODULE_ID,
    action: (enabled ? "timers.timer.enabled" : "timers.timer.disabled") satisfies AuditAction,
    before: { timerId, name: existing.name, enabled: existing.enabled },
    after: { timerId, name: existing.name, enabled },
  }, now);
  const results = await context.env.DB.batch([
    mutation,
    timerScheduleReconciliationMutation(context.env.DB, channelId, mutationId, now, true, "activation", {
      timerId,
      revision: existing.revision + 1,
    }),
    audit,
  ]);
  if (results[0]?.meta.changes === 0) {
    const current = await readTimer(context.env.DB, channelId, timerId);
    return current === null
      ? context.json({ error: "timer_not_found" }, 404)
      : current.revision !== revision ? context.json({ error: "timer_conflict", timer: timerForApiResponse(current) }, 409) : context.json({ timer: timerForApiResponse(current) });
  }
  const config = {
    ...durableConfig(existing),
    enabled,
    revision: existing.revision + 1,
  } satisfies DurableTimerConfig;
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await retryTimerSchedulerMutation(
    context.env.DB,
    channelId,
    mutationId,
    timerId,
    config.revision,
    () => stub.upsertTimerConfig(config),
    () => stub.reconcileTimerSchedules("activation"),
  );
  const timer = await readTimer(context.env.DB, channelId, timerId);
  return context.json({ timer: timer === null ? null : timerForApiResponse(timer) });
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
  const mutationId = crypto.randomUUID();
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
  const results = await context.env.DB.batch([
    mutation,
    timerScheduleReconciliationMutation(context.env.DB, channelId, mutationId, now, true, "activation", {
      timerId,
      revision: revision + 1,
    }),
    audit,
  ]);
  if (results[0]?.meta.changes === 0) return context.json({ error: "timer_conflict" }, 409);
  const stub = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await retryTimerSchedulerMutation(
    context.env.DB,
    channelId,
    mutationId,
    timerId,
    revision + 1,
    () => stub.deleteTimerConfig(timerId, revision),
    () => stub.reconcileTimerSchedules("activation"),
  );
  return context.body(null, 204);
});
