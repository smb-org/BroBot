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
