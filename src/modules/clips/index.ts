import type { BotModule } from "../contract";
import { clipsSettingsSchema } from "./contracts";

export const clipsModule: BotModule<typeof clipsSettingsSchema> = {
  id: "clips",
  panelIcon: { paths: ["M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z", "M9 6v4", "M15 6v4", "M9 18v-4", "M15 18v-4"] },
  defaultEnabled: true,
  settingsSchema: clipsSettingsSchema,
  defaultSettings: {},
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
};
