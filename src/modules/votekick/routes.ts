import { Hono } from "hono";

import type { AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { VOTEKICK_HISTORY_DAYS, VOTEKICK_LIFT_CLAIM_LEASE_MS, VOTEKICK_MODULE_ID } from "./contracts";
import { VOTEKICK_ELEMENT_KIND } from "./overlay/kinds";
import { createVotekickRepository } from "./adapters/d1";
import { votekickTimeoutReason } from "./domain";
import { votekickOverlayPayload } from "./service";

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
  const repository = createVotekickRepository(context.env.DB);
  const votekicks = await repository.listRecent(channelId, recentCutoff(now));
  return context.json({ running: votekicks.find((item) => item.status === "running") ?? null, votekicks, now });
});

votekickRoutes.post("/votekicks/:id/cancel", async (context) => {
  const channelId = requiredParam(context.req.param("channelId"), "channelId");
  const id = requiredParam(context.req.param("id"), "id");
  const existing = await createVotekickRepository(context.env.DB).running(channelId);
  if (existing === null) return context.json({ error: "votekick_not_running" }, 404);
  if (existing.id !== id) return context.json({ error: "votekick_changed" }, 409);

  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE votekicks SET status = 'cancelled', ended_at = ?
      WHERE channel_id = ? AND votekick_id = ? AND status = 'running'
        AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_modules.channel_id = votekicks.channel_id
             AND channel_modules.module_id = ? AND channel_modules.enabled = 1
        ) ${authorization.sql}`,
  ).bind(now, channelId, id, VOTEKICK_MODULE_ID, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: VOTEKICK_MODULE_ID,
    action: "votekick.cancelled" satisfies AuditAction,
    before: { status: "running" },
    after: { status: "cancelled" },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results.at(0)?.meta.changes !== 1) {
    const current = await createVotekickRepository(context.env.DB).running(channelId);
    if (current !== null && current.id !== id) return context.json({ error: "votekick_changed" }, 409);
    return context.json({ error: "votekick_not_running" }, 409);
  }
  try {
    const ballots = context.get("ballots")(channelId);
    const snapshot = await ballots.close(id);
    if (snapshot !== null) await ballots.acknowledgeClosed?.(id);
  } catch { /* The host hard-delete alarm is the cleanup fallback. */ }
  try {
    const cancelled = await createVotekickRepository(context.env.DB).byId(channelId, id);
    if (cancelled !== null) {
      await context.get("publishModuleOverlayMessage")(
        channelId,
        VOTEKICK_MODULE_ID,
        "tally",
        VOTEKICK_ELEMENT_KIND,
        votekickOverlayPayload(cancelled),
      );
    }
  } catch { /* The overlay bootstrap reloads the persisted cancellation later. */ }
  return context.body(null, 204);
});

votekickRoutes.post("/votekicks/:id/lift", async (context) => {
  const channelId = requiredParam(context.req.param("channelId"), "channelId");
  const id = requiredParam(context.req.param("id"), "id");
  const now = new Date().toISOString();
  const repository = createVotekickRepository(context.env.DB);
  const existing = (await repository.listRecent(channelId, recentCutoff(now)))
    .find((item) => item.id === id);
  if (existing === undefined || existing.status !== "passed" || existing.targetUserId === null || existing.liftedAt !== null) {
    return context.json({ error: "votekick_timeout_unavailable" }, 409);
  }
  if (existing.durationSeconds === null || existing.endedAt === null) {
    return context.json({ error: "votekick_timeout_unavailable" }, 409);
  }
  const claimId = crypto.randomUUID();
  const claimRetryAfter = new Date(Date.parse(now) - VOTEKICK_LIFT_CLAIM_LEASE_MS).toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const claim = await context.env.DB.prepare(
    `UPDATE votekicks SET lift_claim_id = ?, lift_claimed_at = ?
      WHERE channel_id = ? AND votekick_id = ? AND status = 'passed' AND lifted_at IS NULL
        AND target_user_id = ? AND duration_seconds = ? AND ended_at = ? AND yes_votes = ? AND no_votes = ?
        AND (lift_claimed_at IS NULL OR lift_claimed_at <= ?)
        AND (
          CAST(strftime('%s', ended_at) AS INTEGER) + duration_seconds > CAST(strftime('%s', ?) AS INTEGER)
          OR lift_claimed_at <= ?
        )
        AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_modules.channel_id = votekicks.channel_id
             AND channel_modules.module_id = ? AND channel_modules.enabled = 1
        ) ${authorization.sql}`,
  ).bind(claimId, now, channelId, id, existing.targetUserId, existing.durationSeconds, existing.endedAt,
    existing.yesVotes, existing.noVotes, claimRetryAfter, now, claimRetryAfter, VOTEKICK_MODULE_ID, ...authorization.values).run();
  if (claim.meta.changes === 0) {
    const authorized = await context.env.DB.prepare(
      `SELECT channel_id FROM channels
        WHERE channel_id = ?
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_modules.channel_id = channels.channel_id
               AND channel_modules.module_id = ? AND channel_modules.enabled = 1
          ) ${authorization.sql}`,
    ).bind(channelId, VOTEKICK_MODULE_ID, ...authorization.values).first<{ channel_id: string }>();
    return authorized === null
      ? context.json({ error: "votekick_timeout_unavailable" }, 403)
      : context.json({ error: "votekick_timeout_unavailable" }, 409);
  }

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
  if (result.outcome !== "applied") {
    if (result.outcome === "rejected") {
      await context.env.DB.prepare(
        `UPDATE votekicks SET lift_claim_id = NULL, lift_claimed_at = NULL
          WHERE channel_id = ? AND votekick_id = ? AND lift_claim_id = ? AND lifted_at IS NULL`,
      ).bind(channelId, id, claimId).run();
    }
    return context.json({ error: "votekick_timeout_lift_failed", reason: result.reason }, 502);
  }

  const update = await context.env.DB.prepare(
    `UPDATE votekicks SET lifted_at = ?, lift_claim_id = NULL, lift_claimed_at = NULL
      WHERE channel_id = ? AND votekick_id = ? AND status = 'passed' AND lifted_at IS NULL
        AND lift_claim_id = ?`,
  ).bind(new Date().toISOString(), channelId, id, claimId).run();
  if (update.meta.changes === 0) {
    return context.json({ error: "votekick_timeout_lift_pending" }, 502);
  }
  try {
    const lifted = await repository.byId(channelId, id);
    if (lifted !== null) {
      await context.get("publishModuleOverlayMessage")(
        channelId,
        VOTEKICK_MODULE_ID,
        "tally",
        VOTEKICK_ELEMENT_KIND,
        votekickOverlayPayload(lifted),
      );
    }
  } catch { /* The panel can reload the persisted lift state on its next read. */ }
  return context.json({ liftedAt: now });
});
