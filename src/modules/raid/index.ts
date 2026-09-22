import type { BotModule } from "../contract";
import { raidSettingsSchema } from "./contracts";
import { processRaid } from "./service";

export { decideRaid } from "./domain";
export { processRaid } from "./service";
export type { RaidSettings } from "./contracts";

export const raidModule: BotModule<typeof raidSettingsSchema> = {
  id: "raid",
  settingsSchema: raidSettingsSchema,
  defaultSettings: {
    shoutoutEnabled: true,
    shoutoutThreshold: 3,
    textThreshold: 3,
    textLong: "Willkommen {channel}! Danke für den Raid mit {viewers} Zuschauern — schaut gerne vorbei!",
    textShort: "Danke für den Raid, {channel}, mit {viewers} Zuschauern!",
  },
  eventSubTypes: ["channel.raid"],
  panel: () => import("./panel"),
  handleEvent: (event) => processRaid(event),
};
