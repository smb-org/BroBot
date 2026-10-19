import { z } from "zod";

export const POINTS_MODULE_ID = "points";

export const pointsSettingsSchema = z.object({
  currencyName: z.string().trim().min(1).max(24),
  startBonus: z.number().int().min(0).max(1_000_000),
  activityAmount: z.number().int().min(0).max(1_000_000),
  windowMinutes: z.number().int().min(1).max(1_440),
  dailyCap: z.number().int().min(0).max(10_000_000),
});

export type PointsSettings = z.output<typeof pointsSettingsSchema>;

export const DEFAULT_POINTS_SETTINGS: PointsSettings = {
  currencyName: "Punkte",
  startBonus: 100,
  activityAmount: 5,
  windowMinutes: 10,
  dailyCap: 150,
};

export const pointsDefaultSettingsForLanguage = (language: "de" | "en"): PointsSettings => ({
  ...DEFAULT_POINTS_SETTINGS,
  currencyName: language === "de" ? "Punkte" : "Points",
});
