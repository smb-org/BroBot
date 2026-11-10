import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import type { ChannelRole } from "../../src/contracts/values";
import { channelPointsRoutes } from "../../src/modules/channel_points/routes";
import { TestD1Database } from "./test-d1";

const channelId = "channel_points";
const now = "2026-11-10T12:00:00.000Z";
const routeEnvironment = (database: TestD1Database): Env => {
  const environment: Partial<Env> = { DB: database as unknown as D1Database };
  return environment as Env;
};
const makeApp = (role: "member" | "operator") => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", role as ChannelRole);
    context.set("actor", { userId: "operator_one", sessionId: "session_one" });
    context.set("broadcasterScopesForChannel", () => Promise.resolve(["channel:read:redemptions"]));
    context.set("authorizeManagementMutation", () => ({ sql: "", values: [] }));
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

  it("serves state to members without writing panel data", async () => {
    database = createDatabase();
    const before = database.sqlite.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id=? AND resource='module:channel_points:data'",
    ).get(channelId);
    const response = await makeApp("member").request(
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
    const after = database.sqlite.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id=? AND resource='module:channel_points:data'",
    ).get(channelId);
    expect(after).toEqual(before);
  });

  it("requires operator role for mutations and validates action configuration before Helix", async () => {
    database = createDatabase();
    const requestBody = {
      title: "Fictional reward", prompt: null, cost: 1, backgroundColor: "#9147FF",
      isUserInputRequired: false, globalCooldownSeconds: null, maxPerStream: null,
      maxPerUserPerStream: null, actionModuleId: "channel_points", actionId: "chat-message",
      actionConfig: { message: "" }, mode: "auto", enabled: true,
    };
    const memberResponse = await makeApp("member").request(
      "/api/channels/channel_points/modules/channel_points/rewards", { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(memberResponse.status).toBe(403);
    const operatorResponse = await makeApp("operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards", { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(operatorResponse.status).toBe(422);
    expect(await operatorResponse.json()).toEqual({ error: "channel_points_action_config_invalid" });
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
    const response = await makeApp("operator").request(
      "/api/channels/channel_points/modules/channel_points/rewards",
      { method: "POST", body: JSON.stringify(requestBody) },
      routeEnvironment(database),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_points_reward_limit" });
  });
});
