import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const CHANNEL_ID = "location-weather-variables-506";
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
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

test("reference content below live cards stays in place when live data resolves", async ({ page }) => {
  await installLiveCockpitMocks(page, { channelId: CHANNEL_ID, location });
  let releaseLiveData!: () => void;
  const liveData = new Promise<void>((resolve) => { releaseLiveData = resolve; });
  await page.route(`**/api/channels/${CHANNEL_ID}/settings`, (route) => route.fulfill(json(settings(location))));
  for (const [moduleId, payload] of [["weather", weather], ["sun", sun], ["moon", moon]] as const) {
    await page.route(`**/api/channels/${CHANNEL_ID}/modules/${moduleId}/${moduleId === "weather" ? "current" : "today"}`, async (route) => {
      await liveData;
      await route.fulfill(json(payload));
    });
  }
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/text_commands/commands`, (route) => route.fulfill(json({ commands: [], variables: [] })));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${CHANNEL_ID}/location-weather`);
  const reference = page.locator(".channel-location-reference-column");
  await expect(reference).toBeVisible();
  const before = await reference.boundingBox();
  expect(before).not.toBeNull();

  releaseLiveData();
  await expect(page.getByText("18,4 °C")).toBeVisible();
  const after = await reference.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.y).toBe(before?.y);
});
