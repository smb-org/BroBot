import { Hono, type Context } from "hono";

import { hasRequiredChannelRole, type AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { POLLS_ENTRY_MAXIMUM_COUNT, POLLS_MODULE_ID, pollsEntryInputSchema, type PollsEntry, type PollsRun } from "./contracts";
import { createPollsRepository } from "./repository";
import {
  cancelPredictionRun,
  endPollRun,
  loadFreshPrediction,
  lockPredictionRun,
  reconcile,
  resolvePredictionRun,
  startEntry,
  type PollsActionOutcome,
} from "./service";

type PollsRouteContext = Context<ModuleRouteEnvironment>;

const body = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const channelIdFrom = (context: PollsRouteContext): string => context.req.param("channelId") ?? "";
const repository = (context: PollsRouteContext) => createPollsRepository(context.env.DB);
const nowIso = (): string => new Date().toISOString();

const denied = (context: PollsRouteContext): Response =>
  context.json({ error: "polls_management_denied" }, 403);

const requireOperator = (context: PollsRouteContext): Response | null =>
  hasRequiredChannelRole(context.get("channelRole"), "operator") ? null : denied(context);

const moduleEnabled = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare(
    "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = ?",
  ).bind(channelId, POLLS_MODULE_ID).first<{ enabled: number }>())?.enabled === 1;

const moduleDisabled = (context: PollsRouteContext): Response =>
  context.json({ error: "polls_module_disabled" }, 409);

const entryAuditSnapshot = (entry: Pick<PollsEntry, "id" | "title" | "kind" | "revision" | "choices">) => ({
  entryId: entry.id,
  name: entry.title,
  kind: entry.kind,
  revision: entry.revision,
  choiceCount: entry.choices.length,
});

const runAuditSnapshot = (run: PollsRun) => ({
  runId: run.id,
  twitchId: run.twitchId,
  kind: run.kind,
  name: run.title,
  status: run.status,
});

const writeRunAudit = async (
  context: PollsRouteContext,
  action: AuditAction,
  run: PollsRun,
  after: Readonly<Record<string, string | number | boolean | null>> | null = runAuditSnapshot(run),
): Promise<void> => context.get("writeModuleAudit")({
  channelId: channelIdFrom(context),
  moduleId: POLLS_MODULE_ID,
  action,
  before: runAuditSnapshot(run),
  after,
}, nowIso(), { actorUserId: context.get("actor").userId });

const actionStatus = (reason: string): { status: 409 | 403 | 404 | 422 | 424 | 429 | 502; error: string } => {
  if (reason === "already_active" || reason === "not_open") {
    return { status: 409, error: `polls_${reason}` };
  }
  if (reason === "not_found") return { status: 404, error: "polls_run_not_found" };
  if (reason === "not_eligible") return { status: 403, error: "polls_not_eligible" };
  if (["not_connected", "token_unavailable", "scope_missing", "revoked", "refresh_failed", "precondition_failed"].includes(reason)) {
    return { status: 424, error: `polls_${reason}` };
  }
  if (reason === "rate_limited") return { status: 429, error: "polls_rate_limited" };
  return { status: 502, error: `polls_${reason}` };
};

const actionFailure = (context: PollsRouteContext, outcome: PollsActionOutcome): Response => {
  if (outcome.ok) return context.json({ run: outcome.run });
  const mapped = actionStatus(outcome.reason);
  return context.json({ error: mapped.error }, mapped.status);
};

export const pollsRoutes = new Hono<ModuleRouteEnvironment>();

pollsRoutes.get("/state", async (context) => {
  const channelId = channelIdFrom(context);
  const [openRuns, entries] = await Promise.all([
    repository(context).listOpenRuns(channelId),
    repository(context).listEntries(channelId),
  ]);
  return context.json({
    active: {
      poll: openRuns.find((run) => run.kind === "poll" && run.status === "active") ?? null,
      prediction: openRuns.find((run) => run.kind === "prediction" && run.status === "active") ?? null,
    },
    open: openRuns.filter((run) => run.kind === "prediction" && (run.status === "locked" || run.status === "unknown")),
    entries,
  });
});

pollsRoutes.get("/history", async (context) => {
  const page = await repository(context).listRunHistory(
    channelIdFrom(context),
    context.req.query("cursor") ?? null,
    20,
  );
  return context.json(page);
});

pollsRoutes.post("/entries", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const requestBody = await body(context.req.raw);
  const parsed = pollsEntryInputSchema.safeParse(requestBody);
  if (!parsed.success) {
    return context.json({
      error: "polls_invalid_entry",
      fields: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    }, 422);
  }

  const channelId = channelIdFrom(context);
  const now = nowIso();
  const entryId = crypto.randomUUID();
  const input = parsed.data;
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO polls_entries (
       channel_id, entry_id, kind, title, choices_json, duration_seconds,
       channel_points_voting_enabled, channel_points_per_vote, revision, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE (SELECT COUNT(*) FROM polls_entries WHERE channel_id = ?) < ? ${authorization.sql}
     RETURNING entry_id`,
  ).bind(
    channelId, entryId, input.kind, input.title, JSON.stringify(input.choices), input.durationSeconds,
    input.channelPointsVotingEnabled ? 1 : 0, input.channelPointsPerVote, now, now,
    channelId, POLLS_ENTRY_MAXIMUM_COUNT, ...authorization.values,
  );
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: POLLS_MODULE_ID,
    action: "polls.entry.created" satisfies AuditAction,
    before: null,
    after: { entryId, name: input.title, kind: input.kind, revision: 1, choiceCount: input.choices.length },
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    const count = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM polls_entries WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (count?.count ?? 0) >= POLLS_ENTRY_MAXIMUM_COUNT
      ? context.json({ error: "polls_entry_limit" }, 409)
      : denied(context);
  }
  const entry = await repository(context).getEntry(channelId, entryId);
  return context.json({ entry }, 201);
});

pollsRoutes.put("/entries/:entryId", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  const entryId = context.req.param("entryId");
  const current = await repository(context).getEntry(channelId, entryId);
  if (current === null) return context.json({ error: "polls_entry_not_found" }, 404);
  const requestBody = await body(context.req.raw);
  if (!isRecord(requestBody) || !Number.isSafeInteger(requestBody.revision) || (requestBody.revision as number) < 1) {
    return context.json({ error: "polls_invalid_entry", fields: [{ path: ["revision"], message: "Invalid revision." }] }, 422);
  }
  const expectedRevision = requestBody.revision as number;
  const parsed = pollsEntryInputSchema.safeParse(requestBody);
  if (!parsed.success) {
    return context.json({
      error: "polls_invalid_entry",
      fields: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    }, 422);
  }
  if (parsed.data.kind !== current.kind) return context.json({ error: "polls_entry_conflict" }, 409);
  if (expectedRevision !== current.revision) return context.json({ error: "polls_entry_conflict" }, 409);

  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE polls_entries
        SET title = ?, choices_json = ?, duration_seconds = ?, channel_points_voting_enabled = ?,
            channel_points_per_vote = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND entry_id = ? AND kind = ? AND revision = ? ${authorization.sql}
     RETURNING entry_id`,
  ).bind(
    parsed.data.title, JSON.stringify(parsed.data.choices), parsed.data.durationSeconds,
    parsed.data.channelPointsVotingEnabled ? 1 : 0, parsed.data.channelPointsPerVote, now,
    channelId, entryId, parsed.data.kind, expectedRevision, ...authorization.values,
  );
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: POLLS_MODULE_ID,
    action: "polls.entry.updated" satisfies AuditAction,
    before: entryAuditSnapshot(current),
    after: {
      entryId, name: parsed.data.title, kind: parsed.data.kind,
      revision: expectedRevision + 1, choiceCount: parsed.data.choices.length,
    },
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    const latest = await repository(context).getEntry(channelId, entryId);
    return latest === null
      ? context.json({ error: "polls_entry_not_found" }, 404)
      : latest.revision !== expectedRevision
        ? context.json({ error: "polls_entry_conflict" }, 409)
        : denied(context);
  }
  return context.json({ entry: await repository(context).getEntry(channelId, entryId) });
});

pollsRoutes.delete("/entries/:entryId", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  const entryId = context.req.param("entryId");
  const current = await repository(context).getEntry(channelId, entryId);
  if (current === null) return context.body(null, 404);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `DELETE FROM polls_entries WHERE channel_id = ? AND entry_id = ? ${authorization.sql} RETURNING entry_id`,
  ).bind(channelId, entryId, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: POLLS_MODULE_ID,
    action: "polls.entry.deleted" satisfies AuditAction,
    before: entryAuditSnapshot(current),
    after: null,
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    return await repository(context).getEntry(channelId, entryId) === null ? context.body(null, 404) : denied(context);
  }
  return context.body(null, 204);
});

pollsRoutes.post("/entries/:entryId/start", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return moduleDisabled(context);
  const outcome = await startEntry(context.env, channelId, context.req.param("entryId"), nowIso());
  if (!outcome.ok) {
    return outcome.reason === "not_found"
      ? context.json({ error: "polls_entry_not_found" }, 404)
      : actionFailure(context, outcome);
  }
  await writeRunAudit(context, "polls.run.started", outcome.run);
  return context.json({ run: outcome.run });
});

const runAction = async (
  context: PollsRouteContext,
  handler: (env: Env, channelId: string, runId: string) => Promise<PollsActionOutcome>,
  auditAction: AuditAction,
): Promise<Response> => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return moduleDisabled(context);
  const outcome = await handler(context.env, channelId, context.req.param("runId") ?? "");
  if (!outcome.ok) return actionFailure(context, outcome);
  await writeRunAudit(context, auditAction, outcome.run);
  return context.json({ run: outcome.run });
};

pollsRoutes.post("/runs/:runId/end", (context) => runAction(context, endPollRun, "polls.run.ended"));
pollsRoutes.post("/runs/:runId/lock", (context) => runAction(context, lockPredictionRun, "polls.run.locked"));

pollsRoutes.post("/runs/:runId/resolve", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return moduleDisabled(context);
  const requestBody = await body(context.req.raw);
  if (!isRecord(requestBody) || typeof requestBody.winningChoiceId !== "string" || requestBody.winningChoiceId.length === 0) {
    return context.json({ error: "polls_invalid_choice" }, 422);
  }
  const outcome = await resolvePredictionRun(context.env, channelId, context.req.param("runId"), requestBody.winningChoiceId);
  if (!outcome.ok) return actionFailure(context, outcome);
  await writeRunAudit(context, "polls.run.resolved", outcome.run);
  return context.json({ run: outcome.run });
});

pollsRoutes.post("/runs/:runId/cancel", (context) => runAction(context, cancelPredictionRun, "polls.run.canceled"));

pollsRoutes.get("/runs/:runId/fresh", async (context) => {
  if (!hasRequiredChannelRole(context.get("channelRole"), "operator")) return denied(context);
  const outcome = await loadFreshPrediction(context.env, channelIdFrom(context), context.req.param("runId"));
  return outcome.ok ? context.json({ run: outcome.run }) : actionFailure(context, outcome);
});

pollsRoutes.post("/runs/:runId/dismiss", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return moduleDisabled(context);
  const runId = context.req.param("runId");
  const current = await repository(context).findRunById(channelId, runId);
  if (current === null) return context.json({ error: "polls_run_not_found" }, 404);
  if (current.status !== "unknown") return context.json({ error: "polls_run_not_dismissible" }, 409);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE polls_runs SET status = 'canceled', ended_at = ?, last_event_at = ?
      WHERE channel_id = ? AND run_id = ? AND status = 'unknown' ${authorization.sql}
     RETURNING run_id`,
  ).bind(now, now, channelId, runId, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: POLLS_MODULE_ID,
    action: "polls.run.dismissed" satisfies AuditAction,
    before: runAuditSnapshot(current),
    after: { ...runAuditSnapshot(current), status: "canceled" },
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    const latest = await repository(context).findRunById(channelId, runId);
    return latest === null
      ? context.json({ error: "polls_run_not_found" }, 404)
      : latest.status !== "unknown"
        ? context.json({ error: "polls_run_not_dismissible" }, 409)
        : denied(context);
  }
  const dismissed = await repository(context).findRunById(channelId, runId);
  return context.json({ run: dismissed });
});

pollsRoutes.post("/reconcile", async (context) => {
  const deniedResponse = requireOperator(context);
  if (deniedResponse !== null) return deniedResponse;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return moduleDisabled(context);
  const requestBody = await body(context.req.raw);
  const force = isRecord(requestBody) && requestBody["force"] === true;
  const result = await reconcile(context.env, channelId, nowIso(), { force });
  if (result !== "success") {
    const mapped = actionStatus(result);
    return context.json({ error: mapped.error }, mapped.status);
  }
  if (!force) return context.json({ ok: true });
  await context.get("writeModuleAudit")({
    channelId,
    moduleId: POLLS_MODULE_ID,
    action: "polls.reconciled" satisfies AuditAction,
    before: null,
    after: null,
  }, nowIso(), { actorUserId: context.get("actor").userId });
  return context.json({ ok: true });
});
