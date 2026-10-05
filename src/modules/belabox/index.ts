import { z } from "zod";

import type { BotModule } from "../contract";
import { belaboxRoutes } from "./routes";

const settingsSchema = z.object({});

export const belaboxModule: BotModule<typeof settingsSchema> = {
  id: "belabox",
  navigationCategory: "data",
  panelIcon: { paths: ["M4 7h16v10H4z", "M8 11h3", "M14 11h2", "M8 14h8"] },
  mandatory: false,
  defaultEnabled: false,
  settingsSchema,
  defaultSettings: {},
  routes: belaboxRoutes,
  panel: () => import("./panel/index"),
};
