import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
}
