import { z } from "zod";

import type { ChatOutputTarget } from "../../contracts/values";
import { emoteSlotsCatalog } from "./locale";

export const EMOTE_SLOTS_MODULE_ID = "emote_slots";
export type EmoteSlotTextKind = "win" | "loss" | "pair" | "jackpot";

const emoteSlotSymbolSchema = z.object({
  id: z.string().trim().min(1).max(48),
  source: z.enum(["emoji", "twitch", "seven_tv"]),
  code: z.string().trim().min(1).max(64),
  twitchId: z.string().trim().min(1).max(64).optional(),
  sevenTvId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(80),
  weight: z.number().int().min(1).max(99),
  triple: z.number().int().min(2).max(500),
  isJackpot: z.boolean(),
}).superRefine((symbol, context) => {
  if (symbol.source !== "twitch" && symbol.twitchId !== undefined) {
    context.addIssue({ code: "custom", path: ["twitchId"], message: "non_twitch_symbol_has_twitch_id" });
  }
  if (symbol.source !== "seven_tv" && symbol.sevenTvId !== undefined) {
    context.addIssue({ code: "custom", path: ["sevenTvId"], message: "non_seven_tv_symbol_has_seven_tv_id" });
  }
  if (symbol.source === "seven_tv" && symbol.sevenTvId === undefined) {
    context.addIssue({ code: "custom", path: ["sevenTvId"], message: "seven_tv_symbol_requires_id" });
  }
});

const textTemplateSchema = z.string().max(500);

export const emoteSlotSettingsSchema = z.object({
  symbols: z.array(emoteSlotSymbolSchema).length(6),
  minStake: z.number().int().min(1).max(10_000),
  defaultStake: z.number().int().min(1).max(100_000),
  maxStake: z.number().int().min(1).max(100_000),
  jackpotSeed: z.number().int().min(0).max(1_000_000),
  jackpotShareBp: z.number().int().min(0).max(2_000),
  announceJackpot: z.boolean(),
  cooldownSeconds: z.number().int().min(0).max(3_600),
  chatTarget: z.enum(["all_chats", "source_only", "where_asked"]),
  texts: z.object({
    win: textTemplateSchema,
    loss: textTemplateSchema,
    pair: textTemplateSchema,
    jackpot: textTemplateSchema,
  }),
}).superRefine((settings, context) => {
  if (settings.minStake > settings.maxStake) {
    context.addIssue({ code: "custom", path: ["maxStake"], message: "minimum_exceeds_maximum" });
  }
  if (settings.defaultStake < settings.minStake || settings.defaultStake > settings.maxStake) {
    context.addIssue({ code: "custom", path: ["defaultStake"], message: "default_outside_stake_range" });
  }
  const rowIds = new Set<string>();
  const identities = new Set<string>();
  settings.symbols.forEach((symbol, index) => {
    if (rowIds.has(symbol.id)) context.addIssue({ code: "custom", path: ["symbols", index, "id"], message: "symbol_id_duplicate" });
    rowIds.add(symbol.id);
    const identity = symbol.code.toLocaleLowerCase("en-US");
    if (identities.has(identity)) context.addIssue({ code: "custom", path: ["symbols", index, "code"], message: "symbol_duplicate" });
    identities.add(identity);
  });
  if (settings.symbols.filter(({ isJackpot }) => isJackpot).length !== 1) {
    context.addIssue({ code: "custom", path: ["symbols"], message: "exactly_one_jackpot_required" });
  }
});

export type EmoteSlotSettings = z.output<typeof emoteSlotSettingsSchema>;
export type EmoteSlotSymbol = EmoteSlotSettings["symbols"][number];
export const emoteSlotChatCopyForLanguage = (language: "de" | "en"): typeof emoteSlotsCatalog.de.chat => emoteSlotsCatalog[language].chat;

const defaultSymbols = (): EmoteSlotSymbol[] => [
  { id: "cherry", source: "emoji", code: "🍒", name: "Cherry", weight: 4, triple: 7, isJackpot: false },
  { id: "lemon", source: "emoji", code: "🍋", name: "Lemon", weight: 4, triple: 7, isJackpot: false },
  { id: "bell", source: "emoji", code: "🔔", name: "Bell", weight: 3, triple: 12, isJackpot: false },
  { id: "star", source: "emoji", code: "⭐", name: "Star", weight: 2, triple: 20, isJackpot: false },
  { id: "diamond", source: "emoji", code: "💎", name: "Diamond", weight: 2, triple: 20, isJackpot: false },
  { id: "seven", source: "emoji", code: "7️⃣", name: "Seven", weight: 1, triple: 2, isJackpot: true },
];

export const DEFAULT_EMOTE_SLOT_SETTINGS: EmoteSlotSettings = {
  symbols: defaultSymbols(),
  minStake: 15,
  defaultStake: 50,
  maxStake: 500,
  jackpotSeed: 500,
  jackpotShareBp: 700,
  announceJackpot: true,
  cooldownSeconds: 30,
  chatTarget: "where_asked" satisfies ChatOutputTarget,
  texts: {
    win: emoteSlotsCatalog.en.chat.win,
    loss: emoteSlotsCatalog.en.chat.loss,
    pair: emoteSlotsCatalog.en.chat.pair,
    jackpot: emoteSlotsCatalog.en.chat.jackpot,
  },
};

export const emoteSlotDefaultSettingsForLanguage = (language: "de" | "en"): EmoteSlotSettings => {
  const symbols = defaultSymbols();
  const symbolCopy = emoteSlotsCatalog[language].symbols;
  const nameById = {
    cherry: symbolCopy.cherry,
    lemon: symbolCopy.lemon,
    bell: symbolCopy.bell,
    star: symbolCopy.star,
    diamond: symbolCopy.diamond,
    seven: symbolCopy.seven,
  };
  return {
    ...DEFAULT_EMOTE_SLOT_SETTINGS,
    symbols: symbols.map((symbol) => ({ ...symbol, name: nameById[symbol.id as keyof typeof nameById] })),
    texts: {
      win: emoteSlotsCatalog[language].chat.win,
      loss: emoteSlotsCatalog[language].chat.loss,
      pair: emoteSlotsCatalog[language].chat.pair,
      jackpot: emoteSlotsCatalog[language].chat.jackpot,
    },
  };
};
