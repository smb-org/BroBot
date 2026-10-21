import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelChannelSettings } from "../../src/dashboard/api";
import { ChannelLocationLiveCards } from "../../src/dashboard/ChannelLocationLive";
import { ChannelLocationPage } from "../../src/dashboard/ChannelLocationPage";
import { channelSettingsTexts } from "../../src/dashboard/channel-settings-locale";
import { queryKeys } from "../../src/dashboard/data/keys";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const settings: PanelChannelSettings = {
  timeZone: "Europe/Berlin",
  revision: 1,
  location: null,
  locationRevision: 1,
  defaultChatTarget: "source_only",
  defaultChatTargetRevision: 1,
};

const inputUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

const renderPage = (role: "manager" | "operator" = "manager") => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(settings))));
  return renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role={role} /></UiProvider>);
};

const berlinSettings: PanelChannelSettings = {
  ...settings,
  location: { name: "Berlin", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
};

const liveWeather = {
  status: "ok",
  location: { name: "Berlin", timeZone: "Europe/Berlin" },
  weather: {
    temperatureC: 18.4, feelsLikeC: 17.8, condition: "partly_cloudy", isDay: true, windSpeedMps: 3.3,
    precipitationMm: 0, humidityPercent: 64, observedAt: "2026-10-21T11:30:00.000Z", shortForecast: "rain",
  },
  expiresAt: "2026-10-21T12:10:00.000Z",
  showFahrenheit: false,
};

const liveSun = {
  status: "ok",
  day: {
    localDate: "2026-10-21", sunriseAt: "2026-10-21T05:18:00.000Z", sunsetAt: "2026-10-21T17:52:00.000Z",
    dawnAt: "2026-10-21T04:10:00.000Z", duskAt: "2026-10-21T19:05:00.000Z",
    solarNoonAt: "2026-10-21T11:35:00.000Z", dayLengthMinutes: 754, polarState: "normal",
  },
  goldenHourIntervals: [{ startAt: "2026-10-21T15:40:00.000Z", endAt: "2026-10-21T16:28:00.000Z" }],
  blueHourIntervals: [{ startAt: "2026-10-21T17:52:00.000Z", endAt: "2026-10-21T18:35:00.000Z" }],
};

const liveMoon = {
  status: "ok", phase: "waxing_gibbous", illumination: 74,
  riseAt: "2026-10-21T18:42:00.000Z", setAt: "2026-10-21T06:15:00.000Z", nextRiseAt: "2026-10-21T18:42:00.000Z", state: "normal",
};

const livePageFetcher = (overrides: Record<string, unknown> = {}) => vi.fn<typeof fetch>((input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const pathname = url.pathname;
  if (pathname.endsWith("/settings")) return Promise.resolve(jsonResponse(berlinSettings));
  if (pathname.endsWith("/modules/weather/current")) return Promise.resolve(jsonResponse(overrides.weather ?? liveWeather));
  if (pathname.endsWith("/modules/sun/today")) return Promise.resolve(jsonResponse(overrides.sun ?? liveSun));
  if (pathname.endsWith("/modules/moon/today")) return Promise.resolve(jsonResponse(overrides.moon ?? liveMoon));
  if (pathname.endsWith("/modules/text_commands/commands")) return Promise.resolve(jsonResponse({ commands: overrides.commands ?? [], variables: [] }));
  return Promise.resolve(jsonResponse({}, 404));
});

describe("channel location page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setBrowserLanguage("de-DE");
  });

  it("shows the channel time zone and a missing-location warning together", async () => {
    const labels = channelSettingsTexts("de");
    renderPage();

    expect(await screen.findByRole("heading", { name: labels.pageTitle })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: labels.timeZone })).toHaveValue("Europe/Berlin");
    expect(screen.getAllByText("Standort fehlt").length).toBeGreaterThan(0);
  });

  it("shows read-only time-zone properties and one reason for disabled location actions to operators", async () => {
    const labels = channelSettingsTexts("de");
    const { container } = renderPage("operator");

    await waitFor(() => expect(container.querySelector(".channel-location-field")).toHaveAttribute("aria-busy", "false"));
    const locationChange = await screen.findByRole("button", { name: labels.locationChange });
    expect(screen.queryByRole("combobox", { name: labels.timeZone })).not.toBeInTheDocument();
    expect(screen.getByText("Europe/Berlin")).toBeInTheDocument();
    expect(locationChange).toBeDisabled();
    expect(screen.getAllByText(labels.readOnly)).toHaveLength(1);
  });

  it("keeps the location rows shared across loading, missing, and set states", async () => {
    const labels = channelSettingsTexts("de");
    let resolveSettings!: (response: Response) => void;
    const settingsResponse = new Promise<Response>((resolve) => { resolveSettings = resolve; });
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      return url.pathname.endsWith("/settings") ? settingsResponse : Promise.resolve(jsonResponse({ commands: [], variables: [] }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { container, queryClient } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);
    const getRows = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(
      ".channel-location-field__status, .channel-location-field__details, .channel-location-field__actions",
    ));

    expect(getRows()).toHaveLength(3);
    expect(container.querySelectorAll(".channel-location-field__skeleton")).toHaveLength(2);
    expect(screen.getByRole("button", { name: labels.locationChange })).toBeDisabled();
    expect(container.querySelector(".channel-location-page__location-sizing")).toBeNull();
    expect(container.querySelector(".channel-location-page__warning--reserved")).toBeNull();

    resolveSettings(jsonResponse(settings));
    await waitFor(() => expect(container.querySelector(".channel-location-field")).toHaveAttribute("aria-busy", "false"));
    expect(container.querySelector(".channel-location-field__status")).toHaveTextContent(labels.locationMissing);
    expect(container.querySelectorAll(".channel-location-field__skeleton")).toHaveLength(0);
    expect(screen.getByRole("button", { name: labels.locationChange })).toBeEnabled();
    expect(screen.getByRole("button", { name: labels.locationRemove })).toBeDisabled();
    expect(getRows()).toHaveLength(3);

    queryClient.setQueryData(queryKeys.channel("channel-a", "settings"), berlinSettings);
    await waitFor(() => expect(container.querySelector(".channel-location-field__status")).toHaveTextContent("Berlin"));
    expect(screen.getByText("52.52, 13.40 · Europe/Berlin", { selector: ".channel-location-field__details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: labels.locationRemove })).toBeEnabled();
    expect(getRows()).toHaveLength(3);
    expect(container.querySelector("[aria-hidden='true'].channel-location-field")).toBeNull();
  });

  it("keeps a time zone change as a draft until the page save is pressed", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/settings") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(settings));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/settings") && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ok: true, timeZone: "Europe/Paris", revision: 2 }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    const timeZone = await screen.findByRole("combobox", { name: "Kanalzeitzone" });
    fireEvent.change(timeZone, { target: { value: "Europe/Paris" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Paris", hidden: true }));

    expect(fetcher.mock.calls.some(([input, init]) => inputUrl(input).endsWith("/settings") && init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => {
      const call = fetcher.mock.calls.find(([input, init]) => inputUrl(input).endsWith("/settings") && init?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ revision: 1, timeZone: "Europe/Paris" }) });
    });
    expect(await screen.findByRole("combobox", { name: "Kanalzeitzone" })).toHaveValue("Europe/Paris");
  });

  it("preserves a time zone draft and requires reload after a remote revision", async () => {
    const { queryClient } = renderPage();
    const timeZone = await screen.findByRole("combobox", { name: "Kanalzeitzone" });
    fireEvent.change(timeZone, { target: { value: "Europe/Paris" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Paris", hidden: true }));

    queryClient.setQueryData<PanelChannelSettings>(queryKeys.channel("channel-a", "settings"), {
      ...settings,
      revision: 2,
      timeZone: "Europe/Rome",
    });

    expect(timeZone).toHaveValue("Europe/Paris");
    fireEvent.change(timeZone, { target: { value: "Europe/Amsterdam" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Amsterdam", hidden: true }));
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((status) => status.textContent.includes("Die Einstellungen wurden zwischenzeitlich geändert."))).toBe(true);
      expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled();
    });
  });

  it("keeps the live weather card structure while values are loading", async () => {
    let resolveWeather!: (response: Response) => void;
    const pendingWeather = new Promise<Response>((resolve) => { resolveWeather = resolve; });
    const fetcher = livePageFetcher();
    fetcher.mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse(berlinSettings));
      if (url.pathname.endsWith("/modules/weather/current")) return pendingWeather;
      if (url.pathname.endsWith("/modules/sun/today")) return Promise.resolve(jsonResponse(liveSun));
      if (url.pathname.endsWith("/modules/moon/today")) return Promise.resolve(jsonResponse(liveMoon));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    await waitFor(() => {
      const card = container.querySelector(".channel-location-weather-card");
      expect(card).not.toBeNull();
      expect(card).toHaveAttribute("aria-busy", "true");
      expect(card?.querySelector(":scope > .channel-location-live-card__content")?.children).toHaveLength(4);
      expect(card?.querySelector(":scope > .channel-location-live-card__content")?.querySelectorAll(".channel-location-skeleton")).toHaveLength(6);
    });
    expect(await screen.findByRole("heading", { name: "Aktuelles Wetter" })).toBeInTheDocument();
    await waitFor(() => resolveWeather(jsonResponse(liveWeather)));
  });

  it("renders the same sun and moon event rows while values are loading", async () => {
    const fetcher = livePageFetcher();
    fetcher.mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse(berlinSettings));
      if (url.pathname.endsWith("/modules/weather/current") || url.pathname.endsWith("/modules/sun/today") || url.pathname.endsWith("/modules/moon/today")) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(jsonResponse({ commands: [], variables: [] }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    const sunCard = await waitFor(() => {
      const card = container.querySelector(".channel-location-sun-card");
      expect(card).toHaveAttribute("aria-busy", "true");
      return card;
    });
    const moonCard = container.querySelector(".channel-location-moon-card");
    expect(moonCard).toHaveAttribute("aria-busy", "true");
    expect(sunCard?.querySelector(".channel-location-live-card__content")?.querySelectorAll(".channel-location-sun-events > div")).toHaveLength(8);
    expect(moonCard?.querySelector(".channel-location-live-card__content")?.querySelectorAll(".channel-location-moon-events > div")).toHaveLength(3);
    expect(screen.getByText("Abenddämmerung").closest("div")?.querySelector(".channel-location-skeleton")).not.toBeNull();
    expect(screen.getByText("Tageslänge").closest("div")?.querySelector(".channel-location-skeleton")).not.toBeNull();
  });

  it("renders current weather, sun and moon values for a saved location", async () => {
    vi.stubGlobal("fetch", livePageFetcher());
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText("18,4 °C")).toBeInTheDocument();
    expect(screen.getByText(/13:30/u)).toBeInTheDocument();
    expect(await screen.findByText("Sonne heute")).toBeInTheDocument();
    expect((await screen.findAllByText("Mond")).length).toBeGreaterThan(0);
    expect(screen.getByText("74 % beleuchtet")).toBeInTheDocument();
    expect(screen.getByText("17:40–18:28")).toBeInTheDocument();
    expect(screen.getByText("19:52–20:35")).toBeInTheDocument();
    expect(container.querySelectorAll(".channel-location-sun-card > .channel-location-live-card__content .channel-location-sun-events > div")).toHaveLength(8);
    expect(container.querySelectorAll(".channel-location-moon-card > .channel-location-live-card__content .channel-location-moon-events > div")).toHaveLength(3);
    expect(container.querySelector(".channel-location-weather-card > .channel-location-live-card__content")?.children).toHaveLength(4);
    expect(container.querySelectorAll(".channel-location-weather-card > .channel-location-live-card__content .channel-location-skeleton")).toHaveLength(0);
    expect(screen.getByText("Abenddämmerung").closest("div")).toHaveTextContent("21:05");
    expect(screen.getByText("Tageslänge").closest("div")).toHaveTextContent("12 Std. 34 Min.");
  });

  it("shows loading cards after the saved-location revision changes while new data is delayed", async () => {
    let delayLiveResponses = false;
    const pendingResponse = new Promise<Response>(() => {});
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/modules/weather/current")) return delayLiveResponses ? pendingResponse : Promise.resolve(jsonResponse(liveWeather));
      if (url.pathname.endsWith("/modules/sun/today")) return delayLiveResponses ? pendingResponse : Promise.resolve(jsonResponse(liveSun));
      if (url.pathname.endsWith("/modules/moon/today")) return delayLiveResponses ? pendingResponse : Promise.resolve(jsonResponse(liveMoon));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { channelId: "channel-a", locationLoaded: true, hasLocation: true, timeZone: "Europe/Berlin" };
    const { container, rerender } = renderWithQuery(
      <UiProvider><ChannelLocationLiveCards {...props} locationRevision={1} /></UiProvider>,
    );

    expect(await screen.findByText("18,4 °C")).toBeInTheDocument();
    expect(await screen.findByText("74 % beleuchtet")).toBeInTheDocument();

    delayLiveResponses = true;
    rerender(<UiProvider><ChannelLocationLiveCards {...props} locationRevision={2} /></UiProvider>);

    await waitFor(() => {
      for (const selector of [".channel-location-weather-card", ".channel-location-sun-card", ".channel-location-moon-card"]) {
        expect(container.querySelector(selector)).toHaveAttribute("aria-busy", "true");
      }
    });
    expect(screen.queryByText("18,4 °C")).not.toBeInTheDocument();
    expect(screen.queryByText("74 % beleuchtet")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).includes("/modules/weather/current")).length).toBe(2);
    expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).includes("/modules/sun/today")).length).toBe(2);
    expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).includes("/modules/moon/today")).length).toBe(2);
  });

  it("keeps sun and moon status slots in place through refresh errors and recovery", async () => {
    let refreshFails = false;
    let weatherFails = false;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse(berlinSettings));
      if (url.pathname.endsWith("/modules/weather/current")) return Promise.resolve(jsonResponse(weatherFails
        ? { status: "provider_error", reason: "upstream_unavailable" }
        : liveWeather));
      if (url.pathname.endsWith("/modules/sun/today")) return Promise.resolve(refreshFails ? jsonResponse({}, 503) : jsonResponse(liveSun));
      if (url.pathname.endsWith("/modules/moon/today")) return Promise.resolve(refreshFails ? jsonResponse({}, 503) : jsonResponse(liveMoon));
      if (url.pathname.endsWith("/modules/text_commands/commands")) return Promise.resolve(jsonResponse({ commands: [], variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    const { container, queryClient } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    const sunSlot = await waitFor(() => {
      const slot = container.querySelector(".channel-location-sun-card > .channel-location-live-card__content .channel-location-live-status");
      expect(slot).not.toBeNull();
      return slot as HTMLElement;
    });
    const moonSlot = container.querySelector(".channel-location-moon-card > .channel-location-live-card__content .channel-location-live-status");
    const weatherSlot = container.querySelector(".channel-location-weather-card > .channel-location-live-card__content .channel-location-weather-card__footer > span:last-child");
    await waitFor(() => {
      expect(container.querySelector(".channel-location-weather-card")).toHaveAttribute("aria-busy", "false");
      expect(container.querySelector(".channel-location-sun-card")).toHaveAttribute("aria-busy", "false");
      expect(container.querySelector(".channel-location-moon-card")).toHaveAttribute("aria-busy", "false");
    });
    expect(moonSlot).not.toBeNull();
    expect(sunSlot).toBeEmptyDOMElement();
    expect(moonSlot).toBeEmptyDOMElement();
    expect(weatherSlot).toHaveTextContent("aktualisiert");

    const refreshModule = async (moduleId: "weather" | "sun" | "moon"): Promise<void> => {
      const query = queryClient.getQueryCache().getAll().find((candidate) => candidate.queryKey[3] === moduleId);
      if (query === undefined) throw new Error(`The ${moduleId} query is missing`);
      await queryClient.refetchQueries({ queryKey: query.queryKey, exact: true });
    };

    refreshFails = true;
    weatherFails = true;
    await act(async () => {
      await Promise.all([
        refreshModule("weather"),
        refreshModule("sun"),
        refreshModule("moon"),
      ]);
    });
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).endsWith("/weather/current")).length).toBe(2));
    expect(container.querySelector(".channel-location-weather-card > .channel-location-live-card__content .channel-location-weather-card__footer > span:last-child")).toBe(weatherSlot);
    expect(weatherSlot).toHaveTextContent("Wetterdienst gerade nicht erreichbar");
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).endsWith("/sun/today")).length).toBe(2));
    expect(container.querySelector(".channel-location-sun-card > .channel-location-live-card__content .channel-location-live-status")).toBe(sunSlot);
    expect(container.querySelector(".channel-location-moon-card > .channel-location-live-card__content .channel-location-live-status")).toBe(moonSlot);
    expect(sunSlot).toHaveTextContent("Daten konnten nicht geladen werden.");
    expect(moonSlot).toHaveTextContent("Daten konnten nicht geladen werden.");

    refreshFails = false;
    weatherFails = false;
    await act(async () => {
      await Promise.all([
        refreshModule("weather"),
        refreshModule("sun"),
        refreshModule("moon"),
      ]);
    });
    expect(container.querySelector(".channel-location-sun-card > .channel-location-live-card__content .channel-location-live-status")).toBe(sunSlot);
    expect(container.querySelector(".channel-location-moon-card > .channel-location-live-card__content .channel-location-live-status")).toBe(moonSlot);
    await waitFor(() => {
      expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).endsWith("/weather/current")).length).toBe(3);
      expect(fetcher.mock.calls.filter(([input]) => inputUrl(input).endsWith("/sun/today")).length).toBe(3);
      expect(sunSlot).toBeEmptyDOMElement();
      expect(moonSlot).toBeEmptyDOMElement();
      expect(weatherSlot).toHaveTextContent("aktualisiert");
    });
  });

  it("shows missing solar crossings safely during a polar day", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00.000Z"));
    vi.stubGlobal("fetch", livePageFetcher({
      sun: {
        ...liveSun,
        day: {
          ...liveSun.day,
          sunriseAt: null,
          sunsetAt: null,
          dawnAt: null,
          duskAt: null,
          dayLengthMinutes: null,
          polarState: "day",
        },
        goldenHourIntervals: [],
        blueHourIntervals: [],
        nextDawnAt: "2026-10-22T04:10:00.000Z",
      },
    }));
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText("Sonnenaufgang")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Sonnenaufgang").closest("div")).toHaveTextContent("—"));
    expect(screen.getByText("Sonnenaufgang").closest("div")).toHaveTextContent("—");
    expect(screen.getByText("Sonnenuntergang").closest("div")).toHaveTextContent("—");
    expect(screen.getByText("Polartag")).toBeInTheDocument();
    expect(parseFloat(container.querySelector(".channel-location-sun-arc__now")?.getAttribute("style")?.match(/--position: ([\d.]+)%/u)?.[1] ?? "50")).toBeCloseTo(58.3, 0);
    expect(container.querySelector(".channel-location-sun-card")).not.toHaveTextContent("Invalid Date");
  });

  it.each([
    ["de-DE", "Polarnacht"],
    ["en-US", "Polar night"],
  ])("shows explicit polar night text in %s", async (language, expected) => {
    setBrowserLanguage(language);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00.000Z"));
    vi.stubGlobal("fetch", livePageFetcher({
      sun: {
        ...liveSun,
        day: { ...liveSun.day, sunriseAt: null, sunsetAt: null, dawnAt: null, duskAt: null, dayLengthMinutes: null, polarState: "night" },
        goldenHourIntervals: [],
        blueHourIntervals: [],
        nextDawnAt: null,
      },
    }));
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(parseFloat(container.querySelector(".channel-location-sun-arc__now")?.getAttribute("style")?.match(/--position: ([\d.]+)%/u)?.[1] ?? "50")).toBeCloseTo(58.3, 0);
  });

  it("uses every golden and blue hour interval and summarizes the upcoming interval", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00.000Z"));
    vi.stubGlobal("fetch", livePageFetcher({
      sun: {
        ...liveSun,
        goldenHourIntervals: [
          { startAt: "2026-10-21T06:00:00.000Z", endAt: "2026-10-21T06:48:00.000Z" },
          { startAt: "2026-10-21T15:10:00.000Z", endAt: "2026-10-21T15:58:00.000Z" },
        ],
        blueHourIntervals: [
          { startAt: "2026-10-21T04:35:00.000Z", endAt: "2026-10-21T05:18:00.000Z" },
          { startAt: "2026-10-21T15:52:00.000Z", endAt: "2026-10-21T16:35:00.000Z" },
        ],
      },
    }));
    const { container } = renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText("17:10–17:58")).toBeInTheDocument();
    expect(screen.getByText("17:52–18:35")).toBeInTheDocument();
    expect(screen.getByText("Goldene Stunde in 3 Std. 10 Min.")).toBeInTheDocument();
    expect(container.querySelectorAll(".channel-location-sun-card > .channel-location-live-card__content .channel-location-sun-arc__point")).toHaveLength(9);
  });

  it("shows the location settings link in live cards when the saved location is missing", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse(settings));
      return Promise.resolve(jsonResponse({ status: "location_missing" }));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect((await screen.findAllByRole("link", { name: "Standort festlegen" })).length).toBe(3);
    expect(screen.getAllByText("Standort fehlt")).toHaveLength(1);
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".channel-location-live-empty"));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("Wetterdaten werden mit einem Kanalstandort angezeigt.");
    expect(cards[1]).toHaveTextContent("Sonnenzeiten werden mit einem Kanalstandort angezeigt.");
    expect(cards[2]).toHaveTextContent("Mondphase und Aufgangszeiten werden mit einem Kanalstandort angezeigt.");
    expect(cards.map((card) => card.querySelector("svg"))).not.toContain(null);
    expect(document.querySelector(".channel-location-weather-card")).not.toHaveTextContent("—");
    expect(document.querySelector(".channel-location-sun-card")).not.toHaveTextContent("—");
    expect(document.querySelector(".channel-location-moon-card")).not.toHaveTextContent("—");
  });

  it("keeps one stacked sizing layer for every live card through loading, ok, error, and missing states", async () => {
    let providerFails = false;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/weather/current")) return Promise.resolve(jsonResponse(providerFails
        ? { status: "provider_error", reason: "upstream_unavailable" }
        : liveWeather));
      if (url.pathname.endsWith("/sun/today")) return Promise.resolve(providerFails ? jsonResponse({}, 503) : jsonResponse(liveSun));
      if (url.pathname.endsWith("/moon/today")) return Promise.resolve(providerFails ? jsonResponse({}, 503) : jsonResponse(liveMoon));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { channelId: "channel-a", locationRevision: 1, timeZone: "Europe/Berlin" };
    const { container, queryClient, rerender } = renderWithQuery(
      <UiProvider><ChannelLocationLiveCards {...props} locationLoaded={false} hasLocation={false} /></UiProvider>,
    );
    const selectors = [".channel-location-weather-card", ".channel-location-sun-card", ".channel-location-moon-card"];
    const assertLayeredCards = (missing: boolean) => {
      const cards = selectors.map((selector) => container.querySelector<HTMLElement>(selector));
      expect(cards.every((card) => card !== null)).toBe(true);
      for (const card of cards) {
        expect(card).toHaveClass("channel-location-live-card");
        const reserve = card?.querySelector<HTMLElement>(":scope > .channel-location-live-card__reserve");
        expect(reserve).toHaveAttribute("aria-hidden", "true");
        expect(reserve).toHaveClass("channel-location-live-card__layer");
        const content = card?.querySelector<HTMLElement>(":scope > .channel-location-live-card__content");
        expect(content).toHaveClass("channel-location-live-card__layer");
        if (missing) expect(content).toHaveAttribute("aria-hidden", "true");
        else expect(content).not.toHaveAttribute("aria-hidden");
        expect(content).not.toBeNull();
        expect(Array.from(reserve?.children ?? []).map((child) => child.className))
          .toEqual(Array.from(content?.children ?? []).map((child) => child.className));
        const empty = card?.querySelector<HTMLElement>(":scope > .channel-location-live-card__empty");
        expect(empty !== null).toBe(missing);
        if (empty !== null && empty !== undefined) {
          expect(empty).toHaveClass("channel-location-live-card__layer");
        }
      }
      return cards.map((card) => ({
        card,
        reserve: card?.querySelector(":scope > .channel-location-live-card__reserve"),
        content: card?.querySelector(":scope > .channel-location-live-card__content"),
        rowStructure: Array.from(card?.querySelector<HTMLElement>(":scope > .channel-location-live-card__content")?.children ?? [])
          .map((child) => child.className),
      }));
    };

    const initialLayout = assertLayeredCards(false);
    rerender(<UiProvider><ChannelLocationLiveCards {...props} locationLoaded={true} hasLocation={true} /></UiProvider>);
    expect(await screen.findByText("18,4 °C")).toBeInTheDocument();
    expect(assertLayeredCards(false)).toEqual(initialLayout);

    providerFails = true;
    await act(async () => {
      await Promise.all(queryClient.getQueryCache().getAll().map((query) =>
        queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }),
      ));
    });
    await waitFor(() => expect(screen.getByText("Wetterdienst gerade nicht erreichbar")).toBeInTheDocument());
    expect(screen.getAllByText("Daten konnten nicht geladen werden.")).toHaveLength(2);
    expect(assertLayeredCards(false)).toEqual(initialLayout);

    rerender(<UiProvider><ChannelLocationLiveCards {...props} locationLoaded={true} hasLocation={false} /></UiProvider>);
    expect(await screen.findAllByRole("link", { name: "Standort festlegen" })).toHaveLength(3);
    expect(assertLayeredCards(true)).toEqual(initialLayout);
  });

  it.each([
    ["de-DE", "gerade aktualisiert"],
    ["en-US", "just updated"],
  ])("uses fresh-update wording in %s", async (language, expected) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", livePageFetcher({ weather: {
      ...liveWeather,
      weather: { ...liveWeather.weather, observedAt: new Date(Date.now() - 30_000).toISOString() },
    } }));
    renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText(new RegExp(expected, "u"))).toBeInTheDocument();
  });

  it("shows a readable weather provider error while keeping sun and moon available", async () => {
    vi.stubGlobal("fetch", livePageFetcher({ weather: { status: "provider_error", reason: "upstream_unavailable" } }));
    renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    expect(await screen.findByText("Wetterdienst gerade nicht erreichbar")).toBeInTheDocument();
    expect(await screen.findByText("Sonne heute")).toBeInTheDocument();
    expect((await screen.findAllByText("Mond")).length).toBeGreaterThan(0);
    expect(screen.getByText("74 % beleuchtet")).toBeInTheDocument();
    expect(document.querySelector(".channel-location-weather-card > .channel-location-live-card__content")?.children).toHaveLength(4);
    expect(document.querySelectorAll(".channel-location-weather-card .channel-location-skeleton").length).toBeGreaterThan(0);
  });

  it("matches a template command by alias and opens its canonical command", async () => {
    const onOpenCommand = vi.fn<(name: string) => void>();
    const onCreateCommand = vi.fn<(name: string, response: string) => void>();
    vi.stubGlobal("fetch", livePageFetcher({ commands: [{ name: "weather", aliases: ["WETTER"] }] }));
    renderWithQuery(<UiProvider><ChannelLocationPage
      channelId="channel-a"
      role="manager"
      onOpenCommand={onOpenCommand}
      onCreateCommand={onCreateCommand}
    /></UiProvider>);

    const commandList = await screen.findByText("!wetter");
    const commandCard = commandList.closest(".channel-location-command");
    expect(commandCard).not.toBeNull();
    expect(within(commandCard as HTMLElement).queryByRole("button", { name: "Anlegen" })).not.toBeInTheDocument();
    fireEvent.click(await within(commandCard as HTMLElement).findByRole("link", { name: "Vorhanden" }));
    expect(onOpenCommand).toHaveBeenCalledWith("weather");

    const createButtons = await screen.findAllByRole("button", { name: "Anlegen" });
    fireEvent.click(createButtons[0] as HTMLButtonElement);
    expect(onCreateCommand).toHaveBeenCalledWith("sonne", expect.stringContaining("{sun.rise}"));
  });
});
