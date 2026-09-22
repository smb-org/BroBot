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
    textLong: "Welcome {channel}! Thanks for the raid with {viewers} viewers — come say hi!",
    textShort: "Thanks for the raid, {channel}, with {viewers} viewers!",
  },
  eventSubTypes: ["channel.raid"],
  panel: () => import("./panel"),
  handleEvent: (event) => processRaid(event),
};
