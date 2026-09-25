import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { moduleChunkEvaluated } = vi.hoisted(() => ({ moduleChunkEvaluated: vi.fn() }));

vi.mock("../../src/modules/ads/overlay/countdown", async (importOriginal) => {
  moduleChunkEvaluated();
  return await importOriginal();
});

import { OverlayCanvas } from "../../src/overlay/canvas";

const overlay = (element?: Record<string, unknown>) => ({
  id: "overlay-a",
  revision: 1,
  width: 1280,
  height: 720,
  css: "",
  elements: element === undefined ? [] : [{
    id: "countdown-a",
    kind: "ads.countdown",
    label: "Werbung",
    variableName: null,
    text: "",
    config: {},
    state: {
      nextAdAt: "2026-09-25T12:00:10.000Z", duration: 90, snoozeCount: 2, snoozeRefreshAt: null,
      serverNow: "2026-09-25T12:00:00.000Z",
    },
    moduleEnabled: true,
    x: 0,
    y: 0,
    scalePercent: 100,
    z: 0,
    inComposition: true,
    ...element,
  }],
});

describe("lazy module overlay rendering", () => {
  afterEach(() => {
    cleanup();
    moduleChunkEvaluated.mockClear();
  });

  it("does not request a module chunk for a disabled element", () => {
    render(<OverlayCanvas
      overlay={overlay({ moduleEnabled: false, state: null })}
      language="en"
      variables={{}}
      elementId={null}
    />);

    expect(document.querySelector('[data-element="countdown-a"]')).toBeNull();
    expect(moduleChunkEvaluated).not.toHaveBeenCalled();
  });

  it("does not request a module chunk when the composition has no module element", () => {
    render(<OverlayCanvas overlay={overlay()} language="en" variables={{}} elementId={null} />);

    expect(document.querySelector(".brobot-overlay")?.childElementCount).toBe(0);
    expect(moduleChunkEvaluated).not.toHaveBeenCalled();
  });

  it("loads a module chunk only when the enabled element is present", async () => {
    render(<OverlayCanvas overlay={overlay({ state: {
      nextAdAt: new Date(Date.now() + 20_000).toISOString(),
      duration: 90,
      snoozeCount: 2,
      snoozeRefreshAt: null,
      serverNow: new Date().toISOString(),
    } })} language="en" variables={{}} elementId={null} />);

    expect(await screen.findByText(/^Ad in 0:20$/u)).toBeInTheDocument();
    expect(moduleChunkEvaluated).toHaveBeenCalledTimes(1);
  });
});
