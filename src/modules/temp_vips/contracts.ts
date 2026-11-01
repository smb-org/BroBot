import { z } from "zod";

export const TEMP_VIPS_MODULE_ID = "temp_vips";

export const tempVipsSettingsSchema = z.object({
  defaultDurationDays: z.number().int().min(1).max(90),
  maximumDurationDays: z.number().int().min(1).max(90),
  announceExpiry: z.boolean(),
});

export type TempVipsSettings = z.output<typeof tempVipsSettingsSchema>;

export const DEFAULT_TEMP_VIPS_SETTINGS: TempVipsSettings = {
  defaultDurationDays: 7,
  maximumDurationDays: 90,
  announceExpiry: false,
};
