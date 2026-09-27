import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SunSettings } from "../../src/modules/sun/contracts";
import { UiProvider } from "../../src/dashboard/ui";

const service = vi.hoisted(() => ({
  fetchSunSettings: vi.fn(),
  saveSunSettings: vi.fn(),
}));

vi.mock("../../src/modules/sun/panel/service", () => service);

import SunSettingsPanel from "../../src/modules/sun/panel/settings";

afterEach(() => vi.clearAllMocks());

describe("sun channel settings", () => {
  it("shows operators the read-only error texts", async () => {
    const settings: SunSettings = {
      errorTexts: { de: "Eigener deutscher Fehler", en: "Custom English fallback" },
      revision: 3,
    };
    service.fetchSunSettings.mockResolvedValue(settings);

    const { container } = render(
      <UiProvider>
        <SunSettingsPanel
          channelId="sun-channel"
          language="en"
          canManage={false}
          readOnlyReason="Only managers can edit these settings."
        />
      </UiProvider>,
    );

    expect(await screen.findByText("Only managers can edit these settings.")).toBeInTheDocument();
    expect(screen.getAllByText("Only managers can edit these settings.")).toHaveLength(1);
    expect(screen.getByText("Eigener deutscher Fehler")).toBeInTheDocument();
    expect(screen.getByText("Custom English fallback")).toBeInTheDocument();
    expect(container.querySelector("dl.properties")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
