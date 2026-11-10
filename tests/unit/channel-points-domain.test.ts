import { describe, expect, it } from "vitest";

import { channelPointsRewardInputSchema } from "../../src/modules/channel_points/contracts";
import {
  channelPointsActionTransition,
  redemptionFromEventSub,
  rewardSnapshotFromEventSub,
} from "../../src/modules/channel_points/domain/redemption";

const rewardInput = {
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
  actionConfig: { message: "Hello {user}" },
  mode: "auto",
  enabled: true,
};

describe("channel points domain", () => {
  it("accepts Twitch custom reward bounds and rejects titles over 45 characters", () => {
    expect(channelPointsRewardInputSchema.safeParse(rewardInput).success).toBe(true);
    expect(channelPointsRewardInputSchema.safeParse({ ...rewardInput, title: "x".repeat(46) }).success).toBe(false);
    expect(channelPointsRewardInputSchema.safeParse({ ...rewardInput, prompt: "x".repeat(201) }).success).toBe(false);
    expect(channelPointsRewardInputSchema.safeParse({ ...rewardInput, cost: 0 }).success).toBe(false);
    expect(channelPointsRewardInputSchema.safeParse({ ...rewardInput, globalCooldownSeconds: 604_801 }).success).toBe(false);
  });

  it("parses redemption identity and user input from EventSub", () => {
    expect(redemptionFromEventSub({
      id: "redemption_fictional",
      user_id: "viewer_fictional",
      user_login: "viewer_demo",
      user_name: "Viewer Demo",
      user_input: "hello",
      redeemed_at: "2026-11-10T10:00:00.000Z",
      reward: { id: "reward_fictional", title: "Fictional reward" },
    })).toEqual({
      id: "redemption_fictional",
      rewardId: "reward_fictional",
      rewardTitle: "Fictional reward",
      userId: "viewer_fictional",
      userLogin: "viewer_demo",
      userName: "Viewer Demo",
      userInput: "hello",
      redeemedAt: "2026-11-10T10:00:00.000Z",
    });
  });

  it("adopts Twitch reward fields while treating omitted optional values as null", () => {
    expect(rewardSnapshotFromEventSub({
      id: "reward_fictional",
      title: "Fictional reward",
      cost: 25,
      is_enabled: true,
      is_user_input_required: false,
    })).toMatchObject({
      twitchRewardId: "reward_fictional",
      title: "Fictional reward",
      prompt: null,
      backgroundColor: null,
      globalCooldownSeconds: null,
      maxPerStream: null,
      maxPerUserPerStream: null,
    });
  });

  it("keeps queue and pending outcomes open and remembers a requested refund status", () => {
    expect(channelPointsActionTransition("queue", "fulfilled")).toEqual({ status: "queued" });
    expect(channelPointsActionTransition("auto", "pending")).toEqual({ status: "pending" });
    expect(channelPointsActionTransition("auto", "fulfilled")).toMatchObject({
      status: "running",
      pendingTwitchStatus: "FULFILLED",
    });
    expect(channelPointsActionTransition("auto", { refund: { de: "Fehlgeschlagen", en: "Failed" } })).toMatchObject({
      status: "running",
      pendingTwitchStatus: "CANCELED",
      outcomeReason: { de: "Fehlgeschlagen", en: "Failed" },
    });
  });
});
