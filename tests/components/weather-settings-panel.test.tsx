import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import WeatherSettingsPanel from "../../src/modules/weather/panel/settings";
import { renderWithQuery } from "../query-test-utils";

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
    renderWithQuery(<UiProvider><WeatherSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);

    expect(await screen.findByTestId("weather-provider-description-slot")).toBeInTheDocument();
  });

  it("shows cached provider settings immediately when reopened", async () => {
    mocks.fetchWeatherSettings.mockResolvedValue({
      provider: "open_meteo", showFahrenheit: true, errorTexts: { de: "Weather text", en: "" }, revision: 1,
    });
    function TogglePanel() {
      const [open, setOpen] = useState(true);
      return <UiProvider>
        <button onClick={() => setOpen((current) => !current)}>Toggle panel</button>
        {open ? <WeatherSettingsPanel channelId="channel-a" language="en" canManage /> : null}
      </UiProvider>;
    }
    renderWithQuery(<TogglePanel />, undefined, { gcTime: 600_000 });
    expect(await screen.findByDisplayValue("Weather text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));

    expect(screen.getByRole("textbox", { name: "German" })).toHaveValue("Weather text");
  });

  it("keeps an unsaved draft visible when a newer settings revision arrives", async () => {
    const view = renderWithQuery(<UiProvider><WeatherSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    const germanField = await screen.findByRole("textbox", { name: "German" });
    await waitFor(() => expect(germanField).toBeEnabled());
    fireEvent.change(germanField, { target: { value: "Unsaved weather text" } });

    act(() => {
      view.queryClient.setQueryData(moduleQueryKey("channel-a", "weather", "provider-settings"), {
        provider: "met_norway",
        showFahrenheit: false,
        errorTexts: { de: "Remote weather text", en: "" },
        revision: 2,
      });
    });

    expect(germanField).toHaveValue("Unsaved weather text");
    mocks.saveWeatherSettings.mockResolvedValue({
      provider: "met_norway", showFahrenheit: false, errorTexts: { de: "Unsaved weather text", en: "" }, revision: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.saveWeatherSettings).toHaveBeenCalledWith("channel-a", {
      provider: "met_norway",
      showFahrenheit: false,
      errorTexts: { de: "Unsaved weather text", en: "" },
      revision: 1,
    }));
  });

  it("retries a failed settings read", async () => {
    mocks.fetchWeatherSettings.mockRejectedValueOnce(new Error("offline"));
    renderWithQuery(<UiProvider><WeatherSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);

    expect(await screen.findByText("Weather settings could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry|erneut versuchen/iu }));

    expect(await screen.findByRole("textbox", { name: "German" })).toBeEnabled();
  });
});
