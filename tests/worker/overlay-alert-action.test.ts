import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateRedemptionStatus: vi.fn() }));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  updateRedemptionStatus: mocks.updateRedemptionStatus,
  listUnfulfilledRedemptions: vi.fn(),
  listRedemptionsByIds: vi.fn(),
  getManageableRewards: vi.fn(),
  setCustomRewardEnabled: vi.fn(),
}));

import type { ModuleEvent, ModuleExecutionContext, ModuleOverlayAlertQueueItem } from "../../src/modules/contract";
import { processChannelPointsEvent } from "../../src/modules/channel_points/service";
import { showAlertAction } from "../../src/modules/overlay_alerts/actions/show-alert";
import { emptyOverlayAlertQueueState, enqueueOverlayAlert } from "../../src/modules/overlay_alerts/overlay/state";
import { createModuleActionExecutionContext } from "../../src/worker/module-action-context";
import { clearPointObjectAlarms, insertPointChannel, runMigrations } from "./points-test-helpers";

const worker = env as unknown as Env;
const redemption = {
  id: "redemption-alert-1",
  rewardId: "reward-alert-1",
  rewardTitle: "Sound request",
  userId: "viewer_fictional",
  userLogin: "viewer_demo",
  userName: "Viewer Demo",
  userInput: "hello",
  redeemedAt: "2030-01-01T12:00:00.000Z",
};

const hexSha = (id: string): string => id.replaceAll(/[^0-9a-f]/g, "").padEnd(64, "a").slice(0, 64);

const insertAsset = async (channelId: string, id: string, kind: "image" | "sound"): Promise<void> => {
  const mimeType = kind === "image" ? "image/png" : "audio/wav";
  const bytes = new Uint8Array(kind === "image" ? [137, 80, 78, 71, 13, 10, 26, 10] : [82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
  await worker.DB.prepare(
    `INSERT INTO media_assets (channel_id, id, kind, mime_type, byte_size, sha256, file_name, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(channelId, id, kind, mimeType, bytes.byteLength, hexSha(id), `${id}.bin`, bytes, redemption.redeemedAt).run();
};

beforeAll(runMigrations);
afterAll(clearPointObjectAlarms);

describe("overlay alert channel-points action", () => {
  it("validates media kinds, missing assets, and configuration bounds against local D1", async () => {
    const channelId = `alert-validation-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertAsset(channelId, "image-asset", "image");
    await insertAsset(channelId, "sound-asset", "sound");
    const context = {
      ...createModuleActionExecutionContext(worker, channelId, "overlay_alerts"),
      overlayAlertQueue: { enqueue: vi.fn().mockResolvedValue("enqueued") },
    } as unknown as ModuleExecutionContext;

    const execute = (config: {
      text: string;
      durationSeconds: number;
      volumePercent: number;
      imageAssetId?: string;
      soundAssetId?: string;
    }) => showAlertAction.execute(context, { redemption, config, operationId: redemption.id });
    const expectRefund = async (result: ReturnType<typeof execute>): Promise<void> => {
      const outcome = await result;
      if (typeof outcome !== "object" || !("refund" in outcome)) {
        throw new Error("Expected the alert action to refund the redemption.");
      }
      expect(outcome.refund.de.length).toBeGreaterThan(0);
      expect(outcome.refund.en.length).toBeGreaterThan(0);
    };

    await expect(execute({ imageAssetId: "image-asset", text: "Hello", durationSeconds: 5, volumePercent: 80 }))
      .resolves.toBe("fulfilled");
    await expectRefund(execute({ imageAssetId: "sound-asset", text: "Hello", durationSeconds: 5, volumePercent: 80 }));
    await expectRefund(execute({ soundAssetId: "image-asset", text: "Hello", durationSeconds: 5, volumePercent: 80 }));
    await expectRefund(execute({ imageAssetId: "missing-asset", text: "Hello", durationSeconds: 5, volumePercent: 80 }));
    await expectRefund(execute({ text: "Hello", durationSeconds: 1, volumePercent: 80 }));
    await expectRefund(execute({ text: "Hello", durationSeconds: 16, volumePercent: 80 }));
    await expectRefund(execute({ text: "Hello", durationSeconds: 5, volumePercent: 101 }));
    await expectRefund(execute({ text: "x".repeat(201), durationSeconds: 5, volumePercent: 80 }));
  });

  it("refunds when no connected alert element is reported by the Durable Object", async () => {
    const channelId = `alert-offline-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertAsset(channelId, "image-asset", "image");
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'overlay_alerts', 1, '{}')",
    ).bind(channelId).run();

    await expect(showAlertAction.execute(createModuleActionExecutionContext(worker, channelId, "overlay_alerts"), {
      redemption,
      config: { imageAssetId: "image-asset", text: "", durationSeconds: 5, volumePercent: 80 },
      operationId: redemption.id,
    })).resolves.toEqual({ refund: {
      de: "Overlay nicht verbunden.",
      en: "Overlay not connected.",
    } });
  });

  it("fulfills enqueued alerts and replays an operation id without adding it twice", async () => {
    const channelId = `alert-idempotency-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertAsset(channelId, "image-asset", "image");
    const queue = { state: emptyOverlayAlertQueueState(Date.parse(redemption.redeemedAt)) };
    const enqueue = vi.fn((operationId: string, alert: ModuleOverlayAlertQueueItem) => {
      const result = enqueueOverlayAlert(queue.state, { ...alert, operationId }, Date.parse(redemption.redeemedAt), true);
      queue.state = result.state;
      return Promise.resolve(result.outcome);
    });
    const context = {
      ...createModuleActionExecutionContext(worker, channelId, "overlay_alerts"),
      overlayAlertQueue: { enqueue },
    } as unknown as ModuleExecutionContext;
    const input = {
      redemption,
      config: { imageAssetId: "image-asset", text: "Hi {user}", durationSeconds: 5, volumePercent: 80 },
      operationId: "operation-stable",
    };

    await expect(showAlertAction.execute(context, input)).resolves.toBe("fulfilled");
    await expect(showAlertAction.execute(context, input)).resolves.toBe("fulfilled");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(queue.state.current?.operationId).toBe("operation-stable");
    expect(queue.state.operationIds).toEqual(["operation-stable"]);
    expect(enqueue).toHaveBeenNthCalledWith(1, "operation-stable", expect.objectContaining({
      imageUrl: "/api/overlay/media/image-asset/" + hexSha("image-asset"),
      text: "Hi Viewer Demo",
      durationSeconds: 5,
      volumePercent: 80,
    }));
  });

  it("processes an EventSub redemption against D1 and fulfills it after one connected enqueue", async () => {
    const channelId = `alert-event-${crypto.randomUUID()}`;
    const redeemedAt = new Date().toISOString();
    await insertPointChannel(channelId);
    await insertAsset(channelId, "image-asset", "image");
    await worker.DB.batch([
      worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'channel_points', 1, '{}')")
        .bind(channelId),
      worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'overlay_alerts', 1, '{}')")
        .bind(channelId),
      worker.DB.prepare(
        `INSERT INTO channel_points_rewards (
          channel_id, id, twitch_reward_id, title, prompt, cost, is_user_input_required, action_module_id,
          action_id, action_config_json, mode, enabled, twitch_state, created_at, updated_at
        ) VALUES (?, 'reward-alert', 'twitch-reward-alert', 'Sound request', 'Send a greeting', 100, 1,
          'overlay_alerts', 'show-alert', ?, 'auto', 1, 'active', ?, ?)`,
      ).bind(channelId, JSON.stringify({ imageAssetId: "image-asset", text: "{user}: {input}", durationSeconds: 5, volumePercent: 0 }), redeemedAt, redeemedAt),
    ]);

    const queue = { state: emptyOverlayAlertQueueState(Date.parse(redeemedAt)) };
    const enqueue = vi.fn((operationId: string, alert: ModuleOverlayAlertQueueItem) => {
      const result = enqueueOverlayAlert(queue.state, { ...alert, operationId }, Date.parse(redeemedAt), true);
      queue.state = result.state;
      return Promise.resolve(result.outcome);
    });
    const actionContext = {
      DB: worker.DB,
      environment: worker,
      channelId,
      overlayAlertQueue: { enqueue },
    } as unknown as ModuleExecutionContext;
    const context = {
      DB: worker.DB,
      environment: worker,
      channelId,
      forModule: () => actionContext,
    } as unknown as ModuleExecutionContext;
    const event: ModuleEvent = {
      channelId,
      subscriptionType: "channel.channel_points_custom_reward_redemption.add",
      triggerId: "eventsub-alert-redemption",
      payload: {
        id: "redemption-event-alert",
        broadcaster_user_id: channelId,
        broadcaster_user_login: channelId,
        broadcaster_user_name: channelId,
        user_id: "viewer_event_alert",
        user_login: "viewer_demo",
        user_name: "Viewer Demo",
        user_input: "Hello overlay",
        status: "unfulfilled",
        redeemed_at: redeemedAt,
        reward: { id: "twitch-reward-alert", title: "Sound request", prompt: "Send a greeting", cost: 100 },
      },
      settings: {},
      receivedAt: redeemedAt,
      eventSubTimestamp: redeemedAt,
      actor: null,
      chatStatus: null,
    };
    mocks.updateRedemptionStatus.mockReset().mockResolvedValue({ ok: true, data: [] });

    await processChannelPointsEvent(event, context);
    await processChannelPointsEvent(event, context);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(queue.state.current).toMatchObject({ operationId: "redemption-event-alert", text: "Viewer Demo: Hello overlay" });
    await expect(worker.DB.prepare(
      "SELECT status FROM channel_points_redemptions WHERE channel_id = ? AND redemption_id = ?",
    ).bind(channelId, "redemption-event-alert").first()).resolves.toMatchObject({ status: "fulfilled" });
  });
});
