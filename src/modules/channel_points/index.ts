import { z } from "zod";

import type { BotModule, ModuleActivationResult } from "../contract";
import { CHANNEL_POINTS_MODULE_ID } from "./contracts";
import { chatMessageAction } from "./actions/chat-message";
import {
  CHANNEL_POINTS_LIFECYCLE_ALARM,
  CHANNEL_POINTS_LIFECYCLE_HANDLER,
  channelPointsLifecycleAlarm,
  processChannelPointsEvent,
} from "./service";
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
  serializeLifecycleMutations: true,
  alarms: [channelPointsLifecycleAlarm],
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
  onActivationChange: async (activation) => {
    const result: unknown = await activation.runModuleAlarm(
      CHANNEL_POINTS_LIFECYCLE_HANDLER,
      CHANNEL_POINTS_LIFECYCLE_ALARM,
      { kind: "activation", actor: activation.actor },
    );
    return result === undefined ? undefined : result as ModuleActivationResult;
  },
};
