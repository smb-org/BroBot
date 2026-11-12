import { z } from "zod";

import type { BotModule } from "../contract";
import { showAlertAction } from "./actions/show-alert";
import { overlayAlertElement } from "./overlay/element";
import { overlayAlertsRoutes } from "./routes";

const settingsSchema = z.object({});

export const overlayAlertsModule: BotModule<typeof settingsSchema> = {
  id: "overlay_alerts",
  navigationCategory: "stream",
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  defaultEnabled: false,
  routes: overlayAlertsRoutes,
  channelPointsActions: [showAlertAction],
  overlayElements: [overlayAlertElement],
  alarms: [{
    key: "queue",
    retryDelaysMs: [1_000, 5_000, 30_000],
    handle: async (context) => {
      if (context.overlayAlertQueue === undefined) throw new Error("overlay_alert_queue_unavailable");
      await context.overlayAlertQueue.advance();
    },
  }],
  panelIcon: { paths: ["M4 5h16v14H4z", "M8 15l3-3 2 2 3-4 2 5"] },
  panel: () => import("./panel"),
};
