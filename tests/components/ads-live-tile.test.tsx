import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdsLiveTile } from "../../src/dashboard/AdsLiveTile";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(() => { cleanup(); });

const schedule = {
  kind: "ad_schedule" as const,
  nextAdAt: "2030-01-01T00:03:00.000Z",
  duration: 90,
  snoozeCount: 2,
  snoozeScopeAvailable: true,
  runningBreakEndsAt: null,
};

describe("AdsLiveTile", () => {
  it("renders an upcoming break, countdown, joker count, and one postpone action", () => {
    render(<UiProvider><AdsLiveTile ads={schedule} now={Date.parse("2030-01-01T00:00:00.000Z")} language="en" canManage onSnooze={vi.fn()} /></UiProvider>);

    const tile = screen.getByRole("region", { name: "Next ad break" });
    expect(tile).toHaveTextContent("in 3:00");
    expect(tile).toHaveTextContent("Postpone: 2 jokers");
    expect(screen.getAllByRole("button", { name: /snooze/i })).toHaveLength(1);
  });

  it("keeps its fixed content slots for imminent, no schedule, and error states", () => {
    const { rerender } = render(<UiProvider><AdsLiveTile ads={schedule} now={Date.parse("2030-01-01T00:01:00.000Z")} language="en" canManage onSnooze={vi.fn()} /></UiProvider>);
    const tile = screen.getByRole("region", { name: "Next ad break" });
    const reserved = tile.querySelector(".live-cockpit-ads-tile__reserved");
    expect(tile).toHaveTextContent("Imminent");

    rerender(<UiProvider><AdsLiveTile ads={{ ...schedule, nextAdAt: null }} now={Date.parse("2030-01-01T00:01:00.000Z")} language="en" canManage onSnooze={vi.fn()} /></UiProvider>);
    expect(tile).toHaveTextContent("No ad break scheduled");
    expect(tile.querySelector(".live-cockpit-ads-tile__reserved")).toBe(reserved);

    rerender(<UiProvider><AdsLiveTile ads={null} now={Date.parse("2030-01-01T00:01:00.000Z")} language="en" canManage failed onSnooze={vi.fn()} /></UiProvider>);
    expect(tile).toHaveTextContent("Ad schedule unavailable");
    expect(tile.querySelector(".live-cockpit-ads-tile__reserved")).toBe(reserved);
  });

  it("calls the existing postpone action once", () => {
    const onSnooze = vi.fn();
    render(<UiProvider><AdsLiveTile ads={schedule} now={Date.parse("2030-01-01T00:00:00.000Z")} language="en" canManage onSnooze={onSnooze} /></UiProvider>);
    fireEvent.click(screen.getByRole("button", { name: /snooze/i }));
    expect(onSnooze).toHaveBeenCalledOnce();
  });

  it("shows an active break from its event end time", () => {
    render(<UiProvider><AdsLiveTile
      ads={{ ...schedule, nextAdAt: null, runningBreakEndsAt: "2030-01-01T00:01:30.000Z" }}
      now={Date.parse("2030-01-01T00:00:00.000Z")}
      language="en" canManage onSnooze={vi.fn()}
    /></UiProvider>);

    const tile = screen.getByRole("region", { name: "Next ad break" });
    expect(tile).toHaveAttribute("data-state", "running");
    expect(tile).toHaveTextContent("Break running");
    expect(tile).toHaveTextContent("1:30 remaining");
  });

  it("reserves its content for loading and disabled states", () => {
    const { rerender } = render(<UiProvider><AdsLiveTile ads={null} now={Date.now()} language="en" canManage loading onSnooze={vi.fn()} /></UiProvider>);
    const tile = screen.getByRole("region", { name: "Next ad break" });
    const reserved = tile.querySelector(".live-cockpit-ads-tile__reserved");
    expect(tile).toHaveAttribute("data-state", "loading");

    rerender(<UiProvider><AdsLiveTile ads={schedule} now={Date.now()} language="en" canManage={false} moduleActive={false} onSnooze={vi.fn()} /></UiProvider>);
    expect(tile).toHaveAttribute("data-state", "disabled");
    expect(tile.querySelector(".live-cockpit-ads-tile__reserved")).toBe(reserved);
  });
});
