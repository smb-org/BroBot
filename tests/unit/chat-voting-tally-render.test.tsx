import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayCanvas } from "../../src/overlay/canvas";
import Tally from "../../src/modules/chat_voting/overlay/tally";

describe("chat voting overlay tally", () => {
  afterEach(cleanup);

  it("uses the question as a fixed two-line header and retains the generic heading without one", () => {
    const longTitle = "😀".repeat(80);
    const { rerender } = render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "titled-poll",
      title: longTitle,
      status: "open",
      preset: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      counts: [1, 0],
      revision: 1,
    }} now={Date.now()} language="en" />);

    const header = screen.getByRole("heading", { name: longTitle });
    expect(header).toHaveAttribute("title", longTitle);
    expect(header.style.height).toBe("2.4em");
    expect((header.querySelector(".chat-voting-tally__header-title") as HTMLElement).style.webkitLineClamp).toBe("2");

    rerender(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "untitled-poll",
      status: "open",
      preset: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      counts: [1, 0],
      revision: 1,
    }} now={Date.now()} language="en" />);
    expect(screen.getByRole("heading", { name: "Voting" })).toBeInTheDocument();
  });

  it("renders the top five text terms and masks terms before filter readiness", () => {
    const terms = [
      { term: "alpha", count: 6, approved: true },
      { term: "bravo", count: 5, approved: false },
      { term: "charlie", count: 4, approved: true },
      { term: "delta", count: 3, approved: true },
      { term: "echo", count: 2, approved: true },
      { term: "foxtrot", count: 1, approved: true },
    ];
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "text-poll",
      openedAt: "2030-01-01T00:00:00.000Z",
      status: "open",
      preset: "free_text",
      optionCount: 0,
      textMode: "first_word",
      labels: [],
      counts: [],
      terms,
      more: 2,
      termFilterReady: true,
      revision: 1,
    }} now={Date.now()} language="en" />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("charlie")).toBeInTheDocument();
    expect(screen.getByText("delta")).toBeInTheDocument();
    expect(screen.getByText("echo")).toBeInTheDocument();
    expect(screen.queryByText("foxtrot")).not.toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("more: 2")).toBeInTheDocument();

    cleanup();
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "text-poll",
      status: "open",
      preset: "free_text",
      counts: [],
      terms,
      termFilterReady: false,
      revision: 2,
    }} now={Date.now()} language="en" />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("?")).not.toBeInTheDocument();
    expect(screen.queryByText("bravo")).not.toBeInTheDocument();
  });

  it("renders labels and counts for digit presets", () => {
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "zero-one-poll",
      status: "open",
      preset: "digit_01",
      optionCount: 2,
      labels: ["Nein", "Ja"],
      counts: [1, 2],
      revision: 1,
    }} now={Date.now()} language="de" />);

    expect(screen.getByText("Nein")).toBeInTheDocument();
    expect(screen.getByText("Ja")).toBeInTheDocument();
    expect(screen.getByText("1 · 33%")).toBeInTheDocument();
    expect(screen.getByText("2 · 67%")).toBeInTheDocument();
  });

  it("hides free-text percentages when configured", () => {
    render(<Tally config={{ layout: "bars", showPercent: false, hideAfterCloseSeconds: 15 }} state={{
      pollId: "text-percent-poll",
      status: "open",
      preset: "free_text",
      counts: [],
      terms: [{ term: "alpha", count: 2, approved: true }],
      termFilterReady: true,
      revision: 1,
    }} now={Date.now()} language="en" />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/%/u)).not.toBeInTheDocument();
  });

  it("gives empty text rows the same bar dimensions and reserves the five-row strip height", () => {
    const { container } = render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "strip-poll",
      status: "open",
      preset: "free_text",
      counts: [],
      terms: [{ term: "alpha", count: 2, approved: true }],
      termFilterReady: true,
      revision: 1,
    }} now={Date.now()} language="en" />);
    let options = container.querySelector(".chat-voting-tally__options");
    const rows = options?.querySelectorAll(".chat-voting-tally__option");
    expect(rows).toHaveLength(5);
    expect((rows?.[0] as HTMLElement | undefined)?.style.minHeight).toBe("2.3em");
    expect((rows?.[1] as HTMLElement | undefined)?.style.minHeight).toBe("2.3em");
    expect(rows?.[0]?.querySelector(".chat-voting-tally__track")).not.toBeNull();
    expect(rows?.[1]?.querySelector(".chat-voting-tally__track")).not.toBeNull();
    const caption = rows?.[0]?.querySelector(".chat-voting-tally__caption") as HTMLElement | null;
    const count = caption?.children[1] as HTMLElement | undefined;
    const track = rows?.[0]?.querySelector(".chat-voting-tally__track") as HTMLElement | null;
    expect(caption?.style.display).toBe("grid");
    expect(caption?.style.gridTemplateColumns).toBe("minmax(0, 1fr) 10rem");
    expect(count?.style.fontVariantNumeric).toBe("tabular-nums");
    expect(track?.style.width).toBe("100%");
    expect(track?.style.minWidth).toBe("0px");

    cleanup();
    const strip = render(<Tally config={{ layout: "strip", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "strip-poll",
      status: "open",
      preset: "free_text",
      counts: [],
      terms: [{ term: "alpha", count: 2, approved: true }],
      termFilterReady: true,
      revision: 1,
    }} now={Date.now()} language="en" />);
    options = strip.container.querySelector(".chat-voting-tally__options");
    expect((options as HTMLElement | null)?.style.height).toBe("14.1em");
    expect(options?.querySelectorAll(".chat-voting-tally__option")).toHaveLength(5);
  });

  it("counts down from the local clock, ticks to zero, and stays at zero until the closed state arrives", () => {
    const localNow = "2030-01-01T00:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(localNow));
    try {
      const config = { layout: "bars", showPercent: true, showCountdown: true };
      const state = {
        pollId: "timed-poll",
        openedAt: localNow,
        closesAt: "2030-01-01T00:01:30.000Z",
        requestedDurationSeconds: 90,
        status: "open",
        preset: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        counts: [0, 0],
        revision: 0,
      };
      const { container, rerender } = render(<Tally config={config} state={state} now={Date.now()} language="en" />);

      const countdown = container.querySelector<HTMLElement>(".chat-voting-tally__countdown");
      expect(countdown).toHaveTextContent("1:30");
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(countdown).toHaveTextContent("1:29");
      act(() => { vi.advanceTimersByTime(89_000); });
      expect(countdown).toHaveTextContent("0:00");
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(countdown).toHaveTextContent("0:00");

      rerender(<Tally config={config} state={{
        ...state,
        status: "closed",
        closedAt: new Date(Date.now()).toISOString(),
      }} now={Date.now()} language="en" />);
      expect(countdown).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["open-ended", { requestedDurationSeconds: null, status: "open" }],
    ["closed", { requestedDurationSeconds: 90, status: "closed", closedAt: "2030-01-01T00:00:00.000Z" }],
  ] as const)("clears the visible countdown for %s votes while keeping its slot", (_name, extraState) => {
    const localNow = "2030-01-01T00:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(localNow));
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    try {
      const config = { layout: "bars", showPercent: true, showCountdown: true };
      const state = {
        pollId: "changing-countdown-poll",
        openedAt: localNow,
        closesAt: "2030-01-01T00:01:30.000Z",
        requestedDurationSeconds: 90,
        status: "open" as const,
        preset: "yes_no" as const,
        optionCount: 2,
        labels: ["Yes", "No"],
        counts: [0, 0],
        revision: 0,
      };
      const { container, rerender, unmount } = render(<Tally config={config} state={state} now={Date.now()} language="en" />);

      expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:30");
      expect(vi.getTimerCount()).toBe(1);
      rerender(<Tally config={config} state={{ ...state, ...extraState }} now={Date.now()} language="en" />);

      const header = container.querySelector<HTMLElement>(".chat-voting-tally__header");
      const countdown = container.querySelector<HTMLElement>(".chat-voting-tally__countdown");
      expect(countdown).toBeEmptyDOMElement();
      expect(countdown?.style.width).toBe("6ch");
      expect(countdown?.style.minWidth).toBe("6ch");
      expect(header?.style.gridTemplateColumns).toContain("6ch");
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(_name === "closed" ? 1 : 0);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the countdown slot when the overlay option is disabled", () => {
    const localNow = "2030-01-01T00:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(localNow));
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    try {
      const state = {
        pollId: "disabled-countdown-poll",
        openedAt: localNow,
        closesAt: "2030-01-01T00:01:30.000Z",
        requestedDurationSeconds: 90,
        status: "open" as const,
        preset: "yes_no" as const,
        optionCount: 2,
        labels: ["Yes", "No"],
        counts: [0, 0],
        revision: 0,
      };
      const enabledConfig = { layout: "bars", showPercent: true, showCountdown: true };
      const { container, rerender, unmount } = render(<Tally config={enabledConfig} state={state} now={Date.now()} language="en" />);

      expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:30");
      expect(vi.getTimerCount()).toBe(1);
      rerender(<Tally config={{ ...enabledConfig, showCountdown: false }} state={state} now={Date.now()} language="en" />);

      const countdown = container.querySelector<HTMLElement>(".chat-voting-tally__countdown");
      expect(countdown).toBeEmptyDOMElement();
      expect(countdown?.style.width).toBe("6ch");
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shows 1:30 for a timed vote arriving after an hour idle in the overlay canvas", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const overlay = (state: Record<string, unknown> | null) => ({
        id: "overlay-a", revision: 1, width: 1280, height: 720, css: "",
        elements: [{
          id: "tally-a", kind: "chat_voting.tally", label: "Vote", variableName: null, text: "",
          config: { showCountdown: true }, state, moduleEnabled: true,
          x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true,
        }],
      });
      const { container, rerender } = render(
        <OverlayCanvas overlay={overlay({ pollId: "idle", status: "open", preset: "yes_no", labels: ["Yes", "No"], counts: [0, 0], revision: 0 })} language="en" variables={{}} elementId={null} />);
      // Wait until the lazy chunk has mounted the idle tally before time passes.
      await vi.waitFor(() => { expect(container.querySelector("[data-element='tally-a']")?.childElementCount).toBeGreaterThan(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
      const now = Date.now();
      rerender(<OverlayCanvas overlay={overlay({
        pollId: "late-poll", openedAt: new Date(now).toISOString(),
        closesAt: new Date(now + 90_000).toISOString(), requestedDurationSeconds: 90,
        status: "open", preset: "yes_no", optionCount: 2, labels: ["Yes", "No"], counts: [0, 0], revision: 0,
      })} language="en" variables={{}} elementId={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:30");
    } finally {
      vi.useRealTimers();
    }
  });
});
