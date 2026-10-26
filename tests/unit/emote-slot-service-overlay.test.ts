import { describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage } from "../../src/modules/contract";
import type { SlotSettlementResult } from "../../src/modules/emote_slots/domain/settlement";
import { DEFAULT_EMOTE_SLOT_SETTINGS } from "../../src/modules/emote_slots/contracts";
import { processEmoteSlotMessage } from "../../src/modules/emote_slots/service";

const settlement = {
  kind: "slot",
  symbols: [0, 0, 0] as [number, number, number],
  stake: 50,
  payout: 350,
  net: 300,
  balanceAfter: 400,
  jackpotAfter: 1_256,
  jackpotWin: 0,
  triple: true,
  pair: false,
};

const eventFor = (settings = DEFAULT_EMOTE_SLOT_SETTINGS): ModuleEvent<typeof DEFAULT_EMOTE_SLOT_SETTINGS> => ({
  channelId: "fictional-channel-123",
  subscriptionType: "channel.chat.message",
  triggerId: "fictional-message-1",
  payload: {
    chatter_user_id: "fictional-user-1",
    chatter_user_login: "nachtfalke",
    message_id: "fictional-message-1",
    message: { text: "!slot" },
  },
  settings,
  receivedAt: "2030-01-01T00:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
});

const contextFor = (replayed: boolean, language: ModuleLanguage = "en", result: SlotSettlementResult = settlement as SlotSettlementResult): ModuleExecutionContext => ({
  points: {
    settle: vi.fn(() => Promise.resolve({ replayed, result, balances: {}, deltas: {} })),
  },
  channelLanguage: () => Promise.resolve(language),
  botUserId: () => Promise.resolve(null),
} as unknown as ModuleExecutionContext);

describe("slot spin overlay messages", () => {
  it("passes the configured pair payout to settlement (protects=chat spins use the saved multiplier; fails_when=the settlement service silently falls back to another pair amount; no_claim=the ledger's arithmetic)", async () => {
    const event = eventFor({ ...DEFAULT_EMOTE_SLOT_SETTINGS, pairPayoutBp: 22_500 });
    const context = contextFor(false);

    await processEmoteSlotMessage(event, context);

    expect(context.points.settle).toHaveBeenCalledWith(
      "msg:fictional-message-1",
      "slot",
      { accountId: "fictional-user-1", login: "nachtfalke" },
      50,
      expect.objectContaining({ pairPayoutBp: 22_500 }),
      expect.any(Object),
    );
  });

  it("publishes the booked spin symbols and settled values (protects=an original settlement emits one overlay state matching its booked symbols, net, and jackpot; fails_when=the overlay omits a reel or reports values different from the settlement; no_claim=browser animation timing)", async () => {
    const result = await processEmoteSlotMessage(eventFor(), contextFor(false));
    const overlay = result.actions.find((action) => action.kind === "overlay");

    expect(result.actions).toHaveLength(2);
    expect(overlay).toMatchObject({
      kind: "overlay",
      type: "spin",
      elementKind: "emote_slots.slot",
      payload: {
        spinId: "fictional-message-1",
        login: "nachtfalke",
        language: "en",
        outcome: "win",
        spunAt: "2030-01-01T00:00:00.000Z",
        symbols: [
          { source: "emoji", code: "🍒" },
          { source: "emoji", code: "🍒" },
          { source: "emoji", code: "🍒" },
        ],
        net: 300,
        jackpot: 1_256,
        jackpotHit: false,
      },
    });
  });

  it.each(["de", "en"] as const)("uses channel language %s and the same outcome as chat (protects=every outcome carries the channel locale and the exact result kind used for the chat template; fails_when=language is hardcoded or pair, loss, or jackpot semantics diverge between chat and overlay; no_claim=translated browser typography)", async (language) => {
    const jackpotIndex = DEFAULT_EMOTE_SLOT_SETTINGS.symbols.findIndex((symbol) => symbol.isJackpot);
    const outcomes = [
      { outcome: "win", result: { ...settlement } },
      { outcome: "loss", result: { ...settlement, symbols: [0, 1, 2] as [number, number, number], net: -50, triple: false } },
      { outcome: "pair", result: { ...settlement, symbols: [0, 0, 1] as [number, number, number], net: 0, pair: true, triple: false } },
      { outcome: "jackpot", result: { ...settlement, symbols: [jackpotIndex, jackpotIndex, jackpotIndex] as [number, number, number], jackpotWin: 500 } },
    ];
    for (const { outcome, result } of outcomes) {
      const event = eventFor({ ...DEFAULT_EMOTE_SLOT_SETTINGS, texts: { win: "result-win", loss: "result-loss", pair: "result-pair", jackpot: "result-jackpot" } });
      const processed = await processEmoteSlotMessage(event, contextFor(false, language, result as SlotSettlementResult));
      expect(processed.actions[0]).toMatchObject({ text: `result-${outcome}` });
      expect(processed.actions[1]).toMatchObject({ payload: { language, outcome, login: event.payload.chatter_user_login } });
    }
  });

  it("emits no overlay message for a replayed settlement (protects=an idempotent replay cannot repeat the booked spin on stream; fails_when=replay returns any chat or overlay action; no_claim=the first delivery's Twitch send outcome)", async () => {
    const result = await processEmoteSlotMessage(eventFor(), contextFor(true));

    expect(result.actions).toEqual([]);
  });

  it.each([
    { kind: "win", result: settlement },
    { kind: "loss", result: { ...settlement, symbols: [0, 1, 2] as [number, number, number], net: -50, triple: false } },
    { kind: "pair", result: { ...settlement, symbols: [0, 0, 1] as [number, number, number], net: 0, pair: true, triple: false } },
    { kind: "jackpot", result: { ...settlement, symbols: [5, 5, 5] as [number, number, number], jackpotWin: 500 } },
  ] as const)("keeps a disabled $kind message saved while delivering the booked spin overlay", async ({ kind, result: outcome }) => {
    const settings = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      texts: { ...DEFAULT_EMOTE_SLOT_SETTINGS.texts, [kind]: `Saved ${kind} message`, [`${kind}Enabled`]: false },
    };

    const result = await processEmoteSlotMessage(eventFor(settings), contextFor(false, "en", outcome as SlotSettlementResult));

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "overlay", type: "spin", payload: { outcome: kind } });
    expect(settings.texts[kind]).toBe(`Saved ${kind} message`);
  });
});
