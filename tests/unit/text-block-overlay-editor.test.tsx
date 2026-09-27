import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { previewStateFor } from "../../src/modules/text_library/overlay/preview-state";
import TextBlockOverlayElement from "../../src/modules/text_library/overlay/view";

describe("text block overlay editor preview", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps countdown tokens live against the editor's synthetic targets", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    vi.setSystemTime(now);
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const state = previewStateFor("Sunset in {sun.set_in}", { "sun.set_in": "sample" });
    const candidate = (state.candidates as readonly { text: string }[])[0];

    expect(candidate?.text).toBe("Sunset in {sun.set_in}");
    render(<TextBlockOverlayElement config={{}} state={state} now={now} language="en" />);
    expect(screen.getByText("Sunset in 2 hr")).toBeInTheDocument();

    monotonicNow += 60 * 60 * 1_000;
    act(() => { vi.advanceTimersByTime(60 * 60 * 1_000); });
    expect(screen.getByText("Sunset in 1 hr")).toBeInTheDocument();
  });
});
