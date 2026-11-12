import { z } from "zod";

import type { BotModule, ModuleActivationResult, ModuleImmediateActionCondition } from "../contract";
import { CHANNEL_POINTS_MODULE_ID, CHANNEL_POINTS_QUEUE_ACTION_NAME } from "./contracts";
import { chatMessageAction } from "./actions/chat-message";
import {
  CHANNEL_POINTS_LIFECYCLE_ALARM,
  CHANNEL_POINTS_LIFECYCLE_HANDLER,
  channelPointsLifecycleAlarm,
  processChannelPointsEvent,
} from "./service";
import { channelPointsRoutes } from "./routes";

const settingsSchema = z.object({});

const queueAvailability: ModuleImmediateActionCondition = {
  query: {
    moduleId: CHANNEL_POINTS_MODULE_ID,
    part: "action-availability-queue",
    load: async (channelId, signal) => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/modules/${CHANNEL_POINTS_MODULE_ID}/queue`,
        { signal },
      );
      if (!response.ok) throw new Error("Channel-points queue availability could not be loaded.");
      return await response.json();
    },
    evaluate: (value) => ({
      reason: null,
      visible: typeof value === "object" && value !== null &&
        Array.isArray((value as { items?: unknown }).items) && (value as { items: unknown[] }).items.length > 0,
    }),
  },
};

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
  panel: () => import("./panel"),
  actions: [{
    id: "queue",
    name: CHANNEL_POINTS_QUEUE_ACTION_NAME,
    icon: "queue",
    conditions: ["moduleEnabled", queueAvailability],
    requiredRole: "operator",
    hideUntilAvailable: true,
    content: { presentation: "dialog", hideSubmit: true, dismissAsClose: true, load: () => import("./panel/queue-action-content") },
    execute: () => Promise.resolve(),
  }],
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
