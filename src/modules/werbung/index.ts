import type { BotModule } from "../contract";
import { werbungSettingsSchema } from "./contracts";
import { verarbeiteWerbepause } from "./service";

export { entscheideWerbepause, entscheideWerbevorwarnung } from "./domain";
export { verarbeiteWerbepause } from "./service";
export type { WerbungSettings, WerbepausenEreignis } from "./contracts";

export const werbungModul: BotModule<typeof werbungSettingsSchema> = {
  id: "werbung",
  settingsSchema: werbungSettingsSchema,
  defaultSettings: {
    automatisch: "Automatische Werbepause: {dauer} Sekunden. Bin gleich zurück!",
    manuell: "Werbepause: {dauer} Sekunden. Bin gleich zurück!",
    vorwarnung: true,
    vorlaufSekunden: 60,
    vorwarnungText: "Werbung in {sekunden} Sekunden. Bin gleich zurück!",
  },
  broadcasterScopes: ["channel:read:ads"],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  panel: () => import("./panel"),
  handleEvent: (event) => event.subscriptionType === "channel.ad_break.begin"
    ? verarbeiteWerbepause(event)
    : { actions: [], diagnostics: [] },
};
