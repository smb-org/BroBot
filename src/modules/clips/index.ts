import type { BotModule } from "../contract";
import { clipsSettingsSchema } from "./contracts";

export const clipsModule: BotModule<typeof clipsSettingsSchema> = {
  id: "clips",
  defaultEnabled: true,
  settingsSchema: clipsSettingsSchema,
  defaultSettings: {},
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
};
