import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayStatusView } from "../../src/overlay/status";

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

  it("setzt die Overlay-Sprache aus dem Kanalstatus statt aus dem Browser", async () => {
    setBrowserLanguage("en-US");
    window.history.replaceState(null, "", "/overlay#token=kanal-token");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ version: "laufend", language: "de" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))));

    render(<OverlayStatusView />);

    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
  });
});
