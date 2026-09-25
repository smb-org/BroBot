import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdsCountdown } from "../../src/modules/ads/overlay/countdown";

describe("ads countdown overlay element", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ticks in the browser without changing the supplied schedule state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const state = { nextAdAt: "2026-09-25T12:00:10.000Z", duration: 90 };

    render(<AdsCountdown config={{}} state={state} now={Date.now()} language="en" />);

    expect(screen.getByText("Ad in 10 seconds · 90 seconds")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("Ad in 9 seconds · 90 seconds")).toBeInTheDocument();
    expect(state).toEqual({ nextAdAt: "2026-09-25T12:00:10.000Z", duration: 90 });
  });

  it("renders nothing when Twitch has no scheduled ad", () => {
    render(<AdsCountdown config={{}} state={{ nextAdAt: null, duration: null }} now={0} language="de" />);

    expect(document.querySelector(".brobot-module-text")).toBeNull();
  });
});
