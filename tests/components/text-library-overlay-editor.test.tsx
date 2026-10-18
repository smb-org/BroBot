import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TextBlockOverlayEditor from "../../src/modules/text_library/overlay/editor";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Text library overlay editor layout slots", () => {
  it("reserves the status and preview boxes", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/blocks/sample")) return Promise.resolve(jsonResponse({ block: { variants: [{ conditions: {}, texts: ["A long preview message"] }] } }));
      return Promise.resolve(jsonResponse({ blocks: [{ name: "sample" }] }));
    }));

    render(<UiProvider><TextBlockOverlayEditor config={{ blockName: "sample" }} onChange={vi.fn()} channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByTestId("overlay-editor-status-slot")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-editor-preview-slot")).toBeInTheDocument();
  });
});
