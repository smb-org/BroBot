import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SunSettings } from "../../src/modules/sun/contracts";
import { UiProvider } from "../../src/dashboard/ui";

const service = vi.hoisted(() => ({
  fetchSunSettings: vi.fn(),
  saveSunSettings: vi.fn(),
  searchSunLocations: vi.fn(),
}));

vi.mock("../../src/modules/sun/panel/service", () => service);

import SunLocationSettings from "../../src/modules/sun/panel/location-settings";

afterEach(() => vi.clearAllMocks());

describe("sun channel settings", () => {
  it("shows operators one reason above a read-only properties list", async () => {
    const settings: SunSettings = {
      location: { name: "Tromsø, Norway", latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo" },
      errorTexts: { de: "Eigener deutscher Fehler", en: "Custom English fallback" },
      revision: 3,
      nextRefreshAt: "2026-12-21T23:15:00.000Z",
    };
    service.fetchSunSettings.mockResolvedValue(settings);

    const { container } = render(
      <UiProvider>
        <SunLocationSettings
          channelId="sun-channel"
          language="en"
          canManage={false}
          readOnlyReason="Only managers can edit these settings."
          channelTimeZone="Europe/Berlin"
          saveChannelTimeZone={vi.fn().mockResolvedValue({ timeZone: "Europe/Oslo", revision: 2 })}
        />
      </UiProvider>,
    );

    expect(await screen.findByText("Only managers can edit these settings.")).toBeInTheDocument();
    expect(screen.getAllByText("Only managers can edit these settings.")).toHaveLength(1);
    expect(screen.getByText("Tromsø, Norway")).toBeInTheDocument();
    expect(screen.getByText("69.6492, 18.9553 · Europe/Oslo")).toBeInTheDocument();
    expect(screen.getByText("Eigener deutscher Fehler")).toBeInTheDocument();
    expect(screen.getByText("Custom English fallback")).toBeInTheDocument();
    expect(container.querySelector("dl.properties")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
