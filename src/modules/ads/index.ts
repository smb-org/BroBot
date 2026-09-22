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
    automatic: "Automatic ad break: {duration} seconds. Be right back!",
    manual: "Ad break: {duration} seconds. Be right back!",
    prewarning: true,
    leadSeconds: 60,
    prewarningText: "Ads in {seconds} seconds. Be right back!",
  },
  broadcasterScopes: ["channel:read:ads"],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  routes: adsRoutes,
  panel: () => import("./panel"),
  handleEvent: (event) => event.subscriptionType === "channel.ad_break.begin"
    ? processAdBreak(event)
    : { actions: [], diagnostics: [] },
};
