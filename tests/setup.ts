import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  // Most component tests exercise the desktop side-by-side inspector layout.
  // Narrow-screen modal behavior is covered by tests that set this explicitly.
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  });

  // jsdom doesn't implement ResizeObserver; floating UI primitives observe with it.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class NoopResizeObserver implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver;
  }

  // jsdom does no real layout, so Floating UI's `hide` middleware always
  // finds a Popover/Combobox/Select dropdown's reference "clipped" and
  // renders it `display: none` -- present in the DOM, but invisible to an
  // ordinary `getByRole` query. Rather than fight Floating UI's geometry
  // in an environment with no geometry, queries into an open Select's
  // option list pass `{ hidden: true }`.
  Element.prototype.scrollIntoView = () => {};

  // jsdom doesn't implement matchMedia. Reporting reduced motion as matched
  // makes modal transitions skip timers after a test environment is torn down.
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: query === "(prefers-reduced-motion: reduce)" || query === "(max-width: 768px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
