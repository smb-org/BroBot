import { afterEach, describe, expect, it } from "vitest";

import { createChannelPointsRepository } from "../../src/modules/channel_points/repository";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "channel-points-song-provider-queue";
const NOW = "2026-11-16T12:00:00.000Z";
const databases: TestD1Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("channel-points redemption repository", () => {
  it("excludes song-provider redemptions from the generic queue regardless of module mode or activation", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    const songReward: ChannelPointsRewardInput = {
      title: "Request a song",
      prompt: null,
      cost: 10,
      backgroundColor: null,
      isUserInputRequired: true,
      globalCooldownSeconds: null,
      maxPerStream: null,
      maxPerUserPerStream: null,
      actionModuleId: "song_requests",
      actionId: "request-song",
      actionConfig: {},
      mode: "auto",
      enabled: true,
    };
    const genericReward = { ...songReward, title: "Generic reward", isUserInputRequired: false,
      actionModuleId: "channel_points", actionId: "chat-message", mode: "queue" as const };
    await repository.insertReward(CHANNEL_ID, songReward, "song_reward", "song_twitch_reward", NOW);
    await repository.insertReward(CHANNEL_ID, genericReward, "generic_reward", "generic_twitch_reward", NOW);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{\"mode\":\"moderated\"}')",
    ).bind(CHANNEL_ID).run();
    await repository.latchRedemption(CHANNEL_ID, {
      id: "generic_queued_redemption", rewardId: "generic_reward", twitchRewardId: "generic_twitch_reward",
      rewardTitle: "Generic reward", userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo",
      userInput: "hello", redeemedAt: NOW,
    }, NOW);
    await repository.updateRedemption(CHANNEL_ID, "generic_queued_redemption", {
      status: "queued", pendingTwitchStatus: null, outcomeReason: null, claimedAt: null,
    }, ["received"], NOW);

    for (const [redemptionId, enabled, mode] of [
      ["song_auto_enabled", 1, "auto"],
      ["song_moderated_enabled", 1, "moderated"],
      ["song_auto_disabled", 0, "auto"],
    ] as const) {
      await database.prepare(
        `UPDATE channel_modules SET enabled = ?, settings = ? WHERE channel_id = ? AND module_id = 'song_requests'`,
      ).bind(enabled, JSON.stringify({ mode }), CHANNEL_ID).run();
      await repository.latchRedemption(CHANNEL_ID, {
        id: redemptionId, rewardId: "song_reward", twitchRewardId: "song_twitch_reward", rewardTitle: "Request a song",
        userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "spotify:track:fixture",
        redeemedAt: NOW, providerModuleId: "song_requests", providerActionId: "request-song",
      }, NOW);
      await repository.updateRedemption(CHANNEL_ID, redemptionId, {
        status: "pending", pendingTwitchStatus: null, outcomeReason: null, claimedAt: null,
      }, ["received"], NOW);
    }

    const queue = await repository.listQueuedRedemptions(CHANNEL_ID, 100);
    expect(queue.map(({ redemption }) => redemption.redemptionId).sort((left, right) => left.localeCompare(right)))
      .toEqual(["generic_queued_redemption"]);
  });

  it("decides queue ownership by the redemption, not by the reward's current action", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    const reward: ChannelPointsRewardInput = {
      title: "Reward",
      prompt: null,
      cost: 10,
      backgroundColor: null,
      isUserInputRequired: false,
      globalCooldownSeconds: null,
      maxPerStream: null,
      maxPerUserPerStream: null,
      actionModuleId: "channel_points",
      actionId: "chat-message",
      actionConfig: {},
      mode: "queue",
      enabled: true,
    };
    await repository.insertReward(CHANNEL_ID, reward, "reward_a", "twitch_reward_a", NOW);
    await repository.insertReward(CHANNEL_ID, reward, "reward_b", "twitch_reward_b", NOW);
    const latch = async (id: string, rewardId: string, provider: { providerModuleId: string; providerActionId: string } | null) => {
      await repository.latchRedemption(CHANNEL_ID, {
        id, rewardId, twitchRewardId: "twitch_" + rewardId, rewardTitle: "Reward", userId: "viewer_one",
        userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: NOW, ...provider,
      }, NOW);
      await repository.updateRedemption(CHANNEL_ID, id, {
        status: "queued", pendingTwitchStatus: null, outcomeReason: null, claimedAt: null,
      }, ["received"], NOW);
    };
    await latch("generic_redemption", "reward_a", { providerModuleId: "channel_points", providerActionId: "chat-message" });
    await latch("song_redemption", "reward_b", { providerModuleId: "song_requests", providerActionId: "request-song" });
    await database.prepare("UPDATE channel_points_rewards SET action_module_id='song_requests', action_id='request-song' WHERE id='reward_a'").run();
    await database.prepare("UPDATE channel_points_rewards SET action_module_id='channel_points', action_id='chat-message' WHERE id='reward_b'").run();

    const queue = await repository.listQueuedRedemptions(CHANNEL_ID, 100);
    expect(queue.map(({ redemption }) => redemption.redemptionId)).toEqual(["generic_redemption"]);
  });
});
