import type { BotModule } from "../contract";
import { raidSettingsSchema } from "./contracts";
import { verarbeiteRaid } from "./service";

export { entscheideRaid } from "./domain";
export { verarbeiteRaid } from "./service";
export type { RaidSettings } from "./contracts";

export const raidModul: BotModule<typeof raidSettingsSchema> = {
  id: "raid",
  settingsSchema: raidSettingsSchema,
  defaultSettings: {
    mindestZuschauer: 3,
    textVoll: "Willkommen {kanal}! Danke für den Raid mit {zuschauer} Zuschauern — schaut gerne vorbei!",
    textKlein: "Danke für den Raid, {kanal}, mit {zuschauer} Zuschauern!",
  },
  eventSubTypes: ["channel.raid"],
  panel: () => import("./panel"),
  handleEvent: (event) => verarbeiteRaid(event),
};
