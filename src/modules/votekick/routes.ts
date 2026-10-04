import { Hono } from "hono";

import type { AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { VOTEKICK_HISTORY_DAYS, VOTEKICK_MODULE_ID } from "./contracts";
import { createVotekickRepository } from "./adapters/d1";
import { votekickTimeoutReason } from "./domain";

export const votekickRoutes = new Hono<ModuleRouteEnvironment>();

const requiredParam = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`Missing route parameter: ${name}.`);
  return value;
};

const recentCutoff = (now: string): string =>
  new Date(Date.parse(now) - VOTEKICK_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();

votekickRoutes.get("/votekicks", async (context) => {
  const channelId = requiredParam(context.req.param("channelId"), "channelId");
  const now = new Date().toISOString();
  const votekicks = await createVotekickRepository(context.env.DB).listRecent(channelId, recentCutoff(now));
  const running = votekicks.find((item) => item.status === "running") ?? null;
  return context.json({ running, votekicks, now });
});

votekickRoutes.post("/votekicks/:id/cancel", async (context) => {
  const channelId = requiredParam(context.req.param("channelId"), "channelId");
  const id = requiredParam(context.req.param("id"), "id");
  const existing = await createVotekickRepository(context.env.DB).running(channelId);
  if (existing === null || existing.id !== id) return context.json({ error: "votekick_not_running" }, 404);

  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE votekicks SET status = 'cancelled', ended_at = ?
      WHERE channel_id = ? AND votekick_id = ? AND status = 'running' ${authorization.sql}`,
  ).bind(now, channelId, id, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: VOTEKICK_MODULE_ID,
    action: "votekick.cancelled" satisfies AuditAction,
    before: { status: "running" },
    after: { status: "cancelled" },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results.at(0)?.meta.changes !== 1) return context.json({ error: "votekick_not_running" }, 409);
  try { await context.get("ballots")(channelId).close(id); } catch { /* The registered expiry alarm closes any remaining ballot. */ }
  return context.body(null, 204);
});

votekickRoutes.post("/votekicks/:id/lift", async (context) => {
  const channelId = requiredParam(context.req.param("channelId"), "channelId");
  const id = requiredParam(context.req.param("id"), "id");
  const repository = createVotekickRepository(context.env.DB);
  const existing = (await repository.listRecent(channelId, recentCutoff(new Date().toISOString())))
    .find((item) => item.id === id);
  if (existing === undefined || existing.status !== "passed" || existing.targetUserId === null || existing.liftedAt !== null) {
    return context.json({ error: "votekick_timeout_unavailable" }, 409);
  }
  if (existing.durationSeconds === null || existing.endedAt === null) {
    return context.json({ error: "votekick_timeout_unavailable" }, 409);
  }

  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const authorized = await context.env.DB.prepare(
    `SELECT channel_id FROM channels WHERE channel_id = ? ${authorization.sql}`,
  ).bind(channelId, ...authorization.values).first<{ channel_id: string }>();
  if (authorized === null) return context.json({ error: "votekick_timeout_unavailable" }, 403);

  const result = await context.get("liftModerationBan")(channelId, existing.targetUserId, {
    reason: votekickTimeoutReason(existing.yesVotes, existing.noVotes, existing.id),
    durationSeconds: existing.durationSeconds,
    startedAt: existing.endedAt,
  });
  await context.get("writeModuleAudit")({
    channelId,
    moduleId: VOTEKICK_MODULE_ID,
    action: "votekick.timeout_lift_attempted" satisfies AuditAction,
    before: { status: existing.status, lifted: false },
    after: { outcome: result.outcome, reason: result.reason },
  }, now);
  if (result.outcome !== "applied") return context.json({ error: "votekick_timeout_lift_failed", reason: result.reason }, 502);

  const update = await context.env.DB.prepare(
    `UPDATE votekicks SET lifted_at = ?
      WHERE channel_id = ? AND votekick_id = ? AND status = 'passed' AND lifted_at IS NULL
        AND target_user_id IS NOT NULL ${authorization.sql}`,
  ).bind(now, channelId, id, ...authorization.values).run();
  if (update.meta.changes === 0) return context.json({ error: "votekick_timeout_unavailable" }, 409);
  return context.json({ liftedAt: now });
});
