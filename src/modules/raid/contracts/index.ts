import { z } from "zod";

export const raidSettingsSchema = z.object({
  mindestZuschauer: z.number().int().min(0).max(100000),
  textVoll: z.string().trim().min(1).max(200),
  textKlein: z.string().trim().min(1).max(200),
});

export type RaidSettings = z.output<typeof raidSettingsSchema>;
