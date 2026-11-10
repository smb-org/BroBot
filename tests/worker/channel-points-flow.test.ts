import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { createChannelPointsRepository } from "../../src/modules/channel_points/repository";
import { processChannelPointsEvent, reconcileChannelPoints } from "../../src/modules/channel_points/service";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";

const mocks = vi.hoisted(() => ({ update: vi.fn(), list: vi.fn(), setEnabled: vi.fn() }));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  updateRedemptionStatus: mocks.update,
  listUnfulfilledRedemptions: mocks.list,
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
    id, user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", user_input: "",
    redeemed_at: now, reward: { id: "reward_twitch", title: "Fictional reward" },
  },
  settings: {},
  receivedAt: now,
  eventSubTimestamp: now,
  actor: null,
  chatStatus: null,
});

describe("channel points redemption flow on local D1", () => {
  const sendChat = vi.fn();
  const context = { DB: database, environment, channelId, sendChat } as unknown as ModuleExecutionContext;
  const repository = createChannelPointsRepository(database);

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
    await repository.insertReward(channelId, reward, "reward_local", "reward_twitch", now);
  });

  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.list.mockReset().mockResolvedValue({ ok: true, data: [] });
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
        id: "redemption_stale_action", user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo",
        user_input: "", redeemed_at: now, status: "FULFILLED",
        reward: { id: "reward_twitch", title: "Fictional reward" },
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
    await Promise.all([
      reconcileChannelPoints(environment, channelId, now, { force: true, context }),
      reconcileChannelPoints(environment, channelId, now, { force: true, context }),
    ]);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await expect(repository.getRedemption(channelId, "redemption_concurrent_retry"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("reclaims expired running rows but leaves rows within the lease alone", async () => {
    for (const id of ["redemption_expired_lease", "redemption_active_lease"]) {
      await repository.latchRedemption(channelId, {
        id, rewardId: "reward_local", rewardTitle: "Fictional reward", userId: "viewer_one",
        userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "", redeemedAt: now,
      }, now);
    }
    await database.prepare(
      "UPDATE channel_points_redemptions SET status='running',claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:57:00.000Z", channelId, "redemption_expired_lease").run();
    await database.prepare(
      "UPDATE channel_points_redemptions SET status='running',claimed_at=? WHERE channel_id=? AND redemption_id=?",
    ).bind("2026-11-10T11:59:00.000Z", channelId, "redemption_active_lease").run();
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
});
