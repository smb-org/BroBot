import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import { votekickOverlayElement } from "../../src/modules/votekick/overlay/element";
import VotekickOverlayEditor from "../../src/modules/votekick/overlay/editor";
import Tally from "../../src/modules/votekick/overlay/tally";

const runningState = (endsAt: string): JsonObject => ({
  votekickId: "votekick-a",
  targetLogin: "sampleviewer",
  targetUserId: "target-a",
  yesVotes: 4,
  noVotes: 1,
  threshold: 5,
  ballotRevision: 5,
  status: "running",
  startedAt: "2030-01-01T00:00:00.000Z",
  endsAt,
  endedAt: null,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("votekick overlay tally", () => {
  it("renders localized target, yes/no bars, latches zero, and shows the closed outcome before hiding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const endsAt = "2030-01-01T00:00:02.000Z";
    const config = { showCountdown: true, hideAfterCloseSeconds: 1 };
    const { container, rerender } = render(<Tally config={config} state={runningState(endsAt)} now={Date.now()} language="de" />);

    expect(screen.getByRole("heading", { name: "Votekick · @sampleviewer" })).toBeInTheDocument();
    expect(screen.getByText("Ja")).toBeInTheDocument();
    expect(screen.getByText("Nein")).toBeInTheDocument();
    expect(screen.getByText("Benötigt: 5 Netto-Ja-Stimmen")).toBeInTheDocument();
    const countdown = screen.getByRole("timer");
    expect(countdown).toHaveTextContent("0:02");

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(countdown).toHaveTextContent("0:00");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(countdown).toHaveTextContent("0:00");

    rerender(<Tally config={config} state={{
      ...runningState(endsAt),
      status: "passed",
      endedAt: new Date(Date.now()).toISOString(),
    }} now={Date.now()} language="de" />);
    expect(screen.getByText("Bestanden")).toBeInTheDocument();
    expect(countdown).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(container.querySelector(".votekick-tally")).toBeNull();
  });

  it("defaults and validates the overlay config and exposes localized editor controls", () => {
    expect(votekickOverlayElement.defaultConfig).toEqual({ showCountdown: true, hideAfterCloseSeconds: 15 });
    expect(votekickOverlayElement.parseConfig({})).toEqual({ showCountdown: true, hideAfterCloseSeconds: 15 });
    expect(votekickOverlayElement.parseConfig({ hideAfterCloseSeconds: 121 })).toBeNull();
    const onChange = vi.fn<(config: JsonObject) => void>();
    render(<VotekickOverlayEditor config={{ showCountdown: true, hideAfterCloseSeconds: 15 }} onChange={onChange} language="en" />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Show countdown" }));
    expect(onChange).toHaveBeenLastCalledWith({ showCountdown: false, hideAfterCloseSeconds: 15 });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Hide results after (seconds)" }), { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith({ showCountdown: true, hideAfterCloseSeconds: 30 });
  });
});
