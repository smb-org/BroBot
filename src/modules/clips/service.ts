import { chatStatusMeetsMinimumTier, type ModuleEvent, type ModuleResult } from "../contract";
import type { ClipsSettings } from "./contracts";

const messageText = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text: unknown = Reflect.get(message, "text");
  return typeof text === "string" ? text : null;
};

export const processClipsChatMessage = (
  event: ModuleEvent<ClipsSettings>,
): ModuleResult => {
  if (event.subscriptionType !== "channel.chat.message" || messageText(event)?.trim().toLowerCase() !== "!clip") {
    return { actions: [], diagnostics: [] };
  }

  if (!chatStatusMeetsMinimumTier(event.chatStatus, event.settings.commandMinimumRole)) {
    return {
      actions: [],
      diagnostics: [{
        code: "text_commands.permission_denied",
        detail: {
          name: "clip",
          requiredTier: event.settings.commandMinimumRole === "viewer" ? "everyone" : event.settings.commandMinimumRole,
          currentTier: event.chatStatus,
        },
      }],
    };
  }

  return {
    actions: [{
      kind: "clip",
      cooldownSeconds: event.settings.commandCooldownSeconds,
      postClipLinkInChat: event.settings.postClipLinkInChat,
      chatLinkTemplate: event.settings.chatLinkTemplate,
    }],
    diagnostics: [],
  };
};
