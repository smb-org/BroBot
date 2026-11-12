import { Hono, type Context } from "hono";

import { hasRequiredChannelRole } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import {
  CHANNEL_POINTS_MODULE_ID,
  channelPointsRewardInputSchema,
  type ChannelPointsHelixReason,
} from "./contracts";
import { createChannelPointsRepository } from "./repository";
import {
  CHANNEL_POINTS_LIFECYCLE_ALARM,
  CHANNEL_POINTS_LIFECYCLE_HANDLER,
} from "./service";

type RouteContext = Context<ModuleRouteEnvironment>;
const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const channelIdFrom = (context: RouteContext): string => context.req.param("channelId") ?? "";
const requireManager = (context: RouteContext): Response | null =>
  hasRequiredChannelRole(context.get("channelRole"), "manager")
    ? null
    : context.json({ error: "channel_points_management_denied" }, 403);
const requireOperator = (context: RouteContext): Response | null =>
  hasRequiredChannelRole(context.get("channelRole"), "operator")
    ? null
    : context.json({ error: "channel_points_operation_denied" }, 403);
const nowIso = (): string => new Date().toISOString();
const runLifecycle = (context: RouteContext, channelId: string, invocation: unknown): Promise<unknown> =>
  context.get("runModuleAlarm")(
    channelId,
    CHANNEL_POINTS_MODULE_ID,
    CHANNEL_POINTS_LIFECYCLE_HANDLER,
    CHANNEL_POINTS_LIFECYCLE_ALARM,
    invocation,
  );
const moduleEnabled = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(channelId, CHANNEL_POINTS_MODULE_ID).first<{ enabled: number }>())?.enabled === 1;
const actionFailure = (reason: ChannelPointsHelixReason): { status: 403 | 409 | 422 | 424 | 429 | 502; error: string } => {
  if (reason === "not_affiliate") return { status: 403, error: "channel_points_not_affiliate" };
  if (reason === "reward_limit") return { status: 409, error: "channel_points_reward_limit" };
  if (reason === "duplicate_title") return { status: 409, error: "channel_points_duplicate_title" };
  if (reason === "scope_missing" || reason === "not_connected" || reason === "token_unavailable" ||
      reason === "revoked" || reason === "refresh_failed" || reason === "precondition_failed") {
    return { status: 424, error: "channel_points_" + reason };
  }
  if (reason === "invalid_input") return { status: 422, error: "channel_points_invalid_reward" };
  if (reason === "rate_limited") return { status: 429, error: "channel_points_rate_limited" };
  return { status: 502, error: "channel_points_" + reason };
};
const reasonResponse = (context: RouteContext, reason: ChannelPointsHelixReason): Response => {
  const failure = actionFailure(reason);
  return context.json({ error: failure.error }, failure.status);
};
const rewardOperationError = (error: string): { status: 404 | 409; error: string } => {
  if (error === "channel_points_reward_not_found") return { status: 404, error };
  return { status: 409, error };
};
const validateAction = async (input: ReturnType<typeof channelPointsRewardInputSchema.parse>): Promise<string | null> => {
  const { MODULES } = await import("../registry");
  const module = MODULES.find(({ id }) => id === input.actionModuleId);
  const action = module?.channelPointsActions?.find(({ id }) => id === input.actionId);
  if (action === undefined) return "channel_points_action_unknown";
  if (!action.configSchema.safeParse(input.actionConfig).success) return "channel_points_action_config_invalid";
  if (action.requiresUserInput === true && !input.isUserInputRequired) return "channel_points_action_needs_input";
  return null;
};

export const channelPointsRoutes = new Hono<ModuleRouteEnvironment>();

channelPointsRoutes.get("/state", async (context) => {
  const channelId = channelIdFrom(context);
  const [rewards, scopes, enabled] = await Promise.all([
    createChannelPointsRepository(context.env.DB).listRewards(channelId),
    context.get("broadcasterScopesForChannel")(context.env.DB, channelId),
    moduleEnabled(context.env.DB, channelId),
  ]);
  const identity = await context.env.DB.prepare(
    "SELECT status FROM twitch_login_identity WHERE user_id = ?",
  ).bind(channelId).first<{ status: string }>();
  const requiredScopes = ["channel:read:redemptions", "channel:manage:redemptions"];
  return context.json({
    rewards,
    moduleEnabled: enabled,
    connection: {
      connected: identity?.status === "connected",
      scopes,
      missingScopes: requiredScopes.filter((scope) => !scopes.includes(scope)),
    },
  });
});

channelPointsRoutes.get("/redemptions", async (context) => {
  const page = await createChannelPointsRepository(context.env.DB).listRedemptions(
    channelIdFrom(context), context.req.query("cursor") ?? null, 30,
  );
  return context.json(page);
});

channelPointsRoutes.get("/queue", async (context) => {
  const records = await createChannelPointsRepository(context.env.DB).listQueuedRedemptions(channelIdFrom(context), 100);
  const { MODULES } = await import("../registry");
  const items = records.map(({ redemption, actionModuleId, actionId }) => {
    const actionName = MODULES.find(({ id }) => id === actionModuleId)?.channelPointsActions
      ?.find(({ id }) => id === actionId)?.name ?? null;
    return { ...redemption, actionName };
  });
  return context.json({ items, count: items.length });
});

const queueOperationResponse = (context: RouteContext, result: unknown): Response => {
  if (!isRecord(result)) return context.json({ error: "channel_points_unknown_status" }, 502);
  if (result.ok === true && (result.status === "pending" || result.status === "fulfilled" || result.status === "refunded")) {
    return context.json({ ok: true, status: result.status });
  }
  if (result.error === "channel_points_redemption_not_queued") {
    return context.json({
      error: result.error,
      status: typeof result.status === "string" ? result.status : null,
    }, 409);
  }
  if (result.error === "channel_points_module_disabled") {
    return context.json({ error: result.error }, 409);
  }
  if (typeof result.reason === "string") return reasonResponse(context, result.reason as ChannelPointsHelixReason);
  return context.json({ error: "channel_points_unknown_status" }, 502);
};

const operateOnRedemption = async (context: RouteContext, operation: "run" | "refund"): Promise<Response> => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const result = await runLifecycle(context, channelIdFrom(context), {
    kind: operation === "run" ? "redemption.run" : "redemption.refund",
    actor: context.get("actor"),
    now: nowIso(),
    id: context.req.param("redemptionId"),
  });
  return queueOperationResponse(context, result);
};

channelPointsRoutes.post("/redemptions/:redemptionId/run", (context) => operateOnRedemption(context, "run"));
channelPointsRoutes.post("/redemptions/:redemptionId/refund", (context) => operateOnRedemption(context, "refund"));

channelPointsRoutes.post("/rewards", async (context) => {
  const denied = requireManager(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  const parsed = channelPointsRewardInputSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "channel_points_invalid_reward" }, 422);
  const actionError = await validateAction(parsed.data);
  if (actionError !== null) return context.json({ error: actionError }, 422);
  const result = await runLifecycle(context, channelId, {
    kind: "reward.create", actor: context.get("actor"), now: nowIso(), id: crypto.randomUUID(), reward: parsed.data,
  });
  if (!isRecord(result)) return context.json({ error: "channel_points_unknown_status" }, 502);
  if (result.ok !== true) {
    if (typeof result.error === "string") {
      const failure = rewardOperationError(result.error);
      return context.json({ error: failure.error }, failure.status);
    }
    return reasonResponse(context, result.reason as ChannelPointsHelixReason);
  }
  return context.json({ reward: result.reward }, 201);
});

channelPointsRoutes.put("/rewards/:id", async (context) => {
  const denied = requireManager(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  const parsed = channelPointsRewardInputSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "channel_points_invalid_reward" }, 422);
  const actionError = await validateAction(parsed.data);
  if (actionError !== null) return context.json({ error: actionError }, 422);
  const result = await runLifecycle(context, channelId, {
    kind: "reward.update", actor: context.get("actor"), now: nowIso(), id: context.req.param("id"), reward: parsed.data,
  });
  if (!isRecord(result)) return context.json({ error: "channel_points_unknown_status" }, 502);
  if (result.ok !== true) {
    if (typeof result.error === "string") {
      const failure = rewardOperationError(result.error);
      return context.json({ error: failure.error }, failure.status);
    }
    return reasonResponse(context, result.reason as ChannelPointsHelixReason);
  }
  return context.json({ reward: result.reward });
});

channelPointsRoutes.delete("/rewards/:id", async (context) => {
  const denied = requireManager(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  const result = await runLifecycle(context, channelId, {
    kind: "reward.delete", actor: context.get("actor"), now: nowIso(), id: context.req.param("id"),
  });
  if (!isRecord(result)) return context.json({ error: "channel_points_unknown_status" }, 502);
  if (result.ok !== true) {
    if (typeof result.error === "string") {
      const failure = rewardOperationError(result.error);
      return context.json({ error: failure.error }, failure.status);
    }
    return reasonResponse(context, result.reason as ChannelPointsHelixReason);
  }
  return context.json({ ok: true });
});

channelPointsRoutes.post("/rewards/:id/recreate", async (context) => {
  const denied = requireManager(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  const result = await runLifecycle(context, channelId, {
    kind: "reward.recreate", actor: context.get("actor"), now: nowIso(), id: context.req.param("id"),
  });
  if (!isRecord(result)) return context.json({ error: "channel_points_unknown_status" }, 502);
  if (result.ok !== true) {
    if (typeof result.error === "string") {
      const failure = rewardOperationError(result.error);
      return context.json({ error: failure.error }, failure.status);
    }
    return reasonResponse(context, result.reason as ChannelPointsHelixReason);
  }
  return context.json({ reward: result.reward });
});

channelPointsRoutes.post("/reconcile", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  const requestBody = await readBody(context.req.raw);
  const force = isRecord(requestBody) && requestBody["force"] === true;
  const result = await runLifecycle(context, channelId, {
    kind: "reconcile", actor: context.get("actor"), now: nowIso(), force,
  });
  if (result !== "success") {
    if (isRecord(result) && Array.isArray(result.failedRewards)) {
      return context.json({ ok: false, failedRewards: result.failedRewards }, 207);
    }
    if (isRecord(result) && typeof result.error === "string") {
      return context.json({ error: result.error }, result.error === "channel_points_module_disabled" ? 409 : 424);
    }
    return reasonResponse(context, result as ChannelPointsHelixReason);
  }
  return context.json({ ok: true });
});
