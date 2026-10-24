import { z } from "zod";
import type { TemplateFields, TemplateVariable } from "../contract";
import { raidTemplateVariableCatalog } from "./template-variable-catalog";
import { templateTextLength } from "../../../contracts/template-text-length";
import { isMessageEnabled } from "../../../contracts/message-enabled";

const raidSettingsObjectSchema = z.object({
  shoutoutEnabled: z.boolean().default(true),
  shoutoutThreshold: z.number().int().min(0).max(100000).default(3),
  textThreshold: z.number().int().min(0).max(100000).default(3),
  textLong: z.string().trim().refine((text) => templateTextLength(text) <= 500),
  textLongEnabled: z.boolean().optional(),
  textShort: z.string().trim().refine((text) => templateTextLength(text) <= 500),
  textShortEnabled: z.boolean().optional(),
  textLongTarget: z.enum(["all_chats", "source_only", "channel_default"]).default("channel_default"),
  textShortTarget: z.enum(["all_chats", "source_only", "channel_default"]).default("channel_default"),
});

const validateRaidMessages = (settings: z.output<typeof raidSettingsObjectSchema>, context: z.RefinementCtx): void => {
  for (const [messageKey, enabledKey] of [["textLong", "textLongEnabled"], ["textShort", "textShortEnabled"]] as const) {
    if (isMessageEnabled(settings, messageKey, enabledKey) && settings[messageKey].trim().length === 0) {
      context.addIssue({ code: "custom", path: [messageKey], message: "message_text_missing" });
    }
  }
};

export const raidSettingsReadSchema = raidSettingsObjectSchema;
export const raidSettingsSchema = raidSettingsObjectSchema.superRefine(validateRaidMessages);

export type RaidSettings = Omit<z.output<typeof raidSettingsSchema>, "textLongTarget" | "textShortTarget"> & {
  textLongTarget?: "all_chats" | "source_only" | "channel_default";
  textShortTarget?: "all_chats" | "source_only" | "channel_default";
};

const RAID_VARIABLES = {
  channel: { name: "channel", group: "event", sample: "samplechannel", maxLength: 25, picker: { de: raidTemplateVariableCatalog.de.channel, en: raidTemplateVariableCatalog.en.channel } },
  viewers: { name: "viewers", group: "event", sample: "42", maxLength: 7, picker: { de: raidTemplateVariableCatalog.de.viewers, en: raidTemplateVariableCatalog.en.viewers } },
} as const satisfies Record<string, TemplateVariable>;

export const RAID_TEMPLATE_FIELDS = {
  textLong: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
  textShort: [RAID_VARIABLES.channel, RAID_VARIABLES.viewers],
} as const satisfies TemplateFields<RaidSettings>;
