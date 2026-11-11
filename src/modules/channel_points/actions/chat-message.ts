import { z } from "zod";

import type { ChannelPointsActionDefinition } from "../../contract";

export const chatMessageConfigSchema = z.object({
  message: z.string().trim().min(1).max(500),
});

/** Sends a reward response using the channel's guarded module chat sender. */
export const chatMessageAction: ChannelPointsActionDefinition<typeof chatMessageConfigSchema> = {
  id: "chat-message",
  name: { de: "Chat-Nachricht", en: "Chat message" },
  configSchema: chatMessageConfigSchema,
  editor: () => import("../panel/chat-message-editor"),
  execute: async (context, { redemption, config, operationId }) => {
    if (context.sendChat === undefined) {
      return { refund: { de: "Der Chat-Sender ist nicht verfügbar.", en: "The chat sender is unavailable." } };
    }
    const message = config.message.replace(/\{(user|input|reward)\}/gu, (_match, name: string) => {
      if (name === "user") return redemption.userName || redemption.userLogin;
      if (name === "input") return redemption.userInput;
      return redemption.rewardTitle;
    });
    const sent = await context.sendChat(message, operationId);
    if (sent.sent) return "fulfilled";
    if (sent.delivery === "ambiguous") return "pending";
    return {
      refund: {
        de: "Die Chat-Nachricht konnte nicht gesendet werden.",
        en: "The chat message could not be sent.",
      },
    };
  },
};
