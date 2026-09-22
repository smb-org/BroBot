import type { BotModule } from "../contract";
import { adsSettingsSchema } from "./contracts";
import { processAdBreak } from "./service";
import { adsRoutes } from "./routes";

export { decideAdBreak, decideAdPrewarning } from "./domain";
export { processAdBreak } from "./service";
export type { AdsSettings, AdBreaksEvent } from "./contracts";
export type { LastAdBreak, AdsSchedule, AdsScheduleResponse } from "./contracts";
export { ADS_OPTIONAL_BROADCASTER_SCOPES } from "./contracts";

export const adsModule: BotModule<typeof adsSettingsSchema> = {
  id: "ads",
  settingsSchema: adsSettingsSchema,
  defaultSettings: {
    automatic: "Automatische Werbepause: {duration} Sekunden. Bin gleich zurück!",
    manual: "Werbepause: {duration} Sekunden. Bin gleich zurück!",
    prewarning: true,
    leadSeconds: 60,
    prewarningText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
  },
  broadcasterScopes: ["channel:read:ads"],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  routes: adsRoutes,
  panel: () => import("./panel"),
  handleEvent: (event) => event.subscriptionType === "channel.ad_break.begin"
    ? processAdBreak(event)
    : { actions: [], diagnostics: [] },
};
