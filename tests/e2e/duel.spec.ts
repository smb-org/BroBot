import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { duelSettingsForLanguage, type DuelSettings } from "../../src/modules/duel/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_duel_channel";
const settingsPath = `/api/channels/${channelId}/modules/duel/settings`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const installDuelSettingsApi = async (page: Page, initial: DuelSettings) => {
  let settings = structuredClone(initial);
  let revision = 1;
  let failNextSave = false;
  const saves: DuelSettings[] = [];
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json({ settings, revision, variables: [] }));
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    if (failNextSave) {
      failNextSave = false;
      await route.fulfill(json({ error: "module_settings_save_failed" }, 500));
      return;
    }
    const body = route.request().postDataJSON() as { settings: DuelSettings };
    settings = structuredClone(body.settings);
    revision += 1;
    saves.push(settings);
    await route.fulfill(json({ settings, revision, warnings: [] }));
  });
  return {
    savedSettings: () => settings,
    saves,
    failNextSave: () => { failNextSave = true; },
    reset: () => { settings = structuredClone(initial); revision = 1; saves.length = 0; },
  };
};

const layoutOutsideSaveStatus = async (page: Page): Promise<Array<{ key: string; position: number[] }>> => page
  .locator(".module-detail--settings-page")
  .evaluate((root) => [...root.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.closest(".page-header__save") === null && getComputedStyle(element).display !== "none")
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        key: `${element.tagName}.${typeof element.className === "string" ? element.className : ""}:${String(index)}`,
        position: [rect.x, rect.y].map((value) => Math.round(value * 100) / 100),
      };
  }));

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("duel settings save the bot rule and stake bounds at desktop widths and persist after reload [protects=explicitly saved duel settings survive reload at 1440x900 and 1920x1080; fails_when=the bot switch or stake limits revert, save is implicit, or either viewport has a layout overflow; no_claim=module settings requests are mocked and screenshots document the browser-rendered page only]", async ({ page }, testInfo) => {
  mkdirSync("test-results/duel", { recursive: true });
  const settings = duelSettingsForLanguage("en");
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "duel", enabled: true, settings: JSON.stringify(settings) },
    ],
  });
  const api = await installDuelSettingsApi(page, settings);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    api.reset();
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/duel?lang=en`);
    await expect(page.locator(".settings-page__columns")).toBeVisible();
    const botSwitch = page.getByRole("switch", { name: "Bot accepts open duels" });
    await expect(botSwitch).toBeChecked();
    await botSwitch.click();
    await page.getByLabel("Minimum stake").fill("20");
    await page.getByLabel("Maximum stake").fill("400");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect(api.saves).toHaveLength(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".page-header__save")).toContainText("Saved");
    expect(api.savedSettings()).toMatchObject({ botAcceptsOpenDuels: false, minStake: 20, maxStake: 400 });
    await page.locator(".settings-page__column").first().evaluate((column) => { column.scrollTop = 0; });
    await page.screenshot({
      path: `test-results/duel/settings-${String(viewport.width)}x${String(viewport.height)}-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(page.locator(".settings-page__columns")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Bot accepts open duels" })).not.toBeChecked();
    await expect(page.getByLabel("Minimum stake")).toHaveValue("20");
    await expect(page.getByLabel("Maximum stake")).toHaveValue("400");
  }
});

test("a settings save error changes no geometry outside the reserved status area [protects=save failure feedback is shown without moving any other visible settings element at 1440x900 and 1920x1080; fails_when=any visible element outside the reserved save status changes its bounding box; no_claim=the failure response is a mocked settings API error]", async ({ page }) => {
  const settings = duelSettingsForLanguage("en");
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "duel", enabled: true, settings: JSON.stringify(settings) },
    ],
  });
  const api = await installDuelSettingsApi(page, settings);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/duel?lang=en`);
    await expect(page.locator(".settings-page__columns")).toBeVisible();
    await page.getByLabel("Minimum stake").fill("20");
    const before = await layoutOutsideSaveStatus(page);
    api.failNextSave();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".page-header__save")).toContainText("Settings could not be saved.");
    expect(await layoutOutsideSaveStatus(page)).toEqual(before);
  }
});

test("the cockpit lists an open duel and confirms cancellation before sending the refund request [protects=the duel tile shows its players and stake and cancellation is confirmed then removes the tile; fails_when=the tile is missing, cancellation sends before confirmation, or the duel remains after success; no_claim=the cockpit API fixture removes the tile and the worker refund is covered by the Durable Object suite]", async ({ page }) => {
  const duel = {
    kind: "duel",
    id: "fictional_open_duel",
    challenger: "frostfern",
    target: "moonmoss",
    stake: 100,
    closesAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const cancelRequests: string[] = [];
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "duel", enabled: true, settings: JSON.stringify(duelSettingsForLanguage("en")) },
    ],
    duels: [duel],
    onDuelCancel: (id) => { cancelRequests.push(id); },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${channelId}`);
  const tile = page.getByTestId("live-duel-tile");
  await expect(tile).toContainText("frostfern vs. moonmoss");
  await expect(tile).toContainText("Stake 100 points");
  await tile.getByRole("button", { name: "Cancel round" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel round?" });
  await expect(dialog).toContainText("Stakes will be refunded.");
  expect(cancelRequests).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel round" }).click();
  await expect(page.getByText("Stakes refunded.")).toBeVisible();
  await expect(tile).toHaveCount(0);
  expect(cancelRequests).toEqual(["fictional_open_duel"]);
});
