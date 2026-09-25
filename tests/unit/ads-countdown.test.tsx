import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdsCountdown } from "../../src/modules/ads/overlay/countdown";

const scheduleState = (overrides: Record<string, unknown> = {}) => ({
  nextAdAt: "2026-09-25T12:00:10.000Z",
  duration: 90,
  snoozeCount: 2,
  snoozeRefreshAt: "2026-09-25T12:30:00.000Z",
  serverNow: "2026-09-25T12:00:00.000Z",
  ...overrides,
});

describe("ads countdown overlay element", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ticks from server time on a monotonic clock when the browser clock is skewed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:02:00.000Z"));
    const state = scheduleState();

    render(<AdsCountdown config={{}} state={state} now={Date.now()} language="en" />);

    expect(screen.getByText("Ad in 0:10")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("Ad in 0:09")).toBeInTheDocument();
    expect(state).toMatchObject({ nextAdAt: "2026-09-25T12:00:10.000Z", duration: 90 });
  });

  it("shows the ad period, then hides when its scheduled duration ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    render(<AdsCountdown config={{}} state={scheduleState({
      nextAdAt: "2026-09-25T12:00:03.000Z",
      duration: 5,
    })} now={Date.now()} language="de" />);

    expect(screen.getByText("Werbung in 0:03")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByText("Werbung läuft · 0:05")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(document.querySelector(".brobot-module-text")).toBeNull();
  });

  it("hides after the ad starts when Twitch has no duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    render(<AdsCountdown config={{}} state={scheduleState({
      nextAdAt: "2026-09-25T12:00:02.000Z",
      duration: null,
    })} now={Date.now()} language="en" />);

    expect(screen.getByText("Ad in 0:02")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(document.querySelector(".brobot-module-text")).toBeNull();
  });

  it("shows snooze count and refresh countdown only when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const view = render(<AdsCountdown config={{ showSnoozeInfo: true }} state={scheduleState()} now={Date.now()} language="de" />);

    expect(screen.getByText("2× verschiebbar")).toBeInTheDocument();
    view.rerender(<AdsCountdown config={{ showSnoozeInfo: true }} state={scheduleState({
      snoozeCount: 0,
      snoozeRefreshAt: "2026-09-25T12:02:00.000Z",
    })} now={Date.now()} language="en" />);
    expect(screen.getByText("next snooze in 2:00")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("next snooze in 1:59")).toBeInTheDocument();

    view.rerender(<AdsCountdown config={{}} state={scheduleState()} now={Date.now()} language="en" />);
    expect(screen.queryByText("2 snoozes left")).not.toBeInTheDocument();
  });

  it("renders nothing when Twitch has no scheduled ad", () => {
    render(<AdsCountdown config={{}} state={scheduleState({ nextAdAt: null, duration: null })} now={0} language="de" />);

    expect(document.querySelector(".brobot-module-text")).toBeNull();
  });
});
