import type { BotModule } from "../contract";
import { raidSettingsSchema } from "./contracts";
import { DEFAULT_TEXT_LONG, DEFAULT_TEXT_SHORT } from "./contracts/chat-defaults";
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
    textLong: DEFAULT_TEXT_LONG,
    textShort: DEFAULT_TEXT_SHORT,
  },
  eventSubTypes: ["channel.raid"],
  panel: () => import("./panel"),
  handleEvent: (event) => processRaid(event),
};
