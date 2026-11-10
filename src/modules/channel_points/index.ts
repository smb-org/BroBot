import { z } from "zod";

import type { BotModule } from "../contract";
import { CHANNEL_POINTS_MODULE_ID } from "./contracts";
import { chatMessageAction } from "./actions/chat-message";
import { processChannelPointsEvent } from "./service";
import { channelPointsRoutes } from "./routes";

const settingsSchema = z.object({});

export const channelPointsModule: BotModule<typeof settingsSchema> = {
  id: CHANNEL_POINTS_MODULE_ID,
  navigationCategory: "twitch",
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  defaultEnabled: false,
  broadcasterScopes: ["channel:read:redemptions", "channel:manage:redemptions"],
  eventSubTypes: [
    "channel.channel_points_custom_reward_redemption.add",
    "channel.channel_points_custom_reward_redemption.update",
    "channel.channel_points_custom_reward.update",
    "channel.channel_points_custom_reward.remove",
  ],
  pauseSafeEventSubTypes: [
    "channel.channel_points_custom_reward_redemption.add",
    "channel.channel_points_custom_reward_redemption.update",
    "channel.channel_points_custom_reward.update",
    "channel.channel_points_custom_reward.remove",
  ],
  handleEvent: processChannelPointsEvent,
  routes: channelPointsRoutes,
  panelIcon: { paths: ["M5 5h14v14H5z", "M9 12h6", "M12 9v6"] },
  channelPointsActions: [chatMessageAction],
  onActivationChange: async (activation, channelId, enabled) => {
    const authorizationForMutation = async (): Promise<boolean> => {
      const mutation = activation.authorizeMutation(channelId, activation.actor, new Date().toISOString());
      return await activation.DB.prepare(
        "SELECT channel_id FROM channels WHERE channel_id = ? " + mutation.sql,
      ).bind(channelId, ...mutation.values).first<{ channel_id: string }>() !== null;
    };
    if (!enabled) {
      await activation.DB.prepare(
        "UPDATE channel_points_rewards SET restore_enabled = COALESCE(restore_enabled, enabled), enabled = 0, updated_at = ? WHERE channel_id = ?",
      ).bind(activation.now, channelId).run();
    }
    const rows = await activation.DB.prepare(
      "SELECT id, twitch_reward_id, enabled, restore_enabled FROM channel_points_rewards WHERE channel_id = ?",
    ).bind(channelId).all<{ id: string; twitch_reward_id: string; enabled: number; restore_enabled: number | null }>();
    const { setCustomRewardEnabled } = await import("../../worker/twitch/channel-points");
    for (const row of rows.results) {
      const desired = enabled ? (row.restore_enabled ?? row.enabled) === 1 : false;
      if (!await authorizationForMutation()) throw new Error("Channel points activation authorization changed.");
      const result = await setCustomRewardEnabled(
        activation.environment, channelId, row.twitch_reward_id, desired, authorizationForMutation,
      );
      if (!result.ok) throw new Error("Could not synchronize a channel points reward: " + result.reason);
      if (enabled) {
        await activation.DB.prepare(
          "UPDATE channel_points_rewards SET enabled = ?, restore_enabled = NULL, updated_at = ? WHERE channel_id = ? AND id = ?",
        ).bind(Number(desired), activation.now, channelId, row.id).run();
      }
    }
  },
};
