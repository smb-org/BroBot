import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

  // jsdom doesn't implement ResizeObserver; Mantine's `ScrollArea` (used
  // inside a `Select` dropdown, among others) observes with it.
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

  // jsdom doesn't implement matchMedia; Mantine's AppShell (navbar
  // breakpoint collapse) and Burger (`hiddenFrom`) both call it.
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
