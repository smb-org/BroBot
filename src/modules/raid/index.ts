import type { BotModule } from "../contract";
import { RAID_TEMPLATE_FIELDS, raidSettingsSchema } from "./contracts";
import { DEFAULT_TEXT_LONG, DEFAULT_TEXT_SHORT } from "./contracts/chat-defaults";
import { processRaid } from "./service";

export { decideRaid, renderRaidText } from "./domain";
export { processRaid } from "./service";
export { RAID_TEMPLATE_FIELDS, RAID_VARIABLES } from "./contracts";
export type { RaidSettings } from "./contracts";

export const raidModule: BotModule<typeof raidSettingsSchema> = {
  id: "raid",
  settingsSchema: raidSettingsSchema,
  templateFields: RAID_TEMPLATE_FIELDS,
  defaultSettings: {
    shoutoutEnabled: true,
    shoutoutThreshold: 3,
    textThreshold: 3,
    textLong: DEFAULT_TEXT_LONG,
    textShort: DEFAULT_TEXT_SHORT,
  },
  eventSubTypes: ["channel.raid"],
  settingsEditor: () => import("./panel/settings-editor"),
  handleEvent: (event) => processRaid(event),
};
