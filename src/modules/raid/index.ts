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
    shoutoutAktiv: true,
    shoutoutSchwelle: 3,
    textSchwelle: 3,
    textVoll: "Willkommen {channel}! Danke für den Raid mit {viewers} Zuschauern — schaut gerne vorbei!",
    textKlein: "Danke für den Raid, {channel}, mit {viewers} Zuschauern!",
  },
  eventSubTypes: ["channel.raid"],
  panel: () => import("./panel"),
  handleEvent: (event) => verarbeiteRaid(event),
};
