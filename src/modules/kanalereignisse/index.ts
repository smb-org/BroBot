export type { KanalereignisDiagnose, KanalereignisDetail } from "./contracts";
export { diagnostiziereKanalereignis } from "./domain";

import { z } from "zod";

import type { BotModule } from "../contract";
import { verarbeiteKanalereignis } from "./service";

const settingsSchema = z.object({});

export const kanalereignisseModul: BotModule<typeof settingsSchema> = {
  id: "kanalereignisse",
  settingsSchema,
  defaultSettings: {},
  eventSubTypes: [
    "channel.raid",
    "channel.shoutout.create",
    "channel.shoutout.receive",
    "channel.chat.notification",
    "channel.moderate",
    "automod.message.hold",
    "channel.suspicious_user.message",
    "channel.suspicious_user.update",
  ],
  handleEvent: (event) => verarbeiteKanalereignis(event),
};
