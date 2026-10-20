import type { ModuleLanguage } from "../../contract";
import { emoteSlotChatCopyForLanguage, type EmoteSlotSettings, type EmoteSlotSymbol, type EmoteSlotTextKind } from "../contracts";
import type { SlotSettlementResult } from "./settlement";

export type SlotStakeParseResult =
  | { ok: true; stake: number }
  | { ok: false; reason: "not_command" | "invalid" | "out_of_range" };

export const parseSlotStake = (text: string, settings: Pick<EmoteSlotSettings, "defaultStake" | "minStake" | "maxStake">): SlotStakeParseResult => {
  const match = /^!slot(?:\s([\s\S]*))?$/iu.exec(text.trim());
  if (match === null) return { ok: false, reason: "not_command" };
  const argument = match[1];
  if (argument === undefined || argument.trim().length === 0) return { ok: true, stake: settings.defaultStake };
  const normalized = argument.trim();
  if (!/^\d+$/u.test(normalized)) return { ok: false, reason: "invalid" };
  const stake = Number(normalized);
  if (!Number.isSafeInteger(stake)) return { ok: false, reason: "invalid" };
  if (stake < settings.minStake || stake > settings.maxStake) return { ok: false, reason: "out_of_range" };
  return { ok: true, stake };
};

const formatNumber = (value: number, language: ModuleLanguage): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(value);

const formatNet = (value: number, language: ModuleLanguage): string => value === 0
  ? "±0"
  : (value > 0 ? "+" : "−") + formatNumber(Math.abs(value), language);

const templateValues = (
  result: SlotSettlementResult,
  symbols: readonly EmoteSlotSymbol[],
  language: ModuleLanguage,
  login: string,
): Readonly<Record<string, string>> => ({
  user: login,
  "slot.symbols": result.symbols.map((index) => symbols[index]?.code ?? "?").join(" | "),
  "slot.net": formatNet(result.net, language),
  "slot.balance": formatNumber(result.balanceAfter, language),
  "slot.jackpot": formatNumber(result.jackpotAfter, language),
  "slot.payout": formatNumber(result.payout, language),
  "slot.stake": formatNumber(result.stake, language),
});

/** Replaces only original template tokens so inserted user values are never rendered again. */
export const formatSlotReply = (
  result: SlotSettlementResult,
  symbols: readonly EmoteSlotSymbol[],
  language: ModuleLanguage,
  login: string,
  kind: EmoteSlotTextKind,
  template = emoteSlotChatCopyForLanguage(language)[kind],
): string => {
  const values = templateValues(result, symbols, language, login);
  return template.replace(/\{(user|slot\.(?:symbols|net|balance|jackpot|payout|stake))\}/gu, (token, name: string) =>
    values[name] ?? token);
};

export const slotErrorReply = (
  reason: "invalid" | "out_of_range" | "insufficient_balance" | "cooldown",
  language: ModuleLanguage,
  values: { min: number; max: number; balance: number; seconds: number },
): string => {
  const copy = emoteSlotChatCopyForLanguage(language);
  if (reason === "insufficient_balance") {
    return copy.insufficient.replaceAll("{balance}", formatNumber(values.balance, language))
      .replaceAll("{min}", formatNumber(values.min, language));
  }
  if (reason === "cooldown") return copy.cooldown.replaceAll("{seconds}", formatNumber(values.seconds, language));
  return copy.invalidStake.replaceAll("{min}", formatNumber(values.min, language))
    .replaceAll("{max}", formatNumber(values.max, language));
};
