import { z } from "zod";
import type { ModuleLanguage } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { heistCatalog } from "./locale";

export const HEIST_MODULE_ID = "heist";
export const HEIST_COMMAND = "!heist";
export const HEIST_COOLDOWN_KEY = "between-rounds";

const commandText = z.string().trim().max(220).refine((value) => !/[\r\n]/u.test(value), "message_must_be_one_line");

const heistSettingsFields = {
  minStake: z.number().int().min(1).max(100_000),
  maxStake: z.number().int().min(1).max(100_000),
  joinWindowSeconds: z.number().int().min(15).max(300),
  cooldownSeconds: z.number().int().min(0).max(3_600),
  baseChance: z.number().int().min(0).max(100),
  maxChance: z.number().int().min(0).max(100),
  startText: commandText,
  startTextEnabled: z.boolean().optional(),
  confirmText: commandText,
  confirmTextEnabled: z.boolean().optional(),
  resultText: commandText,
  resultTextEnabled: z.boolean().optional(),
};

const heistSettingsReadFields = {
  minStake: heistSettingsFields.minStake.default(10),
  maxStake: heistSettingsFields.maxStake.default(1_000),
  joinWindowSeconds: heistSettingsFields.joinWindowSeconds.default(60),
  cooldownSeconds: heistSettingsFields.cooldownSeconds.default(30),
  baseChance: heistSettingsFields.baseChance.default(50),
  maxChance: heistSettingsFields.maxChance.default(65),
  startText: heistSettingsFields.startText.default(""),
  startTextEnabled: heistSettingsFields.startTextEnabled.optional(),
  confirmText: heistSettingsFields.confirmText.default(""),
  confirmTextEnabled: heistSettingsFields.confirmTextEnabled.optional(),
  resultText: heistSettingsFields.resultText.default(""),
  resultTextEnabled: heistSettingsFields.resultTextEnabled.optional(),
};

const validateHeistSettings = (
  settings: z.output<z.ZodObject<typeof heistSettingsReadFields>>,
  context: z.RefinementCtx,
): void => {
  if (settings.minStake > settings.maxStake) {
    context.addIssue({ code: "custom", path: ["maxStake"], message: "minimum_exceeds_maximum" });
  }
  if (settings.maxChance < settings.baseChance) {
    context.addIssue({ code: "custom", path: ["maxChance"], message: "chance_cap_below_base" });
  }
  for (const key of ["startText", "confirmText", "resultText"] as const) {
    if (isMessageEnabled(settings, key, `${key}Enabled`) && settings[key].trim().length === 0) {
      context.addIssue({ code: "custom", path: [key], message: "message_text_missing" });
    }
  }
};

export const heistSettingsReadSchema = z.object(heistSettingsReadFields).superRefine(validateHeistSettings);
export const heistSettingsSchema = z.object(heistSettingsFields).superRefine(validateHeistSettings);

export type HeistSettings = z.output<typeof heistSettingsSchema>;

export const heistSettingsForLanguage = (language: ModuleLanguage): HeistSettings => ({
  minStake: 10,
  maxStake: 1_000,
  joinWindowSeconds: 60,
  cooldownSeconds: 30,
  baseChance: 50,
  maxChance: 65,
  startText: heistCatalog[language].startText,
  startTextEnabled: true,
  confirmText: heistCatalog[language].confirmText,
  confirmTextEnabled: true,
  resultText: heistCatalog[language].resultText,
  resultTextEnabled: true,
});

export interface HeistRoundData {
  language: ModuleLanguage;
  joinWindowSeconds: number;
  startMessageId: string;
  startText: string;
  startTextEnabled?: boolean;
  /** Absent in rounds opened before the midway line existed; such rounds send none. */
  confirmText?: string;
  confirmTextEnabled?: boolean;
  resultText: string;
  resultTextEnabled?: boolean;
  /** Pause after settlement; absent in rounds opened before the pause moved to settlement. */
  cooldownSeconds?: number;
}
