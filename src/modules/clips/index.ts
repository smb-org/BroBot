import type { BotModule } from "../contract";
import { CLIPS_TEMPLATE_VARIABLES, clipsSettingsSchema } from "./contracts";
import { clipsImmediateActionTexts } from "./action-locale";
import { CLIPS_CHAT_COMMANDS } from "./contracts/chat-commands";
import { processClipsChatMessage } from "./service";
import { dryRunClipsChatMessage } from "./dry-run";

export const clipsModule: BotModule<typeof clipsSettingsSchema> = {
  id: "clips",
  navigationCategory: "twitch",
  panelIcon: { paths: ["M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z", "M9 6v4", "M15 6v4", "M9 18v-4", "M15 18v-4"] },
  chatCommands: CLIPS_CHAT_COMMANDS,
  templateVariableGroup: {
    label: { de: "Clips", en: "Clips" },
    icon: { paths: ["M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z", "M9 6v4", "M15 6v4", "M9 18v-4", "M15 18v-4"] },
  },
  defaultEnabled: true,
  settingsSchema: clipsSettingsSchema,
  defaultSettings: clipsSettingsSchema.parse({}),
  templateFields: { chatLinkTemplate: CLIPS_TEMPLATE_VARIABLES },
  eventSubTypes: ["channel.chat.message"],
  handleEvent: processClipsChatMessage,
  dryRunChatMessage: dryRunClipsChatMessage,
  panel: () => import("./panel"),
  panelManagesSettings: true,
  actions: [{
    id: "create-clip",
    name: clipsImmediateActionTexts.name,
    icon: "clip",
    conditions: ["streamLive"],
    requiredRole: "operator",
    errorMessage: clipsImmediateActionTexts.error,
    execute: async ({ channelId }) => {
      const result = await (await import("./panel/service")).createClip(channelId);
      return {
        message: clipsImmediateActionTexts.created,
        ...(result.editUrl === null ? {} : { link: { href: result.editUrl, label: clipsImmediateActionTexts.open } }),
      };
    },
  }],
};
