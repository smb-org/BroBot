import { Hono, type Context } from "hono";

import { hasRequiredChannelRole } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import {
  CHANNEL_POINTS_MAX_REWARDS,
  CHANNEL_POINTS_MODULE_ID,
  channelPointsRewardInputSchema,
  type ChannelPointsHelixReason,
} from "./contracts";
import { createChannelPointsRepository } from "./repository";
import { reconcileChannelPoints } from "./service";

type RouteContext = Context<ModuleRouteEnvironment>;
const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const channelIdFrom = (context: RouteContext): string => context.req.param("channelId") ?? "";
const requireOperator = (context: RouteContext): Response | null =>
  hasRequiredChannelRole(context.get("channelRole"), "operator")
    ? null
    : context.json({ error: "channel_points_management_denied" }, 403);
const nowIso = (): string => new Date().toISOString();
const authorizeCurrentOperator = (context: RouteContext, channelId: string) => async (): Promise<boolean> => {
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), nowIso());
  return await context.env.DB.prepare(
    "SELECT channel_id FROM channels WHERE channel_id = ? " + authorization.sql,
  ).bind(channelId, ...authorization.values).first<{ channel_id: string }>() !== null;
};
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

channelPointsRoutes.post("/rewards", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return context.json({ error: "channel_points_module_disabled" }, 409);
  const parsed = channelPointsRewardInputSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "channel_points_invalid_reward" }, 422);
  const actionError = await validateAction(parsed.data);
  if (actionError !== null) return context.json({ error: actionError }, 422);
  const rewardCount = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM channel_points_rewards WHERE channel_id = ? AND twitch_state = 'active'",
  ).bind(channelId).first<{ count: number }>();
  if ((rewardCount?.count ?? 0) >= CHANNEL_POINTS_MAX_REWARDS) {
    return reasonResponse(context, "reward_limit");
  }
  const authorize = authorizeCurrentOperator(context, channelId);
  const { createCustomReward } = await import("../../worker/twitch/channel-points");
  const created = await createCustomReward(context.env, channelId, parsed.data, authorize);
  if (!created.ok) return reasonResponse(context, created.reason);
  const remote = created.data[0];
  if (remote === undefined) return reasonResponse(context, "invalid_response");
  const now = nowIso();
  const id = crypto.randomUUID();
  await createChannelPointsRepository(context.env.DB).insertReward(channelId, parsed.data, id, remote.id, now);
  return context.json({ reward: await createChannelPointsRepository(context.env.DB).getReward(channelId, id) }, 201);
});

channelPointsRoutes.put("/rewards/:id", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return context.json({ error: "channel_points_module_disabled" }, 409);
  const parsed = channelPointsRewardInputSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "channel_points_invalid_reward" }, 422);
  const actionError = await validateAction(parsed.data);
  if (actionError !== null) return context.json({ error: actionError }, 422);
  const repository = createChannelPointsRepository(context.env.DB);
  const current = await repository.getReward(channelId, context.req.param("id"));
  if (current === null) return context.json({ error: "channel_points_reward_not_found" }, 404);
  if (current.twitchState === "deleted_on_twitch") return context.json({ error: "channel_points_reward_deleted" }, 409);
  const { updateCustomReward } = await import("../../worker/twitch/channel-points");
  const updated = await updateCustomReward(context.env, channelId, current.twitchRewardId, parsed.data, authorizeCurrentOperator(context, channelId));
  if (!updated.ok) return reasonResponse(context, updated.reason);
  await repository.updateReward(channelId, current.id, parsed.data, nowIso());
  return context.json({ reward: await repository.getReward(channelId, current.id) });
});

channelPointsRoutes.delete("/rewards/:id", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return context.json({ error: "channel_points_module_disabled" }, 409);
  const repository = createChannelPointsRepository(context.env.DB);
  const current = await repository.getReward(channelId, context.req.param("id"));
  if (current === null) return context.json({ error: "channel_points_reward_not_found" }, 404);
  const { deleteCustomReward } = await import("../../worker/twitch/channel-points");
  const deleted = await deleteCustomReward(context.env, channelId, current.twitchRewardId, authorizeCurrentOperator(context, channelId));
  if (!deleted.ok) return reasonResponse(context, deleted.reason);
  await repository.deleteReward(channelId, current.id);
  return context.json({ ok: true });
});

channelPointsRoutes.post("/rewards/:id/recreate", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return context.json({ error: "channel_points_module_disabled" }, 409);
  const repository = createChannelPointsRepository(context.env.DB);
  const current = await repository.getReward(channelId, context.req.param("id"));
  if (current === null) return context.json({ error: "channel_points_reward_not_found" }, 404);
  if (current.twitchState !== "deleted_on_twitch") return context.json({ error: "channel_points_reward_not_deleted" }, 409);
  const { createCustomReward } = await import("../../worker/twitch/channel-points");
  const created = await createCustomReward(
    context.env, channelId, current, authorizeCurrentOperator(context, channelId),
  );
  if (!created.ok) return reasonResponse(context, created.reason);
  const remote = created.data[0];
  if (remote === undefined) return reasonResponse(context, "invalid_response");
  await repository.replaceTwitchId(channelId, current.id, remote.id, nowIso());
  return context.json({ reward: await repository.getReward(channelId, current.id) });
});

channelPointsRoutes.post("/reconcile", async (context) => {
  const denied = requireOperator(context);
  if (denied !== null) return denied;
  const channelId = channelIdFrom(context);
  if (!await moduleEnabled(context.env.DB, channelId)) return context.json({ error: "channel_points_module_disabled" }, 409);
  const authorization = authorizeCurrentOperator(context, channelId);
  const requestBody = await readBody(context.req.raw);
  const force = isRecord(requestBody) && requestBody["force"] === true;
  const moduleContext = (await import("../../worker/module-action-context"))
    .createModuleActionExecutionContext(context.env, channelId, CHANNEL_POINTS_MODULE_ID);
  const result = await reconcileChannelPoints(context.env, channelId, nowIso(), {
    force,
    authorize: authorization,
    context: moduleContext,
  });
  if (result !== "success") return reasonResponse(context, result);
  return context.json({ ok: true });
});
