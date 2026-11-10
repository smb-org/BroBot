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

import {
  createCustomReward,
  deleteCustomReward,
  getManageableRewards,
  listRedemptionsByIds,
  listUnfulfilledRedemptions,
  setCustomRewardEnabled,
  updateCustomReward,
  updateRedemptionStatus,
} from "../../src/worker/twitch/channel-points";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";

const rewardInput: ChannelPointsRewardInput = {
  title: "Fictional reward", prompt: null, cost: 10, backgroundColor: "#9147FF",
  isUserInputRequired: false, globalCooldownSeconds: 30, maxPerStream: 5, maxPerUserPerStream: 2,
  actionModuleId: "channel_points", actionId: "chat-message", actionConfig: { message: "Hello" },
  mode: "auto", enabled: true,
};
const environment = { DB: {} as D1Database, TWITCH_CLIENT_ID: "client_fictional" } as Env;
const responseReward = (overrides: Record<string, unknown> = {}) => ({
  id: "reward_fictional", title: "Fictional reward", prompt: "", cost: 10, is_enabled: true,
  background_color: "#9147FF", is_user_input_required: false,
  global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 30 },
  max_per_stream_setting: { is_enabled: true, max_per_stream: 5 },
  max_per_user_per_stream_setting: { is_enabled: true, max_per_user_per_stream: 2 },
  should_redemptions_skip_request_queue: false,
  ...overrides,
});
const captureRequests = (bodies: readonly unknown[], statuses: readonly number[] = []) => {
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const index = calls.length;
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestBody = init?.body;
    calls.push({
      url: new URL(requestUrl),
      method: init?.method ?? "GET",
      body: typeof requestBody === "string" ? JSON.parse(requestBody) as unknown : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(bodies[index] ?? { data: [] }), { status: statuses[index] ?? 200 }));
  };
  return { calls, fetcher };
};
const expectRequest = (
  calls: ReturnType<typeof captureRequests>["calls"],
  index: number,
  method: string,
  query: readonly (readonly [string, string])[],
  body: unknown,
): void => {
  const call = calls[index];
  if (call === undefined) throw new Error("Expected a captured Helix request.");
  expect(call.method).toBe(method);
  expect(call.url.pathname).toBe("/helix/channel_points/custom_rewards" +
    (query.some(([key]) => key === "reward_id") ? "/redemptions" : ""));
  expect([...call.url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))).toEqual(
    [...query].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)),
  );
  expect(call.body).toEqual(body);
};

describe("channel points Helix wrapper", () => {
  it("gets manageable rewards and decodes enabled nested limits from a realistic response", async () => {
    const capture = captureRequests([{ data: [responseReward()] }]);
    const response = await getManageableRewards(environment, "channel_fictional", () => Promise.resolve(true), capture.fetcher);
    expectRequest(capture.calls, 0, "GET", [
      ["broadcaster_id", "channel_fictional"], ["only_manageable_rewards", "true"],
    ], undefined);
    expect(response).toMatchObject({
      ok: true,
      data: [{
        id: "reward_fictional", prompt: "", background_color: "#9147FF", is_user_input_required: false,
        is_global_cooldown_enabled: true, global_cooldown_seconds: 30,
        is_max_per_stream_enabled: true, max_per_stream: 5,
        is_max_per_user_per_stream_enabled: true, max_per_user_per_stream: 2,
        is_paused: null, is_in_stock: null,
      }],
    });
  });

  it("normalizes omitted optional Helix reward fields without losing enabled nested limits", async () => {
    const capture = captureRequests([{ data: [responseReward({
      prompt: undefined, background_color: undefined, is_user_input_required: undefined,
      is_paused: undefined, is_in_stock: undefined, should_redemptions_skip_request_queue: undefined,
    })] }]);
    const response = await getManageableRewards(environment, "channel_fictional", () => Promise.resolve(true), capture.fetcher);
    expectRequest(capture.calls, 0, "GET", [
      ["broadcaster_id", "channel_fictional"], ["only_manageable_rewards", "true"],
    ], undefined);
    expect(response).toMatchObject({
      ok: true,
      data: [{
        prompt: null, background_color: null, is_user_input_required: false,
        global_cooldown_seconds: 30, max_per_stream: 5, max_per_user_per_stream: 2,
        is_paused: null, is_in_stock: null, should_redemptions_skip_request_queue: null,
      }],
    });
  });

  it("creates a reward with broadcaster_id in the query and Twitch fields in the JSON body", async () => {
    const capture = captureRequests([{ data: [responseReward()] }]);
    const result = await createCustomReward(environment, "channel_fictional", rewardInput, () => Promise.resolve(true), capture.fetcher);
    expectRequest(capture.calls, 0, "POST", [["broadcaster_id", "channel_fictional"]], {
      title: "Fictional reward", prompt: "", cost: 10, background_color: "#9147FF",
      is_enabled: true, is_user_input_required: false, should_redemptions_skip_request_queue: false,
      is_global_cooldown_enabled: true, is_max_per_stream_enabled: true,
      is_max_per_user_per_stream_enabled: true, global_cooldown_seconds: 30,
      max_per_stream: 5, max_per_user_per_stream: 2,
    });
    expect(result).toMatchObject({ ok: true, data: [{ global_cooldown_seconds: 30, max_per_stream: 5 }] });
  });

  it("updates a reward with PATCH query identifiers and a JSON reward body", async () => {
    const capture = captureRequests([{ data: [responseReward({ title: "Updated reward" })] }]);
    const result = await updateCustomReward(
      environment, "channel_fictional", "reward_fictional", { ...rewardInput, title: "Updated reward" },
      () => Promise.resolve(true), capture.fetcher,
    );
    expectRequest(capture.calls, 0, "PATCH", [
      ["broadcaster_id", "channel_fictional"], ["id", "reward_fictional"],
    ], {
      title: "Updated reward", prompt: "", cost: 10, background_color: "#9147FF",
      is_enabled: true, is_user_input_required: false, should_redemptions_skip_request_queue: false,
      is_global_cooldown_enabled: true, is_max_per_stream_enabled: true,
      is_max_per_user_per_stream_enabled: true, global_cooldown_seconds: 30,
      max_per_stream: 5, max_per_user_per_stream: 2,
    });
    expect(result).toMatchObject({ ok: true, data: [{ title: "Updated reward" }] });
  });

  it("activates a reward with an enable-only PATCH that preserves its configured limits", async () => {
    const capture = captureRequests([{ data: [responseReward({ is_enabled: false })] }]);
    const result = await setCustomRewardEnabled(
      environment, "channel_fictional", "reward_fictional", false, () => Promise.resolve(true), capture.fetcher,
    );
    expect(capture.calls).toHaveLength(1);
    expectRequest(capture.calls, 0, "PATCH", [
      ["broadcaster_id", "channel_fictional"], ["id", "reward_fictional"],
    ], { is_enabled: false });
    expect(result).toMatchObject({ ok: true, data: [{ is_enabled: false, global_cooldown_seconds: 30 }] });
  });

  it("deletes a reward with the broadcaster and reward identifiers in the query", async () => {
    const capture = captureRequests([{ data: [] }]);
    const result = await deleteCustomReward(
      environment, "channel_fictional", "reward_fictional", () => Promise.resolve(true), capture.fetcher,
    );
    expectRequest(capture.calls, 0, "DELETE", [
      ["broadcaster_id", "channel_fictional"], ["id", "reward_fictional"],
    ], undefined);
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("updates redemption status with repeatable IDs in the query and status in the body", async () => {
    const capture = captureRequests([{ data: [] }]);
    const result = await updateRedemptionStatus(
      environment, "channel_fictional", "reward_fictional", ["redemption_one", "redemption_two"],
      "FULFILLED", () => Promise.resolve(true), capture.fetcher,
    );
    expectRequest(capture.calls, 0, "PATCH", [
      ["id", "redemption_one"], ["id", "redemption_two"],
      ["broadcaster_id", "channel_fictional"], ["reward_id", "reward_fictional"],
    ], { status: "FULFILLED" });
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("uses after to fetch the next page of unfulfilled redemptions", async () => {
    const redemption = (id: string) => ({
      id, user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", user_input: "",
      redeemed_at: "2026-11-10T12:00:00.000Z", status: "UNFULFILLED",
      reward: { id: "reward_fictional", title: "Fictional reward" },
    });
    const capture = captureRequests([
      { data: [redemption("redemption_one")], pagination: { cursor: "cursor_next" } },
      { data: [redemption("redemption_two")], pagination: {} },
    ]);
    const result = await listUnfulfilledRedemptions(
      environment, "channel_fictional", "reward_fictional", () => Promise.resolve(true), capture.fetcher,
    );
    expectRequest(capture.calls, 0, "GET", [
      ["broadcaster_id", "channel_fictional"], ["reward_id", "reward_fictional"],
      ["status", "UNFULFILLED"], ["first", "50"],
    ], undefined);
    expectRequest(capture.calls, 1, "GET", [
      ["broadcaster_id", "channel_fictional"], ["reward_id", "reward_fictional"],
      ["status", "UNFULFILLED"], ["first", "50"], ["after", "cursor_next"],
    ], undefined);
    expect(result).toMatchObject({ ok: true, data: [{ id: "redemption_one" }, { id: "redemption_two" }] });
  });

  it("rejects status updates larger than Twitch's 50-id batch limit without making a request", async () => {
    const capture = captureRequests([]);
    const response = await updateRedemptionStatus(
      environment, "channel_fictional", "reward_fictional",
      Array.from({ length: 51 }, (_, index) => "redemption_" + String(index)),
      "FULFILLED", () => Promise.resolve(true), capture.fetcher,
    );
    expect(response).toEqual({ ok: false, reason: "invalid_input" });
    expect(capture.calls).toHaveLength(0);
  });

  it("gets authoritative redemption statuses by batches of IDs", async () => {
    const capture = captureRequests([{ data: [{
      id: "redemption_fictional", user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo",
      user_input: "", redeemed_at: "2026-11-10T12:00:00.000Z", status: "CANCELED",
      reward: { id: "reward_fictional", title: "Fictional reward" },
    }] }]);
    const result = await listRedemptionsByIds(
      environment, "channel_fictional", ["redemption_fictional"], () => Promise.resolve(true), capture.fetcher,
    );
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.method).toBe("GET");
    expect(capture.calls[0]?.url.pathname).toBe("/helix/channel_points/custom_rewards/redemptions");
    const call = capture.calls.at(0);
    if (call === undefined) throw new Error("Expected one redemption status request.");
    expect([...call.url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))).toEqual([
      ["broadcaster_id", "channel_fictional"], ["id", "redemption_fictional"],
    ]);
    expect(result).toMatchObject({ ok: true, data: [{ id: "redemption_fictional", status: "CANCELED" }] });
  });

  it("maps eligibility, reward limit, and duplicate-title errors while keeping create request shape", async () => {
    const request = async (status: number, message: string) => {
      const capture = captureRequests([{ message }], [status]);
      const result = await createCustomReward(
        environment, "channel_fictional", rewardInput, () => Promise.resolve(true), capture.fetcher,
      );
      expectRequest(capture.calls, 0, "POST", [["broadcaster_id", "channel_fictional"]], {
        title: "Fictional reward", prompt: "", cost: 10, background_color: "#9147FF",
        is_enabled: true, is_user_input_required: false, should_redemptions_skip_request_queue: false,
        is_global_cooldown_enabled: true, is_max_per_stream_enabled: true,
        is_max_per_user_per_stream_enabled: true, global_cooldown_seconds: 30,
        max_per_stream: 5, max_per_user_per_stream: 2,
      });
      return result;
    };
    await expect(request(403, "The broadcaster must be an affiliate or partner"))
      .resolves.toMatchObject({ ok: false, reason: "not_affiliate" });
    await expect(request(400, "The broadcaster has reached the limit of 50 rewards"))
      .resolves.toMatchObject({ ok: false, reason: "reward_limit" });
    await expect(request(400, "A reward with this title is already in use"))
      .resolves.toMatchObject({ ok: false, reason: "duplicate_title" });
  });
});
