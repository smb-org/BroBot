export type { ChannelEventDiagnostic, ChannelEventDetail } from "./contracts";
export { diagnoseChannelEvent } from "./domain";

import { z } from "zod";

import type { EventSubSubscriptionType } from "../../contracts/values";
import type { BotModule } from "../contract";
import { processChannelEvent } from "./service";

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
  "stream.online",
  "stream.offline",
] as const satisfies readonly EventSubSubscriptionType[];

export const channelEventsModule: BotModule<typeof settingsSchema> = {
  id: "channel_events",
  navigationCategory: "twitch",
  panelIcon: { paths: ["M5 12h3l2-5 4 10 2-5h3", "M5 19h14"] },
  mandatory: true,
  settingsSchema,
  defaultSettings: {},
  eventSubTypes,
  handleEvent: (event) => processChannelEvent(event),
};
