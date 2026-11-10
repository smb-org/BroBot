import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/worker/auth/broadcaster-token", () => ({
  withBroadcasterToken: async (
    _environment: Env,
    _broadcasterId: string,
    _scopes: string[],
    call: (accessToken: string) => Promise<unknown>,
    options?: { beforeCall?: () => Promise<boolean> },
  ) => {
    if (options?.beforeCall !== undefined && !await options.beforeCall()) return { kind: "precondition_failed" };
    const result = await call("token_fictional") as { ok: boolean; data?: unknown };
    return result.ok ? { kind: "ok", value: result.data } : { kind: "http_error", result };
  },
}));

import { createCustomReward, getManageableRewards, updateRedemptionStatus } from "../../src/worker/twitch/channel-points";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";

const rewardInput: ChannelPointsRewardInput = {
  title: "Fictional reward", prompt: null, cost: 10, backgroundColor: "#9147FF",
  isUserInputRequired: false, globalCooldownSeconds: null, maxPerStream: null, maxPerUserPerStream: null,
  actionModuleId: "channel_points", actionId: "chat-message", actionConfig: { message: "Hello" },
  mode: "auto", enabled: true,
};

describe("channel points Helix wrapper", () => {
  it("normalizes omitted optional reward response fields to null", async () => {
    const response = await getManageableRewards(
      { DB: {} as D1Database, TWITCH_CLIENT_ID: "client_fictional" } as Env,
      "channel_fictional",
      () => Promise.resolve(true),
      () => Promise.resolve(new Response(JSON.stringify({ data: [{
        id: "reward_fictional", title: "Fictional reward", cost: 1, is_enabled: true,
      }] }), { status: 200 })),
    );
    expect(response).toMatchObject({
      ok: true,
      data: [{
        id: "reward_fictional", prompt: null, background_color: null, global_cooldown_seconds: null,
        max_per_stream: null, max_per_user_per_stream: null, is_user_input_required: false,
        is_paused: null, is_in_stock: null, should_redemptions_skip_request_queue: null,
      }],
    });
  });

  it("rejects status updates larger than Twitch's 50-id batch limit", async () => {
    const response = await updateRedemptionStatus(
      { DB: {} as D1Database, TWITCH_CLIENT_ID: "client_fictional" } as Env,
      "channel_fictional", "reward_fictional", Array.from({ length: 51 }, (_, index) => "redemption_" + String(index)),
      "FULFILLED", () => Promise.resolve(true),
    );
    expect(response).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("maps eligibility, reward limit, and duplicate-title Helix errors to stable reasons", async () => {
    const environment = { DB: {} as D1Database, TWITCH_CLIENT_ID: "client_fictional" } as Env;
    const request = async (status: number, message: string) => await createCustomReward(
      environment, "channel_fictional", rewardInput, () => Promise.resolve(true),
      () => Promise.resolve(new Response(JSON.stringify({ message }), { status })),
    );
    await expect(request(403, "The broadcaster must be an affiliate or partner"))
      .resolves.toMatchObject({ ok: false, reason: "not_affiliate" });
    await expect(request(400, "The broadcaster has reached the limit of 50 rewards"))
      .resolves.toMatchObject({ ok: false, reason: "reward_limit" });
    await expect(request(400, "A reward with this title is already in use"))
      .resolves.toMatchObject({ ok: false, reason: "duplicate_title" });
  });
});
