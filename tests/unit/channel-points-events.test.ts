import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { channelPointsModule } from "../../src/modules/channel_points";
import { MODULES } from "../../src/modules/registry";
import { processChannelPointsEvent, reconcileChannelPoints } from "../../src/modules/channel_points/service";
import { createChannelPointsRepository } from "../../src/modules/channel_points/repository";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";
import { TestD1Database } from "./test-d1";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  setEnabled: vi.fn(),
}));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  updateRedemptionStatus: mocks.update,
  listUnfulfilledRedemptions: mocks.list,
  setCustomRewardEnabled: mocks.setEnabled,
}));

const channelId = "channel_points";
const now = "2026-11-10T12:00:00.000Z";
const reward: ChannelPointsRewardInput = {
  title: "Fictional reward",
  prompt: null,
  cost: 10,
  backgroundColor: "#9147FF",
  isUserInputRequired: false,
  globalCooldownSeconds: null,
  maxPerStream: null,
  maxPerUserPerStream: null,
  actionModuleId: "channel_points",
  actionId: "chat-message",
  actionConfig: { message: "Hi {user}: {input} ({reward})" },
  mode: "auto",
  enabled: true,
};
const redemptionPayload = (id = "redemption_one") => ({
  id,
  user_id: "viewer_one",
  user_login: "viewer_demo",
  user_name: "Viewer Demo",
  user_input: "hello",
  redeemed_at: now,
  reward: { id: "reward_twitch", title: "Fictional reward" },
});
const event = (subscriptionType: string, payload: Record<string, unknown>): ModuleEvent => ({
  channelId,
  subscriptionType,
  triggerId: "event_one",
  payload,
  settings: {},
  receivedAt: now,
  eventSubTimestamp: now,
  actor: null,
  chatStatus: null,
});

describe("channel points redemption processing", () => {
  let database: TestD1Database;
  let context: ModuleExecutionContext;
  const sendChat = vi.fn();

  beforeEach(async () => {
    mocks.update.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.list.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.setEnabled.mockReset().mockResolvedValue({ ok: true, data: [] });
    sendChat.mockReset().mockResolvedValue({ sent: true, delivery: "sent", reason: null });
    database = new TestD1Database();
    database.sqlite.prepare(
      "INSERT INTO channels (channel_id,login,display_name,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run(channelId, "points_demo", "Points Demo", now, now);
    database.sqlite.prepare(
      "INSERT INTO channel_modules (channel_id,module_id,enabled,settings) VALUES (?, 'channel_points', 1, '{}')",
    ).run(channelId);
    await createChannelPointsRepository(database as unknown as D1Database)
      .insertReward(channelId, reward, "reward_local", "reward_twitch", now);
    context = {
      DB: database as unknown as D1Database,
      environment: { DB: database } as unknown as Env,
      channelId,
      sendChat,
    } as unknown as ModuleExecutionContext;
  });

  afterEach(() => { database.close(); });

  it("registers channel points EventSub types, scopes, default state, and its built-in action", () => {
    expect(MODULES).toContain(channelPointsModule);
    expect(channelPointsModule.defaultEnabled).toBe(false);
    expect(channelPointsModule.broadcasterScopes).toEqual([
      "channel:read:redemptions", "channel:manage:redemptions",
    ]);
    expect(channelPointsModule.eventSubTypes).toEqual([
      "channel.channel_points_custom_reward_redemption.add",
      "channel.channel_points_custom_reward_redemption.update",
      "channel.channel_points_custom_reward.update",
      "channel.channel_points_custom_reward.remove",
    ]);
    expect(channelPointsModule.channelPointsActions?.map(({ id }) => id)).toEqual(["chat-message"]);
  });

  it("uses the insert latch so duplicate EventSub deliveries have one effect", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("keeps a fulfilled redemption when stale EventSub and action results arrive", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "UNFULFILLED",
    }), context);
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await expect(repository.updateRedemption(channelId, "redemption_one", {
      status: "failed_to_update", pendingTwitchStatus: "CANCELED",
    }, ["running"], now)).resolves.toBe(false);
    await expect(repository.getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("accepts Twitch terminal status over a non-terminal state and records a mismatch", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.latchRedemption(channelId, {
      id: "redemption_one", rewardId: "reward_local", rewardTitle: "Fictional reward", userId: "viewer_one",
      userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
    }, now);
    await repository.updateRedemption(channelId, "redemption_one", {
      status: "failed_to_update", pendingTwitchStatus: "CANCELED",
    }, ["received"], now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "FULFILLED",
    }), context);
    const saved = await repository.getRedemption(channelId, "redemption_one");
    expect(saved).toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
    expect(saved?.outcomeReason?.en).toContain("Twitch reported fulfilled");
    expect(saved?.outcomeReason?.de).toContain("Twitch");
  });

  it("latches a cancellation that arrives before its redemption add event", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "CANCELED",
    }), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);

    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("refunds when the action provider module is disabled", async () => {
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_one"], "CANCELED", expect.any(Function),
    );
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", outcomeReason: { en: "The module providing this reward action is disabled." } });
  });

  it("leaves an ambiguous chat send pending and does not patch Twitch", async () => {
    sendChat.mockResolvedValue({ sent: false, delivery: "ambiguous", reason: "timeout" });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "pending", pendingTwitchStatus: null });
  });

  it("marks a failed status patch for retry and reconciles it without repeating the chat action", async () => {
    mocks.update.mockResolvedValueOnce({ ok: false, reason: "unknown_status" }).mockResolvedValueOnce({ ok: true, data: [] });
    mocks.list.mockResolvedValue({ ok: true, data: [{
      ...redemptionPayload(),
      user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", status: "UNFULFILLED",
    }] });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "failed_to_update", pendingTwitchStatus: "FULFILLED" });
    database.sqlite.prepare(
      "UPDATE channel_points_redemptions SET claimed_at='2026-11-10T11:57:00.000Z' WHERE channel_id=? AND redemption_id=?",
    ).run(channelId, "redemption_one");
    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("adopts a known reward update and marks a known removal without touching foreign rewards", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.update", {
      id: "reward_twitch", title: "Renamed reward", cost: 25, is_enabled: true, is_user_input_required: false,
    }), context);
    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({ title: "Renamed reward", cost: 25, prompt: null, maxPerStream: null });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", { id: "reward_twitch" }), context);
    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({ twitchState: "deleted_on_twitch" });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", { id: "foreign_reward" }), context);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM channel_points_rewards").get()).toMatchObject({ count: 1 });
  });

  it("adopts enabled nested EventSub cooldown and per-stream limits", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.update", {
      id: "reward_twitch", title: "Limited reward", cost: 25, is_enabled: true,
      global_cooldown: { is_enabled: true, seconds: 90 },
      max_per_stream: { is_enabled: true, value: 8 },
      max_per_user_per_stream: { is_enabled: true, value: 2 },
    }), context);

    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({
        title: "Limited reward", globalCooldownSeconds: 90, maxPerStream: 8, maxPerUserPerStream: 2,
      });
  });

  it("disables rewards with the module and restores their saved enabled state", async () => {
    const lifecycle = channelPointsModule.onActivationChange;
    expect(lifecycle).toBeDefined();
    const activation = {
      DB: database as unknown as D1Database,
      environment: { DB: database } as unknown as Env,
      authorizeMutation: () => ({ sql: "", values: [] }),
      actor: { userId: "operator_one" },
      now,
    };
    await lifecycle?.(activation, channelId, false);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(
      activation.environment, channelId, "reward_twitch", false, expect.any(Function),
    );
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards").get())
      .toMatchObject({ enabled: 0, restore_enabled: 1 });
    await lifecycle?.(activation, channelId, true);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(
      activation.environment, channelId, "reward_twitch", true, expect.any(Function),
    );
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards").get())
      .toMatchObject({ enabled: 1, restore_enabled: null });
  });

  it("skips deleted rewards, reports individual sync failures, and retries active rewards on the next toggle", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertReward(channelId, { ...reward, title: "Second reward" }, "reward_local_two", "reward_twitch_two", now);
    await database.prepare("UPDATE channel_points_rewards SET twitch_state='deleted_on_twitch' WHERE id=?")
      .bind("reward_local_two").run();
    await repository.insertReward(channelId, { ...reward, title: "Third reward" }, "reward_local_three", "reward_twitch_three", now);
    mocks.setEnabled.mockImplementation((_environment, _channelId, rewardId) => Promise.resolve(
      rewardId === "reward_twitch" ? { ok: false, reason: "unknown_status" } : { ok: true, data: [] },
    ));
    const lifecycle = channelPointsModule.onActivationChange;
    const activation = {
      DB: database as unknown as D1Database,
      environment: { DB: database } as unknown as Env,
      authorizeMutation: () => ({ sql: "", values: [] }),
      actor: { userId: "operator_one" },
      now,
    };

    const result = await lifecycle?.(activation, channelId, true);

    const firstAttempt = mocks.setEnabled.mock.calls.map((call) => String(call[2]));
    expect(firstAttempt).toHaveLength(2);
    expect(firstAttempt).toEqual(expect.arrayContaining(["reward_twitch", "reward_twitch_three"]));
    expect(result).toEqual({
      ok: false,
      error: "channel_points_activation_sync_failed",
      failedRewards: [{ rewardId: "reward_twitch", reason: "unknown_status" }],
    });
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards WHERE id=?")
      .get("reward_local_three")).toMatchObject({ enabled: 1, restore_enabled: null });

    mocks.setEnabled.mockReset().mockResolvedValue({ ok: true, data: [] });
    await lifecycle?.(activation, channelId, true);
    const retryAttempt = mocks.setEnabled.mock.calls.map((call) => String(call[2]));
    expect(retryAttempt).toHaveLength(2);
    expect(retryAttempt).toEqual(expect.arrayContaining(["reward_twitch", "reward_twitch_three"]));
  });
});
