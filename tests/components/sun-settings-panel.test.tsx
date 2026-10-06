import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import SunSettingsPanel from "../../src/modules/sun/panel/settings";

const mocks = vi.hoisted(() => ({ fetchSunSettings: vi.fn(), saveSunSettings: vi.fn() }));
vi.mock("../../src/modules/sun/panel/service", () => mocks);

describe("sun settings panel", () => {
  beforeEach(() => {
    mocks.fetchSunSettings.mockReset().mockResolvedValue({ errorTexts: { de: "", en: "" }, revision: 1 });
    mocks.saveSunSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("keeps the read-only reason in a reserved form slot", async () => {
    render(<UiProvider><SunSettingsPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(await screen.findByTestId("sun-settings-permission-slot")).toBeInTheDocument();
  });
});
