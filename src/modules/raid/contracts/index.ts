import { z } from "zod";

export const raidSettingsSchema = z.object({
  shoutoutEnabled: z.boolean().default(true),
  shoutoutThreshold: z.number().int().min(0).max(100000).default(3),
  textThreshold: z.number().int().min(0).max(100000).default(3),
  textLong: z.string().trim().min(1).max(200),
  textShort: z.string().trim().min(1).max(200),
});

export type RaidSettings = z.output<typeof raidSettingsSchema>;
