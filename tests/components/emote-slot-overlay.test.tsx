import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import SlotOverlayEditor from "../../src/modules/emote_slots/overlay/editor";
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("emote slot overlay", () => {
  it("shows booked spin symbols and net result, then hides after six seconds (protects=the latest booked spin displays its three reels and net result for six seconds; fails_when=the spin is invisible, a symbol or result is missing, or the bar remains after six seconds; no_claim=realtime transport delivery to an OBS browser source)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));

    const { container } = render(<SlotOverlay config={{}} state={{ ...spinState("spin-one", ["🍒", "🔔", "💎"], "2030-01-01T00:00:00.000Z"), language: "de" }} now={Date.now()} language="de" />);

    expect(screen.getByText("🍒")).toBeInTheDocument();
    expect(screen.getByText("🔔")).toBeInTheDocument();
    expect(screen.getByText("💎")).toBeInTheDocument();
    expect(screen.getByText("+70")).toBeInTheDocument();
    expect(screen.getByText("1.256")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(6_000); });
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

  it("keeps the spin static when reduced motion is requested (protects=users who request reduced motion see the result without reel animation; fails_when=the reduced-motion preference leaves animated reel state enabled; no_claim=animation performance on real browsers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    render(<SlotOverlay config={{}} state={spinState("spin-static", ["🍒", "🍒", "🍒"], "2030-01-01T00:00:00.000Z")} now={Date.now()} language="en" />);
    expect(screen.getByRole("group", { name: "Slot result" })).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByText("+70")).toBeInTheDocument();
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
