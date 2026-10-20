import { describe, expect, it, vi } from "vitest";

import { isSevenTvSymbolMissing, parseSevenTvActiveSet } from "../../src/modules/emote_slots/domain/seven-tv";
import { DEFAULT_EMOTE_SLOT_SETTINGS, emoteSlotSettingsSchema } from "../../src/modules/emote_slots/contracts";
import { formatSlotReply } from "../../src/modules/emote_slots/domain/chat";
import type { SlotSettlementResult } from "../../src/modules/emote_slots/domain/settlement";
import { emoteSlotOverlayElement } from "../../src/modules/emote_slots/overlay/element";
import { mergeSlotOverlayRealtimeState } from "../../src/modules/emote_slots/overlay/state";
import { isModuleOverlayElementAddable } from "../../src/dashboard/overlay-editor-model";
import { clearSevenTvEmoteCache, fetchSevenTvEmotes } from "../../src/modules/emote_slots/seven-tv";

describe("active 7TV set", () => {
  it.each([
    ["invalid JSON", "not-json"],
    ["a null document", "null"],
    ["an empty object", "{}"],
    ["a schema mismatch", "{\"emote_set\":{}}"],
  ])("treats %s with HTTP 200 as unavailable and retries it (protects=malformed successful HTTP responses do not mark a saved symbol absent or poison the provider cache; fails_when=the response becomes no_account or the second lookup reuses the malformed result; no_claim=the live 7TV response schema beyond the covered invalid shapes)", async (_description, body) => {
    const userId = `fictional-${_description.replaceAll(" ", "-")}-payload-user`;
    clearSevenTvEmoteCache(userId);
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status: 200 })));

    const first = await fetchSevenTvEmotes(userId, fetcher);
    const second = await fetchSevenTvEmotes(userId, fetcher);

    expect(first).toEqual({ status: "unavailable", setName: null, items: [] });
    expect(second).toEqual({ status: "unavailable", setName: null, items: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reads only the active set and preserves its display name (protects=the picker receives the channel's active emotes and set name; fails_when=non-active user emotes leak into the list or the active set name is lost; no_claim=the live 7TV endpoint response shape beyond the covered fields)", () => {
    const result = parseSevenTvActiveSet({
      emote_set: {
        id: "set-active",
        name: "Night Shift",
        emotes: [{ id: "emote-active", name: "pixelwave", data: { host: { url: "//cdn.7tv.app/emote/emote-active" } } }],
      },
      emotes: [{ id: "emote-user", name: "not-active" }],
    });

    expect(result).toEqual({
      setName: "Night Shift",
      items: [{
        source: "seven_tv",
        code: "pixelwave",
        sevenTvId: "emote-active",
        name: "pixelwave",
        imageUrl: "https://cdn.7tv.app/emote/emote-active/2x.webp",
      }],
    });
  });

  it("rejects malformed active emotes instead of returning partial untrusted entries (protects=every 7TV picker entry has a safe id and code from the active set; fails_when=a malformed active-set item is exposed as selectable; no_claim=provider availability and route fallback behavior)", () => {
    expect(parseSevenTvActiveSet({
      emote_set: { id: "set-active", name: "Night Shift", emotes: [{ id: "bad/id", name: "unsafe" }] },
    })).toBeNull();
  });

  it("marks a saved symbol missing when its id is absent from the active set (protects=removed 7TV symbols are distinguishable from active symbols after a fresh lookup; fails_when=a stale saved id is treated as active; no_claim=whether the emote was removed from all of 7TV)", () => {
    expect(isSevenTvSymbolMissing(
      { source: "seven_tv", sevenTvId: "emote-old" },
      [{ source: "seven_tv", sevenTvId: "emote-new" }],
    )).toBe(true);
  });

  it("keeps a saved symbol active when its id is in the fetched set (protects=the stale-symbol notice is reserved for ids absent from the active 7TV set; fails_when=an active id is marked missing; no_claim=image CDN delivery)", () => {
    expect(isSevenTvSymbolMissing(
      { source: "seven_tv", sevenTvId: "emote-active" },
      [{ source: "seven_tv", sevenTvId: "emote-active" }],
    )).toBe(false);
  });

  it("accepts a 7TV symbol in saved slot settings (protects=saved reel settings can identify a 7TV emote by its provider id; fails_when=the settings schema rejects a valid seven_tv symbol or drops its id; no_claim=whether the symbol is currently in the active set)", () => {
    const symbols = DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 0
      ? { id: symbol.id, source: "seven_tv" as const, code: "pixelwave", sevenTvId: "emote-active", name: "pixelwave", weight: symbol.weight, triple: symbol.triple, isJackpot: symbol.isJackpot }
      : symbol);

    const parsed = emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, symbols });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.symbols[0]).toMatchObject({
      source: "seven_tv", sevenTvId: "emote-active", code: "pixelwave",
    });
  });

  it("keeps 7TV chat output as its emote code (protects=slot chat replies continue to send the configured 7TV text code; fails_when=a CDN URL or blank image value replaces the code in the reply; no_claim=delivery acceptance by Twitch)", () => {
    const symbols = DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 0
      ? { ...symbol, source: "seven_tv" as const, code: "pixelwave", sevenTvId: "emote-active" }
      : symbol);

    const result = {
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
    } satisfies SlotSettlementResult;

    expect(formatSlotReply(result, symbols, "en", "sampleviewer", "win", "{slot.symbols}")).toBe("pixelwave | pixelwave | pixelwave");
  });

  it("replaces an older realtime slot spin with a newer one (protects=rapid spins keep the latest result as overlay state; fails_when=an earlier spin overwrites the newer result; no_claim=message delivery order at the realtime transport)", () => {
    const previous = {
      spinId: "spin-old",
      login: "pixelwanderer",
      language: "en",
      outcome: "win",
      spunAt: "2030-01-01T00:00:00.000Z",
      symbols: [{ source: "emoji", code: "🍒" }, { source: "emoji", code: "🍒" }, { source: "emoji", code: "🍒" }],
      net: 10,
      jackpot: 100,
      jackpotHit: false,
    };
    const newer = { ...previous, spinId: "spin-new", spunAt: "2030-01-01T00:00:01.000Z", net: 20 };

    expect(mergeSlotOverlayRealtimeState(previous, newer)).toMatchObject({ spinId: "spin-new", net: 20 });
    expect(mergeSlotOverlayRealtimeState(newer, previous)).toMatchObject({ spinId: "spin-new", net: 20 });
  });

  it("registers the optional slot element with a bounded size and module gate (protects=the editor has a 640-by-160 slot element that stays hidden from the add palette while disabled; fails_when=the element is missing, oversized, or not gated by emote_slots; no_claim=channel-specific editor authorization)", () => {
    expect(emoteSlotOverlayElement).toMatchObject({
      kind: "emote_slots.slot",
      defaultSize: { width: 640, height: 160 },
      hideWhenModuleDisabled: true,
    });
    expect(typeof emoteSlotOverlayElement.load).toBe("function");
    expect(isModuleOverlayElementAddable(emoteSlotOverlayElement.hideWhenModuleDisabled, false)).toBe(false);
    expect(isModuleOverlayElementAddable(emoteSlotOverlayElement.hideWhenModuleDisabled, true)).toBe(true);
  });
});
