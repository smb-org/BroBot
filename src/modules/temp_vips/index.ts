import type { BotModule } from "../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS, TEMP_VIPS_MODULE_ID, tempVipsSettingsSchema } from "./contracts";
import { TEMP_VIPS_CHAT_COMMANDS } from "./contracts/chat-commands";
import { processTempVipsChatMessage } from "./service";
import { dryRunTempVipsChatMessage } from "./dry-run";

export const tempVipsModule: BotModule<typeof tempVipsSettingsSchema> = {
  id: TEMP_VIPS_MODULE_ID,
  navigationCategory: "twitch",
  defaultEnabled: false,
  broadcasterScopes: ["channel:manage:vips"],
  chatCommands: TEMP_VIPS_CHAT_COMMANDS,
  eventSubTypes: ["channel.vip.remove", "channel.chat.message"],
  pauseSafeEventSubTypes: ["channel.vip.remove"],
  settingsSchema: tempVipsSettingsSchema,
  defaultSettings: DEFAULT_TEMP_VIPS_SETTINGS,
  handleEvent: processTempVipsChatMessage,
  dryRunChatMessage: dryRunTempVipsChatMessage,
  settingsEditor: () => import("./panel/settings-editor"),
  panelIcon: { paths: ["M2 7l5 5 5-8 5 8 5-5-2 13H4z", "M5 16h14"] },
};
