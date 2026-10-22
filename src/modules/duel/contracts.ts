import { z } from "zod";
import type { ChatOutputTarget, ModuleLanguage } from "../contract";
import { duelCatalog } from "./locale";

export const DUEL_MODULE_ID = "duel";

const commandSchema = z.string().trim().regex(/^![a-z0-9_]{2,24}$/u, "invalid_command");
const textSchema = z.string().trim().min(1).max(500);
const duelTextsSchema = z.object({
  challengeOpen: textSchema,
  challengeTargeted: textSchema,
  result: textSchema,
  botResult: textSchema,
  fightVariants: z.array(textSchema).min(3).max(10),
  botFightVariants: z.array(textSchema).min(3).max(10),
  errors: z.object({
    notEnoughPoints: textSchema,
    invalidStake: textSchema,
    unknownUser: textSchema,
    targetBusy: textSchema,
    alreadyChallenging: textSchema,
    cooldown: textSchema,
    noOpenChallenge: textSchema,
    cannotAcceptOwn: textSchema,
    stakeBounds: textSchema,
    tooManyOpen: textSchema,
  }),
});

export const duelSettingsSchema = z.object({
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
  texts: duelTextsSchema,
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

export type DuelSettings = z.output<typeof duelSettingsSchema>;
export type DuelTexts = DuelSettings["texts"];

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
  fightText: string;
  botFightText: string;
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
