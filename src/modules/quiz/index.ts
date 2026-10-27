import { z } from "zod";

import type { BotModule } from "../contract";
import { quizRoutes } from "./routes";
import { quizStarterSetStatements } from "./seed";

const settingsSchema = z.object({});

export const quizModule: BotModule<typeof settingsSchema> = {
  id: "quiz",
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"] },
  settingsSchema,
  defaultSettings: {},
  routes: quizRoutes,
  panel: () => import("./panel"),
  onEnable: async ({ DB, authorizeMutation, prepareModuleAudit, actor, now }, channelId) => {
    const language = (await DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ language: "de" | "en" }>())?.language ?? "de";
    return quizStarterSetStatements(DB, channelId, language, now,
      authorizeMutation(channelId, actor, now), prepareModuleAudit);
  },
};
