import { Hono, type Context } from "hono";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import type { ModulePointsAccess } from "../contract";
import { isPointViewerAccountId, MAX_POINTS_ADJUSTMENT_REASON_LENGTH, POINTS_MODULE_ID } from "./contracts";

type PointsContext = Context<ModuleRouteEnvironment>;

interface PendingAdjustment {
  operationId: string;
  accountId: string;
  delta: number;
  reason: string;
  actorId: string;
  actorLogin: string;
  createdAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const channelIdFrom = (context: PointsContext): string => context.req.param("channelId") ?? "";
const points = (context: PointsContext): ModulePointsAccess => context.get("points")(channelIdFrom(context));
const denied = (context: PointsContext): Response => context.json({ error: "points_management_denied" }, 403);

const parsePending = (operationId: string, detail: unknown): PendingAdjustment | null => {
  if (!isRecord(detail) || typeof detail.accountId !== "string" || !Number.isSafeInteger(detail.delta) ||
      typeof detail.reason !== "string" || typeof detail.actorId !== "string" || typeof detail.actorLogin !== "string" ||
      typeof detail.createdAt !== "string") return null;
  return {
    operationId,
    accountId: detail.accountId,
    delta: detail.delta as number,
    reason: detail.reason,
    actorId: detail.actorId,
    actorLogin: detail.actorLogin,
    createdAt: detail.createdAt,
  };
};

const writeAdjustmentAudit = async (context: PointsContext, adjustment: PendingAdjustment): Promise<void> => {
  const operationId = adjustment.operationId;
  const account = await points(context).getAccount(adjustment.accountId);
  if (account === null) throw new Error("points_account_missing");
  await context.get("writeModuleAudit")({
    channelId: channelIdFrom(context),
    moduleId: POINTS_MODULE_ID,
    action: "points_adjusted",
    before: null,
    after: {
      operationId,
      accountId: adjustment.accountId,
      accountLogin: account.login,
      actorId: adjustment.actorId,
      delta: adjustment.delta,
      reason: adjustment.reason,
      actorLogin: adjustment.actorLogin,
    },
  }, adjustment.createdAt, { operationId, actorUserId: adjustment.actorId });
  await points(context).markAuditWritten(operationId);
};

const completePendingAudits = async (context: PointsContext): Promise<boolean> => {
  let complete = true;
  const pending = await points(context).pendingAudits();
  for (const item of pending) {
    const adjustment = parsePending(item.operationId, item.detail);
    if (adjustment === null) {
      complete = false;
      continue;
    }
    try {
      await writeAdjustmentAudit(context, adjustment);
    } catch {
      complete = false;
    }
  }
  return complete;
};

export const pointsRoutes = new Hono<ModuleRouteEnvironment>();

pointsRoutes.get("/summary", async (context) => context.json(await points(context).summary()));

pointsRoutes.get("/accounts", async (context) => {
  const sortValue = context.req.query("sort");
  if (sortValue !== undefined && sortValue !== "balance" && sortValue !== "month") {
    return context.json({ error: "points_query_invalid" }, 400);
  }
  const q = context.req.query("q")?.trim().slice(0, 100);
  const cursor = context.req.query("cursor");
  const access = points(context);
  if (canManage(context.get("channelRole"))) await completePendingAudits(context);
  const result = await access.listAccounts({
    sort: sortValue ?? "balance",
    ...(q === undefined || q.length === 0 ? {} : { search: q }),
    ...(cursor === undefined || cursor.length === 0 ? {} : { cursor }),
    limit: 50,
  });
  return context.json(result);
});

pointsRoutes.get("/accounts/:accountId", async (context) => {
  const accountId = context.req.param("accountId");
  if (!isPointViewerAccountId(accountId)) return context.json({ error: "invalid_account" }, 400);
  const account = await points(context).getAccount(accountId);
  if (account === null) return context.json({ error: "points_account_missing" }, 404);
  return context.json(account);
});

pointsRoutes.get("/accounts/:accountId/history", async (context) => {
  const accountId = context.req.param("accountId");
  const result = await points(context).history(accountId, context.req.query("cursor"), 25);
  return context.json(result);
});

pointsRoutes.get("/accounts/:accountId/rank", async (context) => {
  const month = new Date().toISOString().slice(0, 7);
  return context.json(await points(context).rankOf(context.req.param("accountId"), month));
});

pointsRoutes.post("/accounts/:accountId/adjust", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.operationId) ||
      !Number.isSafeInteger(body.delta) || body.delta === 0 ||
      typeof body.reason !== "string" || body.reason.trim().length === 0 ||
      body.reason.trim().length > MAX_POINTS_ADJUSTMENT_REASON_LENGTH) {
    return context.json({ error: "points_adjustment_invalid" }, 400);
  }
  const accountId = context.req.param("accountId");
  if (!isPointViewerAccountId(accountId)) return context.json({ error: "invalid_account" }, 400);
  const access = points(context);
  if (await access.getAccount(accountId) === null) return context.json({ error: "account_not_found" }, 404);
  const delta = body.delta as number;
  const actor = context.get("actor");
  const actorLogin = context.get("session").login ?? actor.userId;
  const operationId = `admin:${body.operationId}`;
  const reason = body.reason.trim();
  const actorId = context.get("actor").userId;
  const previous = (await access.pendingAudits()).find((item) => item.operationId === operationId);
  const previousDetail = previous === undefined ? null : parsePending(operationId, previous.detail);
  const previousMatches = previousDetail !== null && previousDetail.accountId === accountId &&
    previousDetail.delta === delta && previousDetail.reason === reason && previousDetail.actorId === actorId;

  // A manager retry can arrive after another page load already reconciled the
  // audit. The audit metadata carries the durable replay identity and payload.
  await completePendingAudits(context);
  const auditedRow = await context.env.DB.prepare(
    `SELECT after_json, actor_user_id FROM audit_log
      WHERE channel_id = ? AND module_id = ? AND action = ?
        AND json_extract(after_json, '$.operationId') = ?
      LIMIT 1`,
  ).bind(channelIdFrom(context), POINTS_MODULE_ID, "points_adjusted", operationId)
    .first<{ after_json: string | null; actor_user_id: string | null }>();
  if (auditedRow !== null) {
    let audited: unknown;
    try { audited = JSON.parse(auditedRow.after_json ?? "null") as unknown; } catch { audited = null; }
    if (!isRecord(audited) || audited.accountId !== accountId || audited.delta !== delta || audited.reason !== reason ||
        auditedRow.actor_user_id !== actorId) {
      return context.json({ error: "operation_conflict" }, 409);
    }
    return context.json({ balance: await access.balance(accountId), auditPending: false });
  }

  const detail: PendingAdjustment = previousMatches ? previousDetail : {
    operationId,
    accountId,
    delta,
    reason,
    actorId: actor.userId,
    actorLogin,
    createdAt: new Date().toISOString(),
  };

  try {
    const applied = await access.apply(operationId, "admin", [
      { accountId, delta },
      { accountId: "__house", delta: -delta },
    ], detail, { accountId, delta, reason, actorId });
    const appliedDetail = parsePending(operationId, applied.result);
    if (appliedDetail === null || appliedDetail.accountId !== accountId || appliedDetail.delta !== delta ||
        appliedDetail.reason !== reason || appliedDetail.actorId !== actorId) {
      throw new Error("operation_conflict");
    }
    const balance = await access.balance(accountId);
    try {
      await writeAdjustmentAudit(context, appliedDetail);
      return context.json({ balance, auditPending: false });
    } catch {
      return context.json({ balance, auditPending: true }, 202);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("insufficient_balance")) return context.json({ error: "insufficient_balance" }, 400);
    if (message.includes("balance_overflow")) return context.json({ error: "balance_overflow" }, 400);
    if (message.includes("operation_conflict")) return context.json({ error: "operation_conflict" }, 409);
    if (message.includes("invalid_account")) return context.json({ error: "points_account_missing" }, 404);
    throw error;
  }
});
