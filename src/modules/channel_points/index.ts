import { z } from "zod";

import type { BotModule, ModuleActivationResult, ModuleImmediateActionCondition } from "../contract";
import { CHANNEL_POINTS_MODULE_ID, CHANNEL_POINTS_QUEUE_ACTION_NAME, CHANNEL_POINTS_QUEUE_WAITING_COUNT } from "./contracts";
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
    evaluate: (value) => {
      const response = typeof value === "object" && value !== null ? value as { count?: unknown; items?: unknown } : null;
      const items = Array.isArray(response?.items) ? response.items : null;
      const declaredCount = response?.count;
      const count = typeof declaredCount === "number" && Number.isSafeInteger(declaredCount) && declaredCount >= 0
        ? declaredCount
        : items?.length ?? 0;
      return {
        reason: null,
        visible: count > 0,
        ...(count === 0 ? {} : {
          subtitle: {
            de: CHANNEL_POINTS_QUEUE_WAITING_COUNT.de(count),
            en: CHANNEL_POINTS_QUEUE_WAITING_COUNT.en(count),
          },
        }),
      };
    },
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
