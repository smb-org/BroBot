import type { BotModule } from "../contract";
import { werbungSettingsSchema } from "./contracts";
import { verarbeiteWerbepause } from "./service";
import { werbungRoutes } from "./routes";

export { entscheideWerbepause, entscheideWerbevorwarnung } from "./domain";
export { verarbeiteWerbepause } from "./service";
export type { WerbungSettings, WerbepausenEreignis } from "./contracts";
export type { LetzteWerbepause, WerbungZeitplan, WerbungZeitplanAntwort } from "./contracts";
export { WERBUNG_OPTIONALE_BROADCASTER_SCOPES } from "./contracts";

export const werbungModul: BotModule<typeof werbungSettingsSchema> = {
  id: "ads",
  settingsSchema: werbungSettingsSchema,
  defaultSettings: {
    automatic: "Automatische Werbepause: {duration} Sekunden. Bin gleich zurück!",
    manual: "Werbepause: {duration} Sekunden. Bin gleich zurück!",
    prewarning: true,
    leadSeconds: 60,
    prewarningText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
  },
  broadcasterScopes: ["channel:read:ads"],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  routes: werbungRoutes,
  panel: () => import("./panel"),
  handleEvent: (event) => event.subscriptionType === "channel.ad_break.begin"
    ? verarbeiteWerbepause(event)
    : { actions: [], diagnostics: [] },
};
