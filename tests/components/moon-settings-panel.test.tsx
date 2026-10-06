import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import MoonSettingsPanel from "../../src/modules/moon/panel/settings";

const mocks = vi.hoisted(() => ({ fetchMoonSettings: vi.fn(), saveMoonSettings: vi.fn() }));
vi.mock("../../src/modules/moon/panel/service", () => mocks);

describe("moon settings panel", () => {
  beforeEach(() => {
    mocks.fetchMoonSettings.mockReset().mockResolvedValue({ errorTexts: { de: "", en: "" }, revision: 1 });
    mocks.saveMoonSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("keeps the read-only reason in a reserved form slot", async () => {
    render(<UiProvider><MoonSettingsPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(await screen.findByTestId("moon-settings-permission-slot")).toBeInTheDocument();
  });
});
