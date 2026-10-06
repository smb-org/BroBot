import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../unit/fixtures";
import TextLibraryPanel from "../../src/modules/text_library/panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Text library panel layout slots", () => {
  it("keeps the preview, warning, and usage areas mounted for an empty draft", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: "UTC", revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) return Promise.resolve(jsonResponse({ text: "", diagnostics: [] }));
      return Promise.resolve(jsonResponse({
        blocks: [],
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        settings: { revision: 1, graphRevision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        usages: {},
        reservedNames: [],
      }));
    }));

    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add text block" }));

    await waitFor(() => {
      expect(screen.getByTestId("text-library-preview-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-warning-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-usage-slot")).toBeInTheDocument();
    });
  });
});
