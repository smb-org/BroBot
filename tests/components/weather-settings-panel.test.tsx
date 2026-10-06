import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import WeatherSettingsPanel from "../../src/modules/weather/panel/settings";

const mocks = vi.hoisted(() => ({ fetchWeatherSettings: vi.fn(), saveWeatherSettings: vi.fn() }));
vi.mock("../../src/modules/weather/panel/service", () => mocks);

describe("weather settings panel", () => {
  beforeEach(() => {
    mocks.fetchWeatherSettings.mockReset().mockResolvedValue({
      provider: "met_norway", showFahrenheit: false, errorTexts: { de: "", en: "" }, revision: 1,
    });
    mocks.saveWeatherSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("reserves the provider description row before a provider description is selected", async () => {
    render(<UiProvider><WeatherSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);

    expect(await screen.findByTestId("weather-provider-description-slot")).toBeInTheDocument();
  });
});
