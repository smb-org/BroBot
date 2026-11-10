import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { createChannelPointsRepository } from "../../src/modules/channel_points/repository";
import {
  CHANNEL_POINTS_LIFECYCLE_ALARM,
  CHANNEL_POINTS_LIFECYCLE_HANDLER,
  processChannelPointsEvent,
  reconcileChannelPoints,
} from "../../src/modules/channel_points/service";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";

const mocks = vi.hoisted(() => ({
  update: vi.fn(), list: vi.fn(), listByIds: vi.fn(), manageable: vi.fn(), setEnabled: vi.fn(),
}));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  updateRedemptionStatus: mocks.update,
  listUnfulfilledRedemptions: mocks.list,
  listRedemptionsByIds: mocks.listByIds,
  getManageableRewards: mocks.manageable,
  setCustomRewardEnabled: mocks.setEnabled,
}));

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const migrationStatements = (source: string): string[] => {
  const segments = source.split(/\r?\n/u).map((line) => line.replace(/^\s*--.*$/u, "")).join("\n").split(";");
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const segment of segments) {
    const statement = segment.trim();
    if (statement.length === 0) continue;
    if (trigger !== null) {
      if (statement.toUpperCase() === "END") {
        statements.push(`${trigger.join(";")};${statement}`);
        trigger = null;
      } else trigger.push(statement);
    } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) trigger = [statement];
    else statements.push(statement);
  }
  return statements;
};

const environment = env as unknown as Env;
const database = environment.DB;
const channelId = "channel_points_worker";
const now = "2026-11-10T12:00:00.000Z";
const reward: ChannelPointsRewardInput = {
  title: "Fictional reward",
  prompt: null,
  cost: 10,
  backgroundColor: null,
  isUserInputRequired: false,
  globalCooldownSeconds: null,
  maxPerStream: null,
  maxPerUserPerStream: null,
  actionModuleId: "channel_points",
  actionId: "chat-message",
  actionConfig: { message: "Hi {user}" },
  mode: "auto",
  enabled: true,
};
const redemptionEvent = (id: string): ModuleEvent => ({
  channelId,
  subscriptionType: "channel.channel_points_custom_reward_redemption.add",
  triggerId: `event_${id}`,
  payload: {
    id, broadcaster_user_id: channelId, broadcaster_user_login: channelId, broadcaster_user_name: channelId,
    user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", user_input: "",
    status: "unfulfilled", redeemed_at: now,
    reward: {
      id: "reward_twitch", title: "Fictional reward", prompt: "Say hello", cost: 10,
      is_user_input_required: false,
    },
  },
  settings: {},
  receivedAt: now,
  eventSubTimestamp: now,
  actor: null,
  chatStatus: null,
});
const helixRedemption = (
  id: string,
  status: "UNFULFILLED" | "FULFILLED" | "CANCELED",
  rewardId = "reward_twitch",
  rewardTitle = "Fictional reward",
) => ({
  id, broadcaster_id: channelId, broadcaster_login: channelId, broadcaster_name: channelId,
  user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", user_input: "",
  redeemed_at: now, status,
  reward: { id: rewardId, title: rewardTitle, prompt: "Say hello", cost: 10 },
});

describe("channel points redemption flow on local D1", () => {
  const sendChat = vi.fn();
  const context = { DB: database, environment, channelId, sendChat } as unknown as ModuleExecutionContext;
  const repository = createChannelPointsRepository(database);
  const manageableReward = {
    id: "reward_twitch", title: "Fictional reward", prompt: null, cost: 10, is_enabled: true,
    background_color: null, is_user_input_required: false, global_cooldown_seconds: null,
    max_per_stream: null, max_per_user_per_stream: null, is_paused: null, is_in_stock: null,
    should_redemptions_skip_request_queue: false,
  };

  beforeAll(async () => {
    for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
      for (const statement of migrationStatements(migrationSources[path] ?? "")) {
        await database.prepare(statement).run();
      }
    }
    await database.prepare(
      "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(channelId, channelId, channelId, now, now).run();
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'channel_points', 1, '{}')",
    ).bind(channelId).run();
    await database.prepare(
      "INSERT INTO channel_members (channel_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).bind(channelId, channelId, "broadcaster", now, now).run();
    await repository.insertReward(channelId, reward, "reward_local", "reward_twitch", now);
  });

  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.list.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.listByIds.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.manageable.mockReset().mockResolvedValue({ ok: true, data: [manageableReward] });
    sendChat.mockReset().mockResolvedValue({ sent: true, delivery: "sent", reason: null });
  });

  it("runs the action once for a duplicate redemption event and fulfills it", async () => {
    await processChannelPointsEvent(redemptionEvent("redemption_duplicate"), context);
    await processChannelPointsEvent(redemptionEvent("redemption_duplicate"), context);
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(sendChat.mock.calls[0]?.[1]).toBe("redemption_duplicate");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[4]).toBe("FULFILLED");
    await expect(repository.getRedemption(channelId, "redemption_duplicate"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("keeps a Twitch terminal event when an older action PATCH finishes afterward", async () => {
    let finishPatch: (result: { ok: false; reason: "unknown_status" }) => void = () => {};
    mocks.update.mockImplementationOnce(() => new Promise<{ ok: false; reason: "unknown_status" }>((resolve) => {
      finishPatch = resolve;
    }));
    const processing = processChannelPointsEvent(redemptionEvent("redemption_stale_action"), context);
    await vi.waitFor(() => { expect(mocks.update).toHaveBeenCalledTimes(1); });
    await processChannelPointsEvent({
      ...redemptionEvent("redemption_stale_action"),
      subscriptionType: "channel.channel_points_custom_reward_redemption.update",
      payload: {
        id: "redemption_stale_action", broadcaster_user_id: channelId, broadcaster_user_login: channelId,
        broadcaster_user_name: channelId, user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo",
        user_input: "", redeemed_at: now, status: "fulfilled",
        reward: {
          id: "reward_twitch", title: "Fictional reward", prompt: "Say hello", cost: 10,
          is_user_input_required: false,
        },
      },
    }, context);
    finishPatch({ ok: false, reason: "unknown_status" });
    await processing;
    await expect(repository.getRedemption(channelId, "redemption_stale_action"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("runs a pending redemption action once across concurrent reconciles", async () => {
    sendChat.mockResolvedValueOnce({ sent: false, delivery: "ambiguous", reason: "timeout" });
    await processChannelPointsEvent(redemptionEvent("redemption_concurrent_retry"), context);
    await database.prepare(
      "UPDATE channel_points_redemptions SET claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:57:00.000Z", channelId, "redemption_concurrent_retry").run();
    sendChat.mockResolvedValue({ sent: true, delivery: "sent", reason: null });
    mocks.listByIds.mockResolvedValue({ ok: true, data: [helixRedemption("redemption_concurrent_retry", "UNFULFILLED")] });
    await Promise.all([
      reconcileChannelPoints(environment, channelId, now, { force: true, context }),
      reconcileChannelPoints(environment, channelId, now, { force: true, context }),
    ]);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await expect(repository.getRedemption(channelId, "redemption_concurrent_retry"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("does not retry an action after a failed lookup when the unfulfilled scan is empty", async () => {
    sendChat.mockResolvedValueOnce({ sent: false, delivery: "ambiguous", reason: "timeout" });
    await processChannelPointsEvent(redemptionEvent("redemption_failed_lookup"), context);
    await database.prepare(
      "UPDATE channel_points_redemptions SET claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:57:00.000Z", channelId, "redemption_failed_lookup").run();
    mocks.listByIds.mockResolvedValue({ ok: false, reason: "network" });
    mocks.list.mockResolvedValue({ ok: true, data: [] });

    await reconcileChannelPoints(environment, channelId, now, { force: true, context });

    expect(sendChat).toHaveBeenCalledTimes(1);
    await expect(repository.getRedemption(channelId, "redemption_failed_lookup"))
      .resolves.toMatchObject({ status: "pending", pendingTwitchStatus: null });
  });

  it("looks up open redemptions separately for each Twitch reward", async () => {
    // Earlier tests leave retryable rows behind; this test counts lookups, so start from none.
    await database.prepare("DELETE FROM channel_points_redemptions WHERE channel_id=?").bind(channelId).run();
    await repository.insertReward(channelId, { ...reward, title: "Second reward" }, "reward_local_two", "reward_twitch_two", now);
    await repository.latchRedemption(channelId, {
      id: "redemption_group_one", rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: "Fictional reward",
      userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "", redeemedAt: now,
    }, now);
    await repository.latchRedemption(channelId, {
      id: "redemption_group_two", rewardId: "reward_local_two", twitchRewardId: "reward_twitch_two", rewardTitle: "Second reward",
      userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "", redeemedAt: now,
    }, now);
    mocks.manageable.mockResolvedValue({ ok: true, data: [manageableReward, {
      ...manageableReward, id: "reward_twitch_two", title: "Second reward",
    }] });
    mocks.listByIds.mockImplementation((_environment, _channel, rewardId, redemptionIds) => {
      const id = (redemptionIds as string[])[0] ?? "";
      return Promise.resolve({ ok: true, data: [helixRedemption(id, "CANCELED", String(rewardId))] });
    });

    await reconcileChannelPoints(environment, channelId, now, { force: true, context });

    expect(mocks.listByIds).toHaveBeenCalledTimes(2);
    expect(mocks.listByIds).toHaveBeenCalledWith(
      environment, channelId, "reward_twitch", ["redemption_group_one"], expect.any(Function),
    );
    expect(mocks.listByIds).toHaveBeenCalledWith(
      environment, channelId, "reward_twitch_two", ["redemption_group_two"], expect.any(Function),
    );
    await database.prepare("DELETE FROM channel_points_redemptions WHERE channel_id=? AND redemption_id IN (?,?)")
      .bind(channelId, "redemption_group_one", "redemption_group_two").run();
    await database.prepare("DELETE FROM channel_points_rewards WHERE channel_id=? AND id=?")
      .bind(channelId, "reward_local_two").run();
  });

  it("reclaims expired running rows but leaves rows within the lease alone", async () => {
    for (const id of ["redemption_expired_lease", "redemption_active_lease"]) {
      await repository.latchRedemption(channelId, {
        id, rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: "Fictional reward", userId: "viewer_one",
        userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "", redeemedAt: now,
      }, now);
    }
    await database.prepare(
      "UPDATE channel_points_redemptions SET status='running',claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:57:00.000Z", channelId, "redemption_expired_lease").run();
    await database.prepare(
      "UPDATE channel_points_redemptions SET status='running',claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:59:00.000Z", channelId, "redemption_active_lease").run();
    mocks.listByIds.mockResolvedValue({ ok: true, data: [helixRedemption("redemption_expired_lease", "UNFULFILLED")] });
    await reconcileChannelPoints(environment, channelId, now, { force: true, context });
    expect(sendChat).toHaveBeenCalledTimes(1);
    await expect(repository.getRedemption(channelId, "redemption_expired_lease"))
      .resolves.toMatchObject({ status: "fulfilled" });
    await expect(repository.getRedemption(channelId, "redemption_active_lease"))
      .resolves.toMatchObject({ status: "running" });
  });

  it("cancels the redemption on Twitch and stores refunded when the action refunds", async () => {
    sendChat.mockResolvedValue({ sent: false, delivery: "rejected", reason: "blocked" });
    await processChannelPointsEvent(redemptionEvent("redemption_refund"), context);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_refund"], "CANCELED", expect.any(Function),
    );
    await expect(repository.getRedemption(channelId, "redemption_refund"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("serializes activation PATCHes through the real channel Durable Object lane", async () => {
    const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
    await database.prepare(
      "UPDATE channel_modules SET enabled=0 WHERE channel_id=? AND module_id='channel_points'",
    ).bind(channelId).run();
    await database.prepare(
      "UPDATE channel_points_rewards SET enabled=1,restore_enabled=NULL WHERE channel_id=?",
    ).bind(channelId).run();
    let twitchEnabled = true;
    // The delay timer must be created inside the Durable Object's own I/O context; resolving it from the test is cross-object I/O.
    mocks.setEnabled.mockImplementationOnce(() => new Promise<{ ok: true; data: [] }>((resolve) => {
      setTimeout(() => { twitchEnabled = false; resolve({ ok: true, data: [] }); }, 100);
    })).mockImplementation((_environment, _channel, _reward, enabled) => {
      twitchEnabled = enabled as boolean;
      return Promise.resolve({ ok: true, data: [] });
    });
    const invocation = { kind: "activation", actor: { userId: channelId } };
    const disable = object.runModuleAlarm(
      "channel_points", CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, invocation,
    );
    await vi.waitFor(() => { expect(mocks.setEnabled).toHaveBeenCalledTimes(1); }, { timeout: 10_000 });
    await database.prepare(
      "UPDATE channel_modules SET enabled=1 WHERE channel_id=? AND module_id='channel_points'",
    ).bind(channelId).run();
    const enable = object.runModuleAlarm(
      "channel_points", CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, invocation,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
    await Promise.all([Promise.resolve(disable), Promise.resolve(enable)]);

    expect(mocks.setEnabled.mock.calls.map((call) => call[3] as boolean)).toEqual([false, true]);
    expect(twitchEnabled).toBe(true);
    await expect(database.prepare(
      "SELECT enabled,restore_enabled FROM channel_points_rewards WHERE channel_id=? AND id='reward_local'",
    ).bind(channelId).first()).resolves.toMatchObject({ enabled: 1, restore_enabled: null });
  });
});
