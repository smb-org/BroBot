import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayMarquee } from "../../src/overlay/OverlayMarquee";

const widths = { box: 200, text: 200 };
let observerCallbacks: Array<() => void> = [];

const stubMotion = (reduced: boolean): void => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("reduce"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
};

describe("OverlayMarquee", () => {
  beforeEach(() => {
    observerCallbacks = [];
    widths.box = 200;
    widths.text = 200;
    // jsdom has no layout: the box and its text report the widths set by each test.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("overlay-marquee") ? widths.box : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("overlay-marquee__text") ? widths.text : 0; },
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observerCallbacks.push(callback); }
      observe(): void { /* measured through the captured callback */ }
      disconnect(): void { /* nothing to release */ }
    });
    stubMotion(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  });

  it("stays static when the text fits", () => {
    const { container } = render(<OverlayMarquee text="Short" />);
    const text = container.querySelector<HTMLElement>(".overlay-marquee__text");
    expect(text?.dataset.scrolling).toBe("false");
    expect(text?.style.animationName).toBe("");
    expect(container.querySelector("style")).toBeNull();
  });

  it("sets the distance and the duration for a constant speed when the text overflows", () => {
    widths.text = 440;
    const { container } = render(<OverlayMarquee text="A very long label that does not fit" />);
    const text = container.querySelector<HTMLElement>(".overlay-marquee__text");
    expect(text?.dataset.scrolling).toBe("true");
    expect(text?.style.getPropertyValue("--overlay-marquee-distance")).toBe("240px");
    // 240 px at 40 px/s is 6 s each way, plus 2 s of rest at both ends: 16 s per cycle.
    expect(text?.style.getPropertyValue("--overlay-marquee-duration")).toBe("16.00s");
    const keyframes = container.querySelector("style")?.textContent ?? "";
    expect(keyframes).toContain("12.500%");
    expect(keyframes).toContain("62.500%");
  });

  it("re-measures when the box size changes", () => {
    widths.text = 440;
    const { container } = render(<OverlayMarquee text="A very long label that does not fit" />);
    expect(container.querySelector<HTMLElement>(".overlay-marquee__text")?.dataset.scrolling).toBe("true");
    widths.box = 500;
    act(() => { for (const callback of observerCallbacks) callback(); });
    expect(container.querySelector<HTMLElement>(".overlay-marquee__text")?.dataset.scrolling).toBe("false");
  });

  it("falls back to the static ellipsis under reduced motion", () => {
    stubMotion(true);
    widths.text = 440;
    const { container } = render(<OverlayMarquee text="A very long label that does not fit" />);
    const text = container.querySelector<HTMLElement>(".overlay-marquee__text");
    expect(text?.dataset.scrolling).toBe("false");
    expect(container.querySelector("style")).toBeNull();
  });
});
