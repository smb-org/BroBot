import type { BotModule } from "../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS, TEMP_VIPS_MODULE_ID, tempVipsSettingsSchema } from "./contracts";

export const tempVipsModule: BotModule<typeof tempVipsSettingsSchema> = {
  id: TEMP_VIPS_MODULE_ID,
  navigationCategory: "twitch",
  defaultEnabled: false,
  broadcasterScopes: ["channel:manage:vips"],
  eventSubTypes: ["channel.vip.remove"],
  pauseSafeEventSubTypes: ["channel.vip.remove"],
  settingsSchema: tempVipsSettingsSchema,
  defaultSettings: DEFAULT_TEMP_VIPS_SETTINGS,
  settingsEditor: () => import("./panel/settings-editor"),
  panelIcon: { paths: ["M2 7l5 5 5-8 5 8 5-5-2 13H4z", "M5 16h14"] },
};
