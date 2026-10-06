import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import ApiSourcePanel from "../../src/modules/api_source/panel";
import { jsonResponse } from "../unit/fixtures";

describe("API source panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the add-source editor in a dialog", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [] }))));
    render(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));

    expect(await screen.findByRole("dialog", { name: "Create source" })).toBeInTheDocument();
  });
});
