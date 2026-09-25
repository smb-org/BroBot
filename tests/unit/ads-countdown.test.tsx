import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdsCountdown } from "../../src/modules/ads/overlay/countdown";
import AdsCountdownEditor from "../../src/modules/ads/overlay/countdown-editor";

const variableCss = readFileSync(resolve(process.cwd(), "src/overlay/variable.css"), "utf8");

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

  it("renders module text as readable stacked lines by default", () => {
    render(<AdsCountdown config={{ showSnoozeInfo: true }} state={scheduleState()} now={Date.now()} language="en" />);
    const text = document.querySelector<HTMLElement>(".brobot-module-text");

    expect(text).not.toBeNull();
    expect(text?.children).toHaveLength(2);
    expect(variableCss).toContain(".brobot-variable,\n.brobot-module-text {");
    expect(variableCss).toContain("color: rgba(255, 255, 255, 0.96);");
    expect(variableCss).toContain("font: 700 48px/1.1 system-ui, sans-serif;");
    expect(variableCss).toContain("text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);");
    expect(variableCss).toContain("display: flex;\n  flex-direction: column;");
  });

  it("disables the snooze option for read-only operators and explains why", () => {
    const onChange = vi.fn();
    render(<AdsCountdownEditor config={{}} onChange={onChange} readOnly readOnlyReason="Operators cannot edit this overlay." />);
    const checkbox = screen.getByRole("checkbox", { name: "Show snooze info" });

    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Operators cannot edit this overlay.");
    expect(checkbox).toHaveAttribute("aria-describedby", "overlay-editor-readonly-reason");
    fireEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders nothing when Twitch has no scheduled ad", () => {
    render(<AdsCountdown config={{}} state={scheduleState({ nextAdAt: null, duration: null })} now={0} language="de" />);

    expect(document.querySelector(".brobot-module-text")).toBeNull();
  });
});
