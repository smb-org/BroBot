import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import type { ChannelRole } from "../../src/contracts/values";
import { channelPointsRoutes } from "../../src/modules/channel_points/routes";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import { CHANNEL_POINTS_LIFECYCLE_HANDLER, channelPointsLifecycleAlarm } from "../../src/modules/channel_points/service";
import { TestD1Database } from "./test-d1";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateRedemptionStatus: vi.fn(),
  delete: vi.fn(),
  manageable: vi.fn(),
  byIds: vi.fn(),
  unfulfilled: vi.fn(),
  sendChat: vi.fn(),
}));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  createCustomReward: mocks.create,
  updateCustomReward: mocks.update,
  updateRedemptionStatus: mocks.updateRedemptionStatus,
  deleteCustomReward: mocks.delete,
  getManageableRewards: mocks.manageable,
  listRedemptionsByIds: mocks.byIds,
  listUnfulfilledRedemptions: mocks.unfulfilled,
}));
vi.mock("../../src/worker/module-action-context", () => ({
  createModuleActionExecutionContext: vi.fn(() => ({ sendChat: mocks.sendChat })),
}));

const channelId = "channel_points";
const now = "2026-11-10T12:00:00.000Z";
const helixRedemption = (id: string, status: "UNFULFILLED" | "FULFILLED" | "CANCELED", rewardId = "reward_twitch") => ({
  id,
  broadcaster_id: channelId,
  broadcaster_login: "points_demo",
  broadcaster_name: "Points Demo",
  user_id: "viewer_one",
  user_login: "viewer_demo",
  user_name: "Viewer Demo",
  user_input: "hello",
  status,
  redeemed_at: now,
  reward: { id: rewardId, title: "Fictional reward", prompt: "Say hello", cost: 1 },
});
const manageableReward = {
  id: "reward_twitch", title: "Fictional reward", prompt: "Say hello", cost: 1, is_enabled: true,
  background_color: "#9147FF", is_user_input_required: false, global_cooldown_seconds: null,
  max_per_stream: null, max_per_user_per_stream: null, is_paused: false, is_in_stock: true,
  should_redemptions_skip_request_queue: false,
};
const routeEnvironment = (database: TestD1Database): Env => {
  const environment: Partial<Env> = { DB: database as unknown as D1Database };
  return environment as Env;
};
const makeApp = (database: TestD1Database, role: "operator" | "manager" | "member") => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", role as ChannelRole);
    const userId = `user_${role}`;
    context.set("actor", { userId, sessionId: `session_${role}` });
    context.set("broadcasterScopesForChannel", () => Promise.resolve(["channel:read:redemptions"]));
    context.set("authorizeMutation", authorizeModuleMutation);
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("runModuleAlarm", (requestChannelId, _moduleId, _handlerKey, _alarmKey, invocation) =>
      channelPointsLifecycleAlarm.handle({
        DB: database as unknown as D1Database,
        environment: routeEnvironment(database),
        authorizeMutation: authorizeModuleMutation,
        authorizeManagementMutation: authorizeModuleManagementMutation,
        channelId: requestChannelId,
      } as never, CHANNEL_POINTS_LIFECYCLE_HANDLER, Date.now(), undefined, invocation));
    await next();
  });
  app.route("/api/channels/:channelId/modules/channel_points", channelPointsRoutes);
  return app;
};
const createDatabase = (): TestD1Database => {
  const database = new TestD1Database();
  database.sqlite.prepare(
    "INSERT INTO channels (channel_id,login,display_name,created_at,updated_at) VALUES (?,?,?,?,?)",
  ).run(channelId, "points_demo", "Points Demo", now, now);
  database.sqlite.prepare(
    "INSERT INTO channel_modules (channel_id,module_id,enabled,settings) VALUES (?, 'channel_points', 1, '{}')",
  ).run(channelId);
  for (const role of ["operator", "manager"] as const) {
    const userId = `user_${role}`;
    const sessionId = `session_${role}`;
    database.sqlite.prepare(
      "INSERT INTO channel_members (channel_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run(channelId, userId, role, now, now);
    database.sqlite.prepare(
      "INSERT INTO auth_sessions (session_id,user_id,login,expires_at,created_at,updated_at,revoked_at,revocation_reason) VALUES (?,?,?,?,?,?,NULL,NULL)",
    ).run(sessionId, userId, userId, "2099-01-01T00:00:00.000Z", now, now);
    database.sqlite.prepare(
      "INSERT INTO twitch_login_identity (user_id,login,scopes_json,access_token_ciphertext,refresh_token_ciphertext,expires_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(userId, userId, "[]", "access", "refresh", "2099-01-01T00:00:00.000Z", "connected", now, now);
  }
  database.sqlite.prepare(
    "INSERT INTO twitch_login_identity (user_id,login,scopes_json,access_token_ciphertext,refresh_token_ciphertext,expires_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(channelId, "points_demo", '["channel:read:redemptions"]', "cipher_access", "cipher_refresh", now, "connected", now, now);
  database.sqlite.prepare(
    "INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,cost,is_user_input_required,action_module_id,action_id,action_config_json,mode,enabled,twitch_state,created_at,updated_at) VALUES (?,? ,?, ?,1,0,'channel_points','chat-message','{\"message\":\"Hello\"}','auto',1,'active',?,?)",
  ).run(channelId, "reward_local", "reward_twitch", "Fictional reward", now, now);
  return database;
};

describe("channel points routes", () => {
  let database: TestD1Database | null = null;
  afterEach(() => {
    database?.close();
    database = null;
  });

  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ ok: true, data: [{
      id: "reward_twitch_created", title: "Fictional reward", prompt: "", cost: 1, is_enabled: true,
      background_color: "#9147FF", is_user_input_required: false, global_cooldown_seconds: null,
      max_per_stream: null, max_per_user_per_stream: null, is_paused: null, is_in_stock: null,
      should_redemptions_skip_request_queue: false,
    }] });
    mocks.update.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.updateRedemptionStatus.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.delete.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.manageable.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.byIds.mockReset().mockImplementation((_environment, _broadcasterId, rewardId, redemptionIds) =>
      Promise.resolve({
        ok: true,
        data: (redemptionIds as string[]).map((id) => helixRedemption(id, "UNFULFILLED", String(rewardId))),
      }));
    mocks.unfulfilled.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.sendChat.mockReset().mockResolvedValue({ sent: true, delivery: "sent", reason: null });
  });

  const seedQueuedRedemption = (id: string, redeemedAt = now): void => {
    if (database === null) throw new Error("The route database has not been initialized.");
    database.sqlite.prepare("UPDATE channel_points_rewards SET mode='queue' WHERE channel_id=? AND id=?")
      .run(channelId, "reward_local");
    database.sqlite.prepare(`INSERT INTO channel_points_redemptions
      (channel_id,redemption_id,reward_id,twitch_reward_id,reward_title,user_id,user_login,user_name,user_input,redeemed_at,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)`)
      .run(channelId, id, "reward_local", "reward_twitch", "Fictional reward", "viewer_one", "viewer_demo", "Viewer Demo", "hello", redeemedAt, redeemedAt, redeemedAt);
  };

  const seedPendingVipAction = (id: string): void => {
    if (database === null) throw new Error("The route database has not been initialized.");
    database.sqlite.prepare(
      `INSERT INTO channel_modules (channel_id,module_id,enabled,settings)
       VALUES (?,'temp_vips',1,'{"defaultDurationDays":7,"maximumDurationDays":90,"announceExpiry":false}')`,
    ).run(channelId);
    database.sqlite.prepare(`UPDATE channel_points_rewards
      SET action_module_id='temp_vips',action_id='grant-vip',action_config_json='{"durationDays":7}'
      WHERE channel_id=? AND id=?`).run(channelId, "reward_local");
    database.sqlite.prepare(`INSERT INTO channel_points_redemptions
      (channel_id,redemption_id,reward_id,twitch_reward_id,reward_title,user_id,user_login,user_name,user_input,redeemed_at,status,claimed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
      .run(channelId, id, "reward_local", "reward_twitch", "Fictional reward", "viewer_one", "viewer_demo", "Viewer Demo", "hello", now, now, now, now);
  };

  it("lists queued redemptions for read-only members oldest first with their action name", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_newer", "2026-11-10T12:01:00.000Z");
    seedQueuedRedemption("redemption_older", "2026-11-10T11:59:00.000Z");

    const response = await makeApp(database, "member").request(
      "/api/channels/channel_points/modules/channel_points/queue",
      {}, routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      count: 2,
      items: [
        { redemptionId: "redemption_older", status: "queued", actionName: { de: "Chat-Nachricht", en: "Chat message" } },
        { redemptionId: "redemption_newer", status: "queued", actionName: { de: "Chat-Nachricht", en: "Chat message" } },
      ],
    });
  });

  it("runs a queued redemption once and fulfills it in Twitch", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_run");

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_run/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "fulfilled" });
    expect(mocks.sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.sendChat).toHaveBeenCalledWith("Hello", "redemption_run");
    expect(mocks.byIds).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_run"], expect.any(Function),
    );
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_run"], "FULFILLED", expect.any(Function),
    );
  });

  it("does not run a queued redemption Twitch already canceled", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_twitch_canceled");
    mocks.byIds.mockResolvedValueOnce({
      ok: true,
      data: [helixRedemption("redemption_twitch_canceled", "CANCELED")],
    });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_twitch_canceled/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_already_resolved_on_twitch", status: "refunded" });
    expect(mocks.sendChat).not.toHaveBeenCalled();
    expect(mocks.updateRedemptionStatus).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      "SELECT status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_twitch_canceled")).toMatchObject({ status: "refunded" });
  });

  it("does not run a queued redemption Twitch already fulfilled", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_twitch_fulfilled");
    mocks.byIds.mockResolvedValueOnce({
      ok: true,
      data: [helixRedemption("redemption_twitch_fulfilled", "FULFILLED")],
    });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_twitch_fulfilled/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_already_resolved_on_twitch", status: "fulfilled" });
    expect(mocks.sendChat).not.toHaveBeenCalled();
    expect(mocks.updateRedemptionStatus).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      "SELECT status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_twitch_fulfilled")).toMatchObject({ status: "fulfilled" });
  });

  it("releases a queued redemption when the Twitch status lookup fails", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_twitch_unavailable");
    mocks.byIds.mockResolvedValueOnce({ ok: false, reason: "network" });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_twitch_unavailable/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "channel_points_twitch_status_unavailable" });
    expect(mocks.sendChat).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      "SELECT status,claimed_at FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_twitch_unavailable")).toMatchObject({ status: "queued", claimed_at: null });
  });

  it("orphans a queued redemption missing from Twitch without running it", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_twitch_missing");
    mocks.byIds.mockResolvedValueOnce({ ok: true, data: [] });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_twitch_missing/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_redemption_missing_on_twitch" });
    expect(mocks.sendChat).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      "SELECT status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_twitch_missing")).toMatchObject({ status: "orphaned" });
  });

  it("reconciles an interrupted refund by patching CANCELED without running the action", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_refund_interrupted");
    mocks.manageable.mockResolvedValue({ ok: true, data: [manageableReward] });
    database.sqlite.exec("CREATE TRIGGER fail_refund_outcome BEFORE UPDATE ON channel_points_redemptions " +
      "WHEN OLD.status='running' AND NEW.status='running' " +
      "BEGIN SELECT RAISE(FAIL, 'injected refund outcome write failure'); END");

    const refundResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_refund_interrupted/refund",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(refundResponse.status).toBe(500);
    expect(database.sqlite.prepare(
      "SELECT status,pending_twitch_status,outcome_reason_json FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_refund_interrupted")).toMatchObject({
      status: "running",
      pending_twitch_status: "CANCELED",
      outcome_reason_json: JSON.stringify({ de: "Von einem Bediener erstattet.", en: "Refunded by operator." }),
    });

    database.sqlite.exec("DROP TRIGGER fail_refund_outcome");
    database.sqlite.prepare(
      "UPDATE channel_points_redemptions SET claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).run("2026-11-10T11:57:00.000Z", channelId, "redemption_refund_interrupted");
    const reconcileResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/reconcile",
      { method: "POST", body: JSON.stringify({ force: true }) }, routeEnvironment(database),
    );

    expect(reconcileResponse.status).toBe(200);
    expect(mocks.sendChat).not.toHaveBeenCalled();
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_refund_interrupted"], "CANCELED", expect.any(Function),
    );
    expect(database.sqlite.prepare(
      "SELECT status,pending_twitch_status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_refund_interrupted")).toMatchObject({ status: "refunded", pending_twitch_status: null });
  });

  it("refunds a queued redemption with the operator reason", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_refund");

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_refund/refund",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "refunded" });
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_refund"], "CANCELED", expect.any(Function),
    );
    expect(database.sqlite.prepare(
      "SELECT status,outcome_reason_json FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_refund")).toMatchObject({
      status: "refunded", outcome_reason_json: JSON.stringify({ de: "Von einem Bediener erstattet.", en: "Refunded by operator." }),
    });
  });

  it("lets an operator refund a pending VIP action from the cockpit queue", async () => {
    database = createDatabase();
    seedPendingVipAction("redemption_pending_vip_refund");

    const app = makeApp(database, "operator");
    const queueResponse = await app.request(
      "/api/channels/channel_points/modules/channel_points/queue",
      {}, routeEnvironment(database),
    );
    expect(await queueResponse.json()).toMatchObject({
      items: [{ redemptionId: "redemption_pending_vip_refund", status: "pending" }],
    });

    const response = await app.request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_pending_vip_refund/refund",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "refunded" });
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_pending_vip_refund"], "CANCELED", expect.any(Function),
    );
    expect(database.sqlite.prepare(
      "SELECT status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_pending_vip_refund")).toMatchObject({ status: "refunded" });
  });

  it("does not execute a queue redemption twice when two runs race", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_double_run");
    const app = makeApp(database, "operator");
    const path = "/api/channels/channel_points/modules/channel_points/redemptions/redemption_double_run/run";

    const responses = await Promise.all([
      app.request(path, { method: "POST" }, routeEnvironment(database)),
      app.request(path, { method: "POST" }, routeEnvironment(database)),
    ]);

    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(mocks.sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects a run when the redemption is no longer queued and reports its status", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_already_done");
    database.sqlite.prepare("UPDATE channel_points_redemptions SET status='fulfilled' WHERE channel_id=? AND redemption_id=?")
      .run(channelId, "redemption_already_done");

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_already_done/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_redemption_not_queued", status: "fulfilled" });
    expect(mocks.sendChat).not.toHaveBeenCalled();
  });

  it("allows operators to run queue items and rejects a plain member", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_role");

    const operatorResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_role/run",
      { method: "POST" }, routeEnvironment(database),
    );
    const memberResponse = await makeApp(database, "member").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_role/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(operatorResponse.status).toBe(200);
    expect(memberResponse.status).toBe(403);
    expect(await memberResponse.json()).toEqual({ error: "channel_points_operation_denied" });
    expect(mocks.sendChat).toHaveBeenCalledTimes(1);
  });

  it("cancels Twitch when the reward action requests a refund", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_action_refund");
    mocks.sendChat.mockResolvedValue({ sent: false, delivery: "rejected", reason: "automod" });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_action_refund/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "refunded" });
    expect(mocks.updateRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_action_refund"], "CANCELED", expect.any(Function),
    );
  });

  it("records failed_to_update when Twitch rejects the redemption status patch", async () => {
    database = createDatabase();
    seedQueuedRedemption("redemption_patch_failure");
    mocks.updateRedemptionStatus.mockResolvedValue({ ok: false, reason: "unknown_status" });

    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/redemptions/redemption_patch_failure/run",
      { method: "POST" }, routeEnvironment(database),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "channel_points_unknown_status" });
    expect(database.sqlite.prepare(
      "SELECT status,pending_twitch_status FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?",
    ).get(channelId, "redemption_patch_failure")).toMatchObject({
      status: "failed_to_update", pending_twitch_status: "FULFILLED",
    });
    expect(mocks.sendChat).toHaveBeenCalledTimes(1);
  });

  it("serves state to members without writing panel data", async () => {
    database = createDatabase();
    const before = database.sqlite.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id=? AND resource='module:channel_points:data'",
    ).get(channelId);
    const app = makeApp(database, "operator");
    const response = await app.request(
      "/api/channels/channel_points/modules/channel_points/state",
      {},
      routeEnvironment(database),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rewards: [{ id: "reward_local", twitchRewardId: "reward_twitch" }],
      moduleEnabled: true,
      connection: { connected: true, missingScopes: ["channel:manage:redemptions"] },
    });
    const historyResponse = await app.request(
      "/api/channels/channel_points/modules/channel_points/redemptions",
      {},
      routeEnvironment(database),
    );
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toMatchObject({ items: [], cursor: null });
    const after = database.sqlite.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id=? AND resource='module:channel_points:data'",
    ).get(channelId);
    expect(after).toEqual(before);
  });

  it("denies operators reward mutations and lets managers create a reward", async () => {
    database = createDatabase();
    const requestBody = {
      title: "Fictional reward", prompt: null, cost: 1, backgroundColor: "#9147FF",
      isUserInputRequired: false, globalCooldownSeconds: null, maxPerStream: null,
      maxPerUserPerStream: null, actionModuleId: "channel_points", actionId: "chat-message",
      actionConfig: { message: "Hello" }, mode: "auto", enabled: true,
    };
    const createResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards", { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    const updateResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local", { method: "PUT", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    const deleteResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local", { method: "DELETE" },
      routeEnvironment(database),
    );
    const recreateResponse = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local/recreate", { method: "POST" },
      routeEnvironment(database),
    );
    for (const response of [createResponse, updateResponse, deleteResponse, recreateResponse]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "channel_points_management_denied" });
    }
    const managerResponse = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards", { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(managerResponse.status).toBe(201);
    expect(await managerResponse.json()).toMatchObject({ reward: { twitchRewardId: "reward_twitch_created" } });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const managerUpdate = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local",
      { method: "PUT", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(managerUpdate.status).toBe(200);
    const managerDelete = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local",
      { method: "DELETE" },
      routeEnvironment(database),
    );
    expect(managerDelete.status).toBe(200);

    database.sqlite.prepare(
      "INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,cost,is_user_input_required,action_module_id,action_id,action_config_json,mode,enabled,twitch_state,created_at,updated_at) VALUES (?,? ,?, ?,1,0,'channel_points','chat-message','{\"message\":\"Hello\"}','auto',1,'deleted_on_twitch',?,?)",
    ).run(channelId, "reward_local_deleted", "reward_twitch_deleted", "Deleted reward", now, now);
    mocks.create.mockResolvedValueOnce({ ok: true, data: [{
      id: "reward_twitch_recreated", title: "Deleted reward", prompt: "", cost: 1, is_enabled: true,
      background_color: "#9147FF", is_user_input_required: false, global_cooldown_seconds: null,
      max_per_stream: null, max_per_user_per_stream: null, is_paused: null, is_in_stock: null,
      should_redemptions_skip_request_queue: false,
    }] });
    const managerRecreate = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local_deleted/recreate",
      { method: "POST" },
      routeEnvironment(database),
    );
    expect(managerRecreate.status).toBe(200);
    expect(await managerRecreate.json()).toMatchObject({ reward: { twitchRewardId: "reward_twitch_recreated" } });
  });

  it("deletes a locally tombstoned reward without calling Helix", async () => {
    database = createDatabase();
    database.sqlite.prepare(
      "UPDATE channel_points_rewards SET twitch_state='deleted_on_twitch' WHERE channel_id=? AND id=?",
    ).run(channelId, "reward_local");

    const response = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local", { method: "DELETE" },
      routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM channel_points_rewards WHERE channel_id=? AND id=?",
    ).get(channelId, "reward_local")).toMatchObject({ count: 0 });
  });

  it("deletes the local reward when Helix reports that it is already missing", async () => {
    database = createDatabase();
    mocks.delete.mockResolvedValueOnce({ ok: false, reason: "not_found" });

    const response = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards/reward_local", { method: "DELETE" },
      routeEnvironment(database),
    );

    expect(response.status).toBe(200);
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM channel_points_rewards WHERE channel_id=? AND id=?",
    ).get(channelId, "reward_local")).toMatchObject({ count: 0 });
  });

  it("allows an operator to reconcile using the operational authorization guard", async () => {
    database = createDatabase();
    mocks.manageable.mockResolvedValue({ ok: true, data: [] });
    const response = await makeApp(database, "operator").request(
      "/api/channels/channel_points/modules/channel_points/reconcile",
      { method: "POST", body: JSON.stringify({ force: true }) },
      routeEnvironment(database),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.manageable).toHaveBeenCalledTimes(1);
  });

  it("enforces the 50-active-reward limit before calling Helix", async () => {
    database = createDatabase();
    const insert = database.sqlite.prepare(
      "INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,cost,is_user_input_required,action_module_id,action_id,action_config_json,mode,enabled,twitch_state,created_at,updated_at) VALUES (?, ?, ?, ?, 1, 0, 'channel_points', 'chat-message', '{\"message\":\"Hello\"}', 'auto', 1, 'active', ?, ?)",
    );
    for (let index = 1; index < 50; index += 1) {
      const id = "reward_local_" + String(index);
      insert.run(channelId, id, "reward_twitch_" + String(index), "Fictional reward " + String(index), now, now);
    }
    const requestBody = {
      title: "New reward", prompt: null, cost: 1, backgroundColor: "#9147FF",
      isUserInputRequired: false, globalCooldownSeconds: null, maxPerStream: null,
      maxPerUserPerStream: null, actionModuleId: "channel_points", actionId: "chat-message",
      actionConfig: { message: "Hello" }, mode: "auto", enabled: true,
    };
    const response = await makeApp(database, "manager").request(
      "/api/channels/channel_points/modules/channel_points/rewards",
      { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_reward_limit" });
  });
});
