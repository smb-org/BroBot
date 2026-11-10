import { z } from "zod";

import type { BotModule } from "../contract";
import { overlayAlertsRoutes } from "./routes";

const settingsSchema = z.object({});

export const overlayAlertsModule: BotModule<typeof settingsSchema> = {
  id: "overlay_alerts",
  navigationCategory: "stream",
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  defaultEnabled: false,
  routes: overlayAlertsRoutes,
  panelIcon: { paths: ["M4 5h16v14H4z", "M8 15l3-3 2 2 3-4 2 5"] },
  panel: () => import("./panel"),
};
