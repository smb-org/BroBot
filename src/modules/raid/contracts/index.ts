import { z } from "zod";
import type { TemplateFields, TemplateVariable } from "../contract";
import { raidTemplateVariableCatalog } from "./template-variable-catalog";

export const raidSettingsSchema = z.object({
  shoutoutEnabled: z.boolean().default(true),
  shoutoutThreshold: z.number().int().min(0).max(100000).default(3),
  textThreshold: z.number().int().min(0).max(100000).default(3),
  textLong: z.string().trim().min(1).max(500),
  textShort: z.string().trim().min(1).max(500),
  textLongTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
  textShortTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
});

export type RaidSettings = Omit<z.output<typeof raidSettingsSchema>, "textLongTarget" | "textShortTarget"> & {
  textLongTarget?: "all_chats" | "source_only";
  textShortTarget?: "all_chats" | "source_only";
};

export const RAID_VARIABLES = {
  channel: { name: "channel", group: "event", sample: "samplechannel", maxLength: 25, picker: { de: raidTemplateVariableCatalog.de.channel, en: raidTemplateVariableCatalog.en.channel } },
  viewers: { name: "viewers", group: "event", sample: "42", maxLength: 7, picker: { de: raidTemplateVariableCatalog.de.viewers, en: raidTemplateVariableCatalog.en.viewers } },
} as const satisfies Record<string, TemplateVariable>;

export const RAID_TEMPLATE_FIELDS = {
  textLong: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
  textShort: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
} as const satisfies TemplateFields<RaidSettings>;
