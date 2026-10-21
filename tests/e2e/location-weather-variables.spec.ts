import { expect, test, type Page } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const CHANNEL_ID = "location-weather-variables-506";
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
const location = { name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
const settings = (savedLocation: typeof location | null) => ({
  timeZone: "Europe/Berlin",
  revision: 1,
  location: savedLocation,
  locationRevision: 1,
  defaultChatTarget: "source_only",
  defaultChatTargetRevision: 1,
});

const weather = {
  status: "ok",
  location: { name: "Berlin, Berlin, Deutschland", timeZone: "Europe/Berlin" },
  weather: {
    temperatureC: 18.4,
    feelsLikeC: 17.8,
    condition: "partly_cloudy",
    isDay: true,
    windSpeedMps: 3.3,
    precipitationMm: 0,
    humidityPercent: 64,
    observedAt: "2026-10-21T11:30:00.000Z",
    shortForecast: "rain",
  },
  expiresAt: "2026-10-21T12:10:00.000Z",
  showFahrenheit: false,
};
const sun = {
  status: "ok",
  day: {
    localDate: "2026-10-21",
    sunriseAt: "2026-10-21T05:18:00.000Z",
    sunsetAt: "2026-10-21T17:52:00.000Z",
    dawnAt: "2026-10-21T04:10:00.000Z",
    duskAt: "2026-10-21T19:05:00.000Z",
    solarNoonAt: "2026-10-21T11:35:00.000Z",
    dayLengthMinutes: 754,
    polarState: "normal",
  },
  goldenHourIntervals: [{ startAt: "2026-10-21T15:40:00.000Z", endAt: "2026-10-21T16:28:00.000Z" }],
  blueHourIntervals: [{ startAt: "2026-10-21T17:52:00.000Z", endAt: "2026-10-21T18:35:00.000Z" }],
};
const moon = {
  status: "ok",
  phase: "waxing_gibbous",
  illumination: 74,
  riseAt: "2026-10-21T18:42:00.000Z",
  setAt: "2026-10-21T06:15:00.000Z",
  nextRiseAt: "2026-10-21T18:42:00.000Z",
  state: "normal",
};

const installLocationMocks = async (page: Parameters<typeof installLiveCockpitMocks>[0], savedLocation: typeof location | null): Promise<void> => {
  await installLiveCockpitMocks(page, { channelId: CHANNEL_ID, location: savedLocation });
  await page.route(`**/api/channels/${CHANNEL_ID}/settings`, (route) => route.fulfill(json(settings(savedLocation))));
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/weather/current`, (route) => route.fulfill(json(weather)));
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/sun/today`, (route) => route.fulfill(json(sun)));
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/moon/today`, (route) => route.fulfill(json(moon)));
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/text_commands/commands`, (route) => route.fulfill(json({ commands: [], variables: [] })));
};

const expectNoHorizontalOverflow = async (page: Parameters<typeof installLiveCockpitMocks>[0]): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};

interface LiveLayoutSnapshot {
  cardHeights: number[];
  referenceY: number;
}

const liveCardSelectors = [".channel-location-weather-card", ".channel-location-sun-card", ".channel-location-moon-card"];

const captureLiveLayout = async (page: Page): Promise<LiveLayoutSnapshot> => {
  const boxes = await Promise.all(liveCardSelectors.map((selector) => page.locator(selector).boundingBox()));
  const reference = await page.locator(".channel-location-reference-column").boundingBox();
  if (boxes.some((box) => box === null) || reference === null) throw new Error("The live cards and reference section must have layout boxes.");
  return {
    cardHeights: boxes.map((box) => (box as NonNullable<typeof box>).height),
    referenceY: reference.y,
  };
};

const expectSameLiveLayout = (baseline: LiveLayoutSnapshot, actual: LiveLayoutSnapshot): void => {
  expect(actual.cardHeights).toHaveLength(3);
  for (const [index, height] of actual.cardHeights.entries()) {
    expect(Math.abs(height - (baseline.cardHeights[index] ?? 0))).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(actual.referenceY - baseline.referenceY)).toBeLessThanOrEqual(1);
};

const verifyLocationLayoutTransitions = async (page: Page, viewport: { width: number; height: number }): Promise<void> => {
  await page.clock.install({ time: new Date("2026-10-21T12:00:00.000Z") });
  await page.setViewportSize(viewport);
  await installLiveCockpitMocks(page, { channelId: CHANNEL_ID, location: null });

  let currentSettings = settings(null);
  let releaseSettings!: () => void;
  const settingsReady = new Promise<void>((resolve) => { releaseSettings = resolve; });
  await page.route(`**/api/channels/${CHANNEL_ID}/settings`, async (route) => {
    await settingsReady;
    await route.fulfill(json(currentSettings));
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/settings/location/geocode**`, (route) => route.fulfill(json({ results: [
    { name: "Berlin", admin1: "Berlin", country: "Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
  ] })));
  await page.route(`**/api/channels/${CHANNEL_ID}/settings/location`, async (route) => {
    const body = route.request().postDataJSON() as { location: typeof location | null };
    currentSettings = { ...currentSettings, location: body.location, locationRevision: currentSettings.locationRevision + 1 };
    await route.fulfill(json({ ok: true, location: currentSettings.location, locationRevision: currentSettings.locationRevision }));
  });

  let responseMode: "pending" | "success" | "error" = "pending";
  let releaseLiveData!: () => void;
  const liveDataReady = new Promise<void>((resolve) => { releaseLiveData = resolve; });
  let liveDataRequestCount = 0;
  for (const [moduleId, payload] of [["weather", weather], ["sun", sun], ["moon", moon]] as const) {
    await page.route(`**/api/channels/${CHANNEL_ID}/modules/${moduleId}/${moduleId === "weather" ? "current" : "today"}`, async (route) => {
      liveDataRequestCount += 1;
      if (responseMode === "pending") await liveDataReady;
      if (responseMode === "error") return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
      return route.fulfill(json(payload));
    });
  }
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/text_commands/commands`, (route) => route.fulfill(json({ commands: [], variables: [] })));

  await page.goto(`/channels/${CHANNEL_ID}/location-weather`);
  const cards = liveCardSelectors.map((selector) => page.locator(selector));
  for (const card of cards) await expect(card).toHaveAttribute("aria-busy", "true");
  const loadingLayout = await captureLiveLayout(page);

  releaseSettings();
  await expect(page.getByRole("link", { name: "Standort festlegen" }).first()).toBeVisible();
  const missingLayout = await captureLiveLayout(page);
  expectSameLiveLayout(loadingLayout, missingLayout);

  await page.getByRole("button", { name: "Standort ändern" }).click();
  await page.getByRole("textbox", { name: "Ort suchen" }).fill("Berlin");
  await page.getByRole("button", { name: "Suchen" }).click();
  await page.getByRole("option", { name: /Berlin/u }).click();
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
  const locationSaved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/channels/${CHANNEL_ID}/settings/location`) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await locationSaved;
  for (const card of cards) await expect(card).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => liveDataRequestCount).toBeGreaterThanOrEqual(3);
  const populatedLoadingLayout = await captureLiveLayout(page);
  expectSameLiveLayout(loadingLayout, populatedLoadingLayout);

  responseMode = "success";
  releaseLiveData();
  await expect(page.getByText("18,4 °C")).toBeVisible();
  await expect(page.getByText("Sonne heute")).toBeVisible();
  await expect(page.getByText("74 % beleuchtet")).toBeVisible();
  const populatedLayout = await captureLiveLayout(page);
  expectSameLiveLayout(loadingLayout, populatedLayout);
  await expectNoHorizontalOverflow(page);

  responseMode = "error";
  await page.clock.fastForward(5 * 60 * 1_000);
  await expect.poll(() => liveDataRequestCount).toBeGreaterThan(3);
  await expect(page.getByText("Daten konnten nicht geladen werden.").first()).toBeVisible();
  const errorLayout = await captureLiveLayout(page);
  expectSameLiveLayout(loadingLayout, errorLayout);

  responseMode = "success";
  await page.clock.fastForward(5 * 60 * 1_000);
  await expect(page.getByText("Daten konnten nicht geladen werden.").first()).toHaveCount(0);
  const recoveredLayout = await captureLiveLayout(page);
  expectSameLiveLayout(loadingLayout, recoveredLayout);
  await expectNoHorizontalOverflow(page);
};

test("location page shows live weather, sun and moon at desktop and mobile widths", async ({ page }) => {
  await installLocationMocks(page, location);
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${CHANNEL_ID}/location-weather`);
    await expect(page.getByText("18,4 °C")).toBeVisible();
    await expect(page.getByText("Sonne heute")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mond" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("location page shows the missing-location state at desktop and mobile widths", async ({ page }) => {
  await installLocationMocks(page, null);
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${CHANNEL_ID}/location-weather`);
    await expect(page.getByRole("link", { name: "Standort festlegen" }).first()).toBeVisible();
    await expect(page.getByText("Standort fehlt").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("variables page filters own and module variables", async ({ page }) => {
  await installLiveCockpitMocks(page, { channelId: CHANNEL_ID });
  await page.route(`**/api/channels/${CHANNEL_ID}/variables`, (route) => route.fulfill(json({
    variables: [{
      channelId: CHANNEL_ID,
      name: "score",
      value: 1234,
      description: "Punktestand",
      resetOnStreamStart: true,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
      usages: [],
    }],
    count: 1,
    maximum: 25,
  })));
  await page.route(`**/api/channels/${CHANNEL_ID}/template-variables`, (route) => route.fulfill(json({ variables: [
    { name: "weather.temp", moduleId: "weather", isTextBlock: false, sample: "18.4 °C", maxLength: 100,
      picker: { de: { label: "Temperatur", description: "Aktuelle Temperatur am Kanalstandort.", sample: "18,4 °C" }, en: { label: "Temperature", description: "Current temperature at the channel location.", sample: "18.4 °C" } } },
  ] })));
  await page.route(`**/api/channels/${CHANNEL_ID}/overlay-tokens**`, (route) => route.fulfill(json({ tokens: [], nextOffset: null })));

  await page.goto(`/channels/${CHANNEL_ID}/variables`);
  await expect(page.getByRole("row", { name: /weather\.temp/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /var\.score/u })).toBeVisible();

  await page.getByRole("button", { name: "Module" }).click();
  await expect(page.getByRole("row", { name: /weather\.temp/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /var\.score/u })).toHaveCount(0);
  await page.getByRole("button", { name: "Eigene" }).click();
  await expect(page.getByRole("row", { name: /var\.score/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /weather\.temp/u })).toHaveCount(0);
});

test("live card heights and the section below stay fixed through every location state at 1920px", async ({ page }) => {
  await verifyLocationLayoutTransitions(page, { width: 1920, height: 1080 });
});

test("live card heights and the section below stay fixed through every location state at 390px", async ({ page }) => {
  await verifyLocationLayoutTransitions(page, { width: 390, height: 844 });
});
