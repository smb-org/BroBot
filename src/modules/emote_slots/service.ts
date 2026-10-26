import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage, ModuleResult } from "../contract";
import type { EmoteSlotSettings } from "./contracts";
import { formatSlotReply, parseSlotStake, slotErrorReply } from "./domain/chat";
import { drawSlotSymbols } from "./domain/random";
import { slotSettlementTable, type SlotSettlementResult } from "./domain/settlement";
import { isSevenTvSymbolMissing } from "./domain/seven-tv";
import { fetchSevenTvEmotes } from "./seven-tv";
import { EMOTE_SLOT_OVERLAY_ELEMENT_KIND } from "./overlay/kinds";
import { isMessageEnabled } from "../../contracts/message-enabled";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const messageText = (event: ModuleEvent): string | null => {
  const message = record(event.payload.message);
  return typeof message?.text === "string" ? message.text.trim() : null;
};

const asErrorCode = (error: unknown): string => error instanceof Error ? error.message : "unknown";

const sendThrottledError = async (
  context: ModuleExecutionContext,
  event: ModuleEvent<EmoteSlotSettings>,
  accountId: string,
  messageId: string,
  reason: "invalid" | "out_of_range" | "insufficient_balance" | "cooldown",
  language: ModuleLanguage,
  balance: number,
): Promise<ModuleResult> => {
  if (!await context.points.claimCooldown(`error:${accountId}`, 60)) return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "chat",
      text: slotErrorReply(reason, language, {
        min: event.settings.minStake,
        max: event.settings.maxStake,
        balance,
        seconds: event.settings.cooldownSeconds,
      }),
      target: event.settings.chatTarget,
      replyToMessageId: messageId,
      automated: false,
    }],
    diagnostics: [],
  };
};

export const processEmoteSlotMessage = async (
  event: ModuleEvent<EmoteSlotSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const userId = event.payload.chatter_user_id;
  const login = event.payload.chatter_user_login;
  const messageId = event.payload.message_id;
  const text = messageText(event);
  if (typeof userId !== "string" || typeof login !== "string" || typeof messageId !== "string" || text === null) {
    return { actions: [], diagnostics: [] };
  }
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterUserId = event.payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterUserId === "string" && sourceBroadcasterUserId !== event.channelId) return { actions: [], diagnostics: [] };
  const parsed = parseSlotStake(text, event.settings);
  if (!parsed.ok && parsed.reason === "not_command") return { actions: [], diagnostics: [] };
  const language = await context.channelLanguage();
  const accountId = userId;
  if (!parsed.ok) {
    return sendThrottledError(context, event, accountId, messageId,
      parsed.reason === "out_of_range" ? "out_of_range" : "invalid", language, await context.points.balance(accountId));
  }

  const symbols = drawSlotSymbols(event.settings);
  const payloadIdentity = { kind: "slot", moduleId: "emote_slots", accountId, stake: parsed.stake };
  let settled;
  try {
    settled = await context.points.settle(
      `msg:${messageId}`,
      "slot",
      { accountId, login },
      parsed.stake,
      {
        stake: parsed.stake,
        symbols,
        table: slotSettlementTable(event.settings),
        jackpotShareBp: event.settings.jackpotShareBp,
        pairPayoutBp: event.settings.pairPayoutBp,
        maxStake: event.settings.maxStake,
        seed: event.settings.jackpotSeed,
      },
      {
        payloadIdentity,
        ...(event.settings.cooldownSeconds === 0 ? {} : {
          cooldown: { key: `spin:${accountId}`, seconds: event.settings.cooldownSeconds },
        }),
      },
    );
  } catch (error: unknown) {
    const code = asErrorCode(error);
    if (code === "insufficient_balance" || code === "cooldown") {
      const balance = await context.points.balance(accountId);
      return sendThrottledError(context, event, accountId, messageId,
        code, language, balance);
    }
    return { actions: [], diagnostics: [] };
  }
  if (settled.replayed) return { actions: [], diagnostics: [] };
  const result = settled.result as SlotSettlementResult;
  const jackpotRow = event.settings.symbols.findIndex(({ isJackpot }) => isJackpot);
  const isJackpot = result.symbols.every((index) => index === jackpotRow);
  const textKind = isJackpot ? "jackpot" : result.pair ? "pair" : result.net > 0 ? "win" : "loss";
  const reply = formatSlotReply(result, event.settings.symbols, language, login, textKind,
    event.settings.texts[textKind], event.settings.pairPayoutBp);
  const action = isMessageEnabled(event.settings.texts, textKind, `${textKind}Enabled`)
    ? isJackpot && event.settings.announceJackpot
      ? { kind: "announcement" as const, text: reply, target: event.settings.chatTarget, automated: false }
      : { kind: "chat" as const, text: reply, target: event.settings.chatTarget, replyToMessageId: messageId, automated: false }
    : null;
  const sevenTvSymbols = event.settings.symbols.filter(({ source }) => source === "seven_tv");
  const activeSevenTv = sevenTvSymbols.length === 0 ? null : await fetchSevenTvEmotes(event.channelId);
  const overlaySymbols = result.symbols.map((symbolIndex) => {
    const symbol = event.settings.symbols[symbolIndex];
    if (symbol === undefined) return { source: "emoji", code: "?" };
    const missing = symbol.source === "seven_tv" && (activeSevenTv === null || activeSevenTv.status !== "ok" ||
      isSevenTvSymbolMissing(symbol, activeSevenTv.items));
    return {
      source: symbol.source,
      code: symbol.code,
      ...(symbol.twitchId === undefined ? {} : { twitchId: symbol.twitchId }),
      ...(symbol.sevenTvId === undefined ? {} : { sevenTvId: symbol.sevenTvId }),
      ...(missing ? { missing: true } : {}),
    };
  });
  const overlayAction = {
    kind: "overlay" as const,
    type: "spin",
    elementKind: EMOTE_SLOT_OVERLAY_ELEMENT_KIND,
    payload: {
      spinId: event.triggerId,
      login,
      language,
      outcome: textKind,
      spunAt: Number.isFinite(Date.parse(event.receivedAt)) ? event.receivedAt : new Date().toISOString(),
      symbols: overlaySymbols,
      net: result.net,
      jackpot: result.jackpotAfter,
      jackpotHit: result.jackpotWin > 0,
    },
  };
  return { actions: [...(action === null ? [] : [action]), overlayAction], diagnostics: [] };
};

