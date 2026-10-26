import { z } from "zod";
import type { ChatOutputTarget, ModuleLanguage } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { bossFightCatalog } from "./locale";

export const BOSS_FIGHT_MODULE_ID = "boss_fight";
export const BOSS_FIGHT_COMMAND = "!attack";
export const BOSS_FIGHT_BASE_HP = 300;
export const BOSS_FIGHT_HP_PER_ATTACKER = 80;

const textSchema = z.string().trim().max(500);
const settingsObjectSchema = z.object({
  durationSeconds: z.number().int().min(15).max(300).default(90),
  attackCooldownSeconds: z.number().int().min(1).max(300).default(10),
  damageMinimum: z.number().int().min(1).max(1_000).default(20),
  damageMaximum: z.number().int().min(1).max(1_000).default(40),
  lootPool: z.number().int().min(1).max(100_000).default(1_000),
  chatTarget: z.enum(["all_chats", "source_only", "where_asked"]).nullable().default(null),
  startText: textSchema.default(""),
  startTextEnabled: z.boolean().optional(),
  defeatedText: textSchema.default(""),
  defeatedTextEnabled: z.boolean().optional(),
  timeoutText: textSchema.default(""),
  timeoutTextEnabled: z.boolean().optional(),
});

const validateBossFightSettings = (settings: z.output<typeof settingsObjectSchema>, context: z.RefinementCtx): void => {
  if (settings.damageMinimum > settings.damageMaximum) {
    context.addIssue({ code: "custom", path: ["damageMaximum"], message: "minimum_exceeds_maximum" });
  }
  for (const key of ["startText", "defeatedText", "timeoutText"] as const) {
    if (isMessageEnabled(settings, key, `${key}Enabled`) && settings[key].trim().length === 0) {
      context.addIssue({ code: "custom", path: [key], message: "message_text_missing" });
    }
  }
};

export const bossFightSettingsReadSchema = settingsObjectSchema;
export const bossFightSettingsSchema = settingsObjectSchema.superRefine(validateBossFightSettings);

export type BossFightSettings = z.output<typeof bossFightSettingsSchema>;

export interface BossFightRoundData {
  durationSeconds: number;
  baseHp: number;
  hpPerAttacker: number;
  damageMinimum: number;
  damageMaximum: number;
  attackCooldownSeconds: number;
  lootPool: number;
  language: ModuleLanguage;
  chatTarget: ChatOutputTarget | null;
  startText: string;
  startTextEnabled?: boolean;
  defeatedText: string;
  defeatedTextEnabled?: boolean;
  timeoutText: string;
  timeoutTextEnabled?: boolean;
  attackerCount: number;
  damageDealt: number;
  maxHp: number;
  currentHp: number;
  defeated: boolean;
}

export const bossFightDefaultsForLanguage = (language: ModuleLanguage): BossFightSettings => ({
  durationSeconds: 90,
  attackCooldownSeconds: 10,
  damageMinimum: 20,
  damageMaximum: 40,
  lootPool: 1_000,
  chatTarget: null,
  startText: bossFightCatalog[language].startLine,
  startTextEnabled: true,
  defeatedText: bossFightCatalog[language].defeatedText,
  defeatedTextEnabled: true,
  timeoutText: bossFightCatalog[language].timeoutLine,
  timeoutTextEnabled: true,
});
