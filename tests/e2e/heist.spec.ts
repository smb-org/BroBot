import { expect, test, type Page } from "@playwright/test";
import { heistSettingsForLanguage, type HeistSettings } from "../../src/modules/heist/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_heist_channel";
const settingsPath = `/api/channels/${channelId}/modules/heist/settings`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const installSettingsApi = async (page: Page, initial: HeistSettings) => {
  let settings = structuredClone(initial);
  let revision = 1;
  const saves: HeistSettings[] = [];
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json({ settings, revision, variables: [] }));
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { settings: HeistSettings };
    settings = structuredClone(body.settings);
    revision += 1;
    saves.push(settings);
    await route.fulfill(json({ settings, revision, warnings: [] }));
  });
  return { saves, savedSettings: () => settings };
};

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("chat commands button keeps its header spot with the save cluster one row below", async ({ page }) => {
  const settings = heistSettingsForLanguage("en");
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "heist", enabled: true, settings: JSON.stringify(settings) },
    ],
  });
  await installSettingsApi(page, settings);
  const box = async (locator: ReturnType<Page["locator"]>) => {
    const bounds = await locator.boundingBox();
    if (bounds === null) throw new Error("expected a visible element");
    return bounds;
  };

  for (const width of [390, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/channels/${channelId}/modules/heist?lang=en`);
    const header = page.locator(".settings-page > .page-header");
    const button = page.getByRole("button", { name: /^Chat commands/u });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    const headerBounds = await box(header);
    const buttonBounds = await box(button);
    const saveBounds = await box(page.locator(".page-header__save"));
    expect(saveBounds.y).toBeGreaterThanOrEqual(buttonBounds.y + buttonBounds.height);
    if (width > 768) {
      expect(buttonBounds.x + buttonBounds.width).toBeCloseTo(headerBounds.x + headerBounds.width, 0);
      expect(buttonBounds.y - headerBounds.y).toBeCloseTo(12, 0);
    } else {
      expect(buttonBounds.x).toBeCloseTo(headerBounds.x, 0);
      const titleBounds = await box(header.locator(".page-header__title-row"));
      expect(buttonBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
    }
    await page.getByLabel("Minimum stake").fill("26");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect(await box(button)).toEqual(buttonBounds);
  }
});

test("heist settings save explicitly and persist without horizontal overflow", async ({ page }) => {
  const settings = heistSettingsForLanguage("en");
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "heist", enabled: true, settings: JSON.stringify(settings) },
    ],
  });
  const api = await installSettingsApi(page, settings);

  for (const [index, width] of [390, 1440, 1920, 2560].entries()) {
    const minStake = 25 + index;
    const joinWindow = 90 + index;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/channels/${channelId}/modules/heist?lang=en`);
    await expect(page.locator(".settings-page__columns")).toBeVisible();
    await page.getByLabel("Minimum stake").fill(String(minStake));
    await page.getByLabel("Join window").fill(String(joinWindow));
    expect(api.saves).toHaveLength(index);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".page-header__save")).toContainText("Saved");
    expect(api.savedSettings()).toMatchObject({ minStake, joinWindowSeconds: joinWindow });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(width);
    // Each column scrolls on its own, so an overhang (e.g. a switch hit area) shows as a column scrollbar, not a page one.
    const overflowingColumns = await page.locator(".settings-page__column").evaluateAll((columns) =>
      columns.filter((column) => column.scrollWidth > column.clientWidth).length);
    expect(overflowingColumns).toBe(0);
    // One divider per section: only the heading's inline rule, no section or heading borders.
    const borderedParts = await page.locator(".ui-section, .ui-section__heading").evaluateAll((parts) =>
      parts.filter((part) => getComputedStyle(part).borderTopWidth !== "0px" || getComputedStyle(part).borderBottomWidth !== "0px").length);
    expect(borderedParts).toBe(0);
    await page.reload();
    await expect(page.getByLabel("Minimum stake")).toHaveValue(String(minStake));
    await expect(page.getByLabel("Join window")).toHaveValue(String(joinWindow));
  }
});
