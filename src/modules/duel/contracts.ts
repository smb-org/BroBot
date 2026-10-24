import { z } from "zod";
import type { ChatOutputTarget, ModuleLanguage } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { duelCatalog } from "./locale";

export const DUEL_MODULE_ID = "duel";

const commandSchema = z.string().trim().regex(/^![a-z0-9_]{2,24}$/u, "invalid_command");
const textSchema = z.string().trim().max(500);
const duelTextsObjectSchema = z.object({
  challengeOpen: textSchema,
  challengeOpenEnabled: z.boolean().optional(),
  challengeTargeted: textSchema,
  challengeTargetedEnabled: z.boolean().optional(),
  result: textSchema,
  resultEnabled: z.boolean().optional(),
  botResult: textSchema,
  botResultEnabled: z.boolean().optional(),
  fightVariants: z.array(textSchema).min(3).max(10),
  fightVariantsEnabled: z.array(z.boolean()).max(10).optional(),
  botFightVariants: z.array(textSchema).min(3).max(10),
  botFightVariantsEnabled: z.array(z.boolean()).max(10).optional(),
  errors: z.object({
    notEnoughPoints: textSchema,
    notEnoughPointsEnabled: z.boolean().optional(),
    invalidStake: textSchema,
    invalidStakeEnabled: z.boolean().optional(),
    unknownUser: textSchema,
    unknownUserEnabled: z.boolean().optional(),
    targetBusy: textSchema,
    targetBusyEnabled: z.boolean().optional(),
    alreadyChallenging: textSchema,
    alreadyChallengingEnabled: z.boolean().optional(),
    cooldown: textSchema,
    cooldownEnabled: z.boolean().optional(),
    noOpenChallenge: textSchema,
    noOpenChallengeEnabled: z.boolean().optional(),
    cannotAcceptOwn: textSchema,
    cannotAcceptOwnEnabled: z.boolean().optional(),
    stakeBounds: textSchema,
    stakeBoundsEnabled: z.boolean().optional(),
    tooManyOpen: textSchema,
    tooManyOpenEnabled: z.boolean().optional(),
  }),
});

const validateDuelMessages = (texts: z.output<typeof duelTextsObjectSchema>, context: z.RefinementCtx): void => {
  const addMissingText = (settings: object, key: string, enabledKey: string, path: (string | number)[], index?: number): void => {
    const value = (settings as Record<string, unknown>)[key];
    let text: unknown = value;
    if (index !== undefined) {
      const values = Array.isArray(value) ? value as unknown[] : null;
      text = values?.[index];
    }
    if (isMessageEnabled(settings, key, enabledKey, index) && typeof text === "string" && text.trim().length === 0) {
      context.addIssue({ code: "custom", path, message: "message_text_missing" });
    }
  };
  for (const key of ["challengeOpen", "challengeTargeted", "result", "botResult"] as const) {
    addMissingText(texts, key, `${key}Enabled`, [key]);
  }
  for (const key of ["fightVariants", "botFightVariants"] as const) {
    texts[key].forEach((_text, index) => {
      addMissingText(texts, key, `${key}Enabled`, [key, index], index);
    });
  }
  for (const key of Object.keys(texts.errors) as Array<keyof typeof texts.errors>) {
    if (!key.endsWith("Enabled")) addMissingText(texts.errors, key, `${key}Enabled`, ["errors", key]);
  }
};

export const duelTextsReadSchema = duelTextsObjectSchema;
const duelTextsSchema = duelTextsObjectSchema.superRefine(validateDuelMessages);

const duelSettingsObjectSchema = (textsSchema: z.ZodType<z.output<typeof duelTextsReadSchema>>) => z.object({
  challengeCommand: commandSchema,
  acceptCommand: commandSchema,
  defaultStake: z.number().int().min(1).max(100_000),
  minStake: z.number().int().min(1).max(100_000),
  maxStake: z.number().int().min(1).max(100_000),
  acceptWindowSeconds: z.number().int().min(15).max(300),
  cooldownSeconds: z.number().int().min(0).max(3_600),
  botAcceptsOpenDuels: z.boolean(),
  broadcasterModsMayPlay: z.boolean(),
  chatTarget: z.enum(["all_chats", "source_only", "where_asked"]).nullable(),
  texts: textsSchema,
}).superRefine((settings, context) => {
  if (settings.minStake > settings.maxStake) {
    context.addIssue({ code: "custom", path: ["maxStake"], message: "minimum_exceeds_maximum" });
  }
  if (settings.defaultStake < settings.minStake || settings.defaultStake > settings.maxStake) {
    context.addIssue({ code: "custom", path: ["defaultStake"], message: "default_outside_stake_range" });
  }
  if (settings.challengeCommand.toLocaleLowerCase("en-US") === settings.acceptCommand.toLocaleLowerCase("en-US")) {
    context.addIssue({ code: "custom", path: ["acceptCommand"], message: "commands_must_differ" });
  }
});

export const duelSettingsReadSchema = duelSettingsObjectSchema(duelTextsReadSchema);
export const duelSettingsSchema = duelSettingsObjectSchema(duelTextsSchema);

export type DuelSettings = z.output<typeof duelSettingsSchema>;
type DuelTexts = DuelSettings["texts"];
export type DuelErrorMessageKey = Exclude<keyof DuelTexts["errors"], `${string}Enabled`>;

export interface DuelRoundData {
  challengerId: string;
  challengerLogin: string;
  targetId: string | null;
  targetLogin: string | null;
  stake: number;
  botEnabled: boolean;
  acceptCommand: string;
  language: ModuleLanguage;
  chatTarget: ChatOutputTarget | null;
  sourceBroadcasterUserId: string | null;
  challengeMessageId: string;
  acceptMessageId?: string;
  fightText: string;
  botFightText: string;
  fightTextEnabled?: boolean;
  botFightTextEnabled?: boolean;
  texts: DuelTexts;
}

export const duelSettingsForLanguage = (language: ModuleLanguage): DuelSettings => ({
  challengeCommand: language === "en" ? "!duel" : "!duell",
  acceptCommand: language === "en" ? "!yes" : "!ja",
  defaultStake: 50,
  minStake: 10,
  maxStake: 1_000,
  acceptWindowSeconds: 60,
  cooldownSeconds: 30,
  botAcceptsOpenDuels: true,
  broadcasterModsMayPlay: true,
  chatTarget: null,
  texts: {
    challengeOpen: duelCatalog[language].challengeOpen,
    challengeTargeted: duelCatalog[language].challengeTargeted,
    result: duelCatalog[language].result,
    botResult: duelCatalog[language].botResult,
    fightVariants: [...duelCatalog[language].fightVariants],
    botFightVariants: [...duelCatalog[language].botFightVariants],
    errors: { ...duelCatalog[language].errors },
  },
});
