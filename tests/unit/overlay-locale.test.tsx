import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayShell } from "../../src/overlay/shell";

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Overlay-Locale", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
    document.documentElement.lang = "de";
  });

  it("uses the channel language from the legacy bootstrap and keeps empty sources text-free", async () => {
    setBrowserLanguage("en-US");
    window.history.replaceState(null, "", "/overlay#token=legacy-token");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ language: "de", overlay: null, variables: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))));

    const { container } = render(<OverlayShell token="legacy-token" elementId={null} />);

    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
