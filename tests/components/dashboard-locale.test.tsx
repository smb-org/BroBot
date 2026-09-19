import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";

describe("Panel-Dokumentensprache", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("setzt lang passend zur gewählten Browsersprache", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ channels: [] })))));

    render(<DashboardApp />);

    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });
});
