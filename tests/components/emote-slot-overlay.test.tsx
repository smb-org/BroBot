import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import SlotOverlayEditor from "../../src/modules/emote_slots/overlay/editor";
import { emoteSlotOverlayElement } from "../../src/modules/emote_slots/overlay/element";
import { DEFAULT_SLOT_OVERLAY_CONFIG } from "../../src/modules/emote_slots/overlay/state";
import SlotOverlay from "../../src/modules/emote_slots/overlay/slot";

const spinState = (spinId: string, symbols: string[], spunAt: string, jackpot = false): JsonObject => ({
  spinId,
  spunAt,
  login: "pixelwanderer",
  language: "en",
  outcome: "win",
  symbols: symbols.map((code) => ({ source: "emoji", code })),
  net: 70,
  jackpot: 1_256,
  jackpotHit: jackpot,
});

const setReducedMotion = (matches: boolean): void => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("emote slot overlay", () => {
  it("shows booked spin symbols and net result for six seconds after the reel animation (protects=the latest booked spin displays its three reels and net result through the reel animation and for six seconds afterward; fails_when=the spin hides during animation or remains after its six-second presentation window; no_claim=realtime transport delivery to an OBS browser source)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    setReducedMotion(false);

    const { container } = render(<SlotOverlay config={{}} state={{ ...spinState("spin-one", ["🍒", "🔔", "💎"], "2030-01-01T00:00:00.000Z"), language: "de" }} now={Date.now()} language="de" />);

    expect(screen.getByText("🍒")).toBeInTheDocument();
    expect(screen.getByText("🔔")).toBeInTheDocument();
    expect(screen.getByText("💎")).toBeInTheDocument();
    expect(screen.getByText("+70")).toBeInTheDocument();
    expect(screen.getByText("1.256")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(7_199); });
    expect(container.querySelector(".emote-slot-overlay")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("restarts the presentation window for a replacement spin independent of spunAt (protects=each replacement remains visible through its reel animation and six-second result window; fails_when=the earlier deadline or an old spunAt timestamp hides the replacement; no_claim=server event ordering)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    setReducedMotion(false);
    const spunAt = "2030-01-01T00:00:00.000Z";
    const first = spinState("spin-first", ["🍒", "🍋", "🔔"], spunAt);
    const second = spinState("spin-second", ["💎", "💎", "💎"], spunAt, true);
    const { rerender, container } = render(<SlotOverlay config={{}} state={first} now={Date.now()} language="en" />);

    act(() => { vi.advanceTimersByTime(5_000); });
    rerender(<SlotOverlay config={{}} state={second} now={Date.now()} language="en" />);
    act(() => { vi.advanceTimersByTime(1_200); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-second");
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-second");
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("replaces the current spin immediately when a second result arrives (protects=the overlay renders only the newest spin without a queued prior result; fails_when=the first spin remains visible or both results are presented; no_claim=ordering guarantees provided by the realtime server)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const first = spinState("spin-one", ["🍒", "🍋", "🔔"], "2030-01-01T00:00:00.000Z");
    const second = spinState("spin-two", ["💎", "💎", "💎"], "2030-01-01T00:00:01.000Z", true);
    const { rerender, container } = render(<SlotOverlay config={{}} state={first} now={Date.now()} language="en" />);

    rerender(<SlotOverlay config={{}} state={second} now={Date.now()} language="en" />);
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-two");
    expect(screen.getAllByText("💎")).toHaveLength(3);
    expect(screen.queryByText("🍒")).not.toBeInTheDocument();
    expect(screen.getByText("Jackpot")).toBeInTheDocument();
  });

  it("keeps the spin static and visible for six seconds with reduced motion (protects=reduced-motion users see a static result for six seconds independent of spunAt; fails_when=reels animate or the result expires before its presentation window; no_claim=animation performance on real browsers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const { container } = render(<SlotOverlay config={{}} state={spinState("spin-static", ["🍒", "🍒", "🍒"], "2029-12-31T23:59:50.000Z")} now={Date.now()} language="en" />);
    expect(screen.getByRole("group", { name: "Slot result" })).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByText("+70")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(container.querySelector(".emote-slot-overlay")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("keeps the editor preview visible without an expiry (protects=the overlay editor can leave its preview mounted while positioning it; fails_when=the fixed preview disappears after the live-spin timeout; no_claim=editor canvas persistence across page reloads)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const preview = emoteSlotOverlayElement.previewState({}, "en", Date.now());
    const { container } = render(<SlotOverlay config={{}} state={preview} now={Date.now()} language="en" />);

    act(() => { vi.advanceTimersByTime(60_000); });

    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("overlay-editor-preview");
  });

  it("restarts the jackpot highlight subtree for every new jackpot spin (protects=each jackpot result gets a fresh three-second highlight; fails_when=consecutive jackpots reuse the same animated result node; no_claim=animation rendering quality on every browser and display)", () => {
    const first = spinState("jackpot-first", ["💎", "💎", "💎"], "2030-01-01T00:00:00.000Z", true);
    const second = spinState("jackpot-second", ["👑", "👑", "👑"], "2030-01-01T00:00:01.000Z", true);
    const { container, rerender } = render(<SlotOverlay config={{}} state={first} now={Date.now()} language="en" />);
    const firstHighlight = container.querySelector(".emote-slot-overlay__jackpot .emote-slot-overlay__main");

    rerender(<SlotOverlay config={{}} state={second} now={Date.now()} language="en" />);

    const secondHighlight = container.querySelector(".emote-slot-overlay__jackpot .emote-slot-overlay__main");
    expect(secondHighlight).not.toBe(firstHighlight);
    expect(secondHighlight).toHaveTextContent("1,256");
  });


  it.each([
    ["win", 70, "Win"], ["loss", -50, "Loss"], ["pair", 0, "Stake returned"], ["jackpot", 500, "Jackpot"],
  ])("uses the channel outcome %s and language (protects=the player login and localized chat outcome accompany channel-formatted net and jackpot; fails_when=dashboard language overrides channel language or outcome and login are absent; no_claim=browser typography and truncation)", (outcome, net, word) => {
    const state = { ...spinState("spin-localized", ["🍒", "🍒", "🍒"], new Date().toISOString()), outcome, net };
    const { container } = render(<SlotOverlay config={{}} state={state} now={Date.now()} language="de" />);
    expect(screen.getByText("pixelwanderer")).toBeInTheDocument();
    expect(container.querySelector(".emote-slot-overlay__outcome")).toHaveTextContent(word);
    expect(screen.getByText("1,256")).toBeInTheDocument();
  });

  it.each(["twitch", "seven_tv"])("replaces a failed %s image with a dashed code tile (protects=failed provider images retain their code without a broken image; fails_when=an image failure leaves an image element or omits the dashed fallback tile; no_claim=live CDN availability)", (source) => {
    const state = { ...spinState("spin-image", ["🍒", "🍒", "🍒"], new Date().toISOString()), symbols: [
      { source, code: "pixelwave", twitchId: "twitch-wave", sevenTvId: "active-emote" },
      { source: "emoji", code: "🍒" }, { source: "emoji", code: "🍒" },
    ] };
    const { container } = render(<SlotOverlay config={{}} state={state} now={Date.now()} language="en" />);
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("pixelwave").parentElement).toHaveClass("emote-slot-overlay__reel--code");
  });

  it("shows the saved code when a renamed 7TV alias is marked missing (protects=the overlay uses the configured alias as a dashed code fallback when its saved id and code pair is inactive; fails_when=the missing 7TV symbol requests an image or omits its saved code; no_claim=the provider lookup that supplies the missing marker)", () => {
    const state = {
      ...spinState("spin-renamed-alias", ["oldwave", "🍒", "🔔"], "2030-01-01T00:00:00.000Z"),
      symbols: [
        { source: "seven_tv", code: "oldwave", sevenTvId: "emote-shared", missing: true },
        { source: "emoji", code: "🍒" },
        { source: "emoji", code: "🔔" },
      ],
    };
    const { container } = render(<SlotOverlay config={{}} state={state} now={Date.now()} language="en" />);
    const firstReel = container.querySelector('[data-reel-index="0"]');

    expect(firstReel).toHaveClass("emote-slot-overlay__reel--code");
    expect(firstReel?.querySelector("img")).toBeNull();
    expect(firstReel).toHaveTextContent("oldwave");
  });

  it("warns when an edited text color falls below 4.5:1 contrast (protects=overlay color edits disclose text contrast below the minimum and remain explicitly editable; fails_when=low-contrast text is accepted without a warning; no_claim=color perception on every display)", () => {
    const onChange = vi.fn<(config: JsonObject) => void>();
    const { rerender } = render(<SlotOverlayEditor config={DEFAULT_SLOT_OVERLAY_CONFIG} onChange={onChange} language="en" />);

    expect(screen.getByRole("status")).toHaveAttribute("data-status", "ok");
    fireEvent.change(screen.getByLabelText("Text color"), { target: { value: "#090C10" } });

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SLOT_OVERLAY_CONFIG, textColor: "#090c10" });
    rerender(<SlotOverlayEditor config={{ ...DEFAULT_SLOT_OVERLAY_CONFIG, textColor: "#090c10" }} onChange={onChange} language="en" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "warning");
    expect(screen.getByRole("status")).toHaveTextContent("at least 4.5:1 is required");
  });
});
