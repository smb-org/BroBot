export type { KanalereignisDiagnose, KanalereignisDetail } from "./contracts";
export { diagnostiziereKanalereignis } from "./domain";

import { z } from "zod";

import type { EventSubSubscriptionType } from "../../contracts/values";
import type { BotModule } from "../contract";
import { verarbeiteKanalereignis } from "./service";

const settingsSchema = z.object({});
const eventSubTypes = [
  "channel.raid",
  "channel.shoutout.create",
  "channel.shoutout.receive",
  "channel.chat.notification",
  "channel.moderate",
  "automod.message.hold",
  "channel.suspicious_user.message",
  "channel.suspicious_user.update",
] as const satisfies readonly EventSubSubscriptionType[];

export const kanalereignisseModul: BotModule<typeof settingsSchema> = {
  id: "channel_events",
  settingsSchema,
  defaultSettings: {},
  eventSubTypes,
  handleEvent: (event) => verarbeiteKanalereignis(event),
};
