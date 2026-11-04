import { z } from "zod";

import type { BotModule } from "../contract";
import { POLLS_MODULE_ID } from "./contracts";
import { pollsRoutes } from "./routes";
import { processPollsEvent } from "./service";

const pollsSettingsSchema = z.object({});

export const pollsModule: BotModule<typeof pollsSettingsSchema> = {
  id: POLLS_MODULE_ID,
  navigationCategory: "twitch",
  settingsSchema: pollsSettingsSchema,
  defaultSettings: pollsSettingsSchema.parse({}),
  broadcasterScopes: ["channel:manage:polls", "channel:manage:predictions"],
  eventSubTypes: [
    "channel.poll.begin",
    "channel.poll.progress",
    "channel.poll.end",
    "channel.prediction.begin",
    "channel.prediction.progress",
    "channel.prediction.lock",
    "channel.prediction.end",
  ],
  pauseSafeEventSubTypes: [
    "channel.poll.begin",
    "channel.poll.progress",
    "channel.poll.end",
    "channel.prediction.begin",
    "channel.prediction.progress",
    "channel.prediction.lock",
    "channel.prediction.end",
  ],
  handleEvent: processPollsEvent,
  routes: pollsRoutes,
  defaultEnabled: false,
  panelIcon: { paths: ["M4 6h10", "M4 12h16", "M4 18h7"] },
};
