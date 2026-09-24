import { z } from "zod";
import type { TemplateFields, TemplateVariable } from "../contract";

export const raidSettingsSchema = z.object({
  shoutoutEnabled: z.boolean().default(true),
  shoutoutThreshold: z.number().int().min(0).max(100000).default(3),
  textThreshold: z.number().int().min(0).max(100000).default(3),
  textLong: z.string().trim().min(1).max(500),
  textShort: z.string().trim().min(1).max(500),
});

export type RaidSettings = z.output<typeof raidSettingsSchema>;

export const RAID_VARIABLES = {
  channel: { name: "channel", group: "event", sample: "samplechannel", maxLength: 25 },
  viewers: { name: "viewers", group: "event", sample: "42", maxLength: 7 },
} as const satisfies Record<string, TemplateVariable>;

export const RAID_TEMPLATE_FIELDS = {
  textLong: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
  textShort: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
} as const satisfies TemplateFields<RaidSettings>;
