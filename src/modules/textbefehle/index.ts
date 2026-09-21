export type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlArt,
  TextbefehlMindeststufe,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "./contracts";
export { TEXTBEFEHL_MINDESTSTUFEN } from "./contracts";
export type { TextbefehlRepository } from "./repository";

import { z } from "zod";

import type { BotModule } from "../contract";
import { createTextbefehlRepository, initialisiereListenbefehl } from "./adapters/d1";
import { textbefehlRoutes } from "./routes";
import { verarbeiteTextbefehlNachricht } from "./service";

const settingsSchema = z.object({});

export const textbefehlModul: BotModule<typeof settingsSchema> = {
  id: "textbefehle",
  settingsSchema,
  defaultSettings: {},
  eventSubTypes: ["channel.chat.message"],
  onEnable: (context, channelId) => initialisiereListenbefehl(
    context.DB,
    channelId,
    context.actor,
    context.now,
    context.authorizeMutation,
    context.prepareModuleAudit,
  ),
  routes: textbefehlRoutes,
  panel: () => import("./panel"),
  handleEvent: (event, context) => verarbeiteTextbefehlNachricht(
    event,
    createTextbefehlRepository(context.DB, context.authorizeMutation),
  ),
};
