import { expect, test, type Page } from "@playwright/test";
import { bossFightDefaultsForLanguage, type BossFightSettings } from "../../src/modules/boss_fight/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_boss_fight_channel";
const settingsPath = `/api/channels/${channelId}/modules/boss_fight/settings`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const installBossFightSettingsApi = async (page: Page, initial: BossFightSettings): Promise<() => BossFightSettings> => {
  let settings = structuredClone(initial);
  let revision = 1;
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json({ settings, revision, variables: [] }));
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { settings: BossFightSettings };
    settings = structuredClone(body.settings);
    revision += 1;
    await route.fulfill(json({ settings, revision, warnings: [] }));
  });
  return () => settings;
};

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("boss fight settings save explicitly and persist the attack and loot rules", async ({ page }) => {
  const initial = bossFightDefaultsForLanguage("en");
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "boss_fight", enabled: true, settings: JSON.stringify(initial) },
    ],
  });
  const savedSettings = await installBossFightSettingsApi(page, initial);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${channelId}/modules/boss_fight?lang=en`);
  await expect(page.locator(".settings-page__columns")).toBeVisible();
  await expect(page.getByLabel("Attack window")).toHaveValue("90");
  await expect(page.getByLabel("Cooldown per viewer")).toHaveValue("10");
  await expect(page.getByLabel("Loot pool")).toHaveValue("1000");

  await page.getByLabel("Cooldown per viewer").fill("12");
  await page.getByLabel("Loot pool").fill("1200");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(savedSettings()).toMatchObject({ attackCooldownSeconds: 10, lootPool: 1_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".page-header__save")).toContainText("Saved");
  expect(savedSettings()).toMatchObject({ attackCooldownSeconds: 12, lootPool: 1_200 });

  await page.reload();
  await expect(page.locator(".settings-page__columns")).toBeVisible();
  await expect(page.getByLabel("Cooldown per viewer")).toHaveValue("12");
  await expect(page.getByLabel("Loot pool")).toHaveValue("1200");
});

test("the cockpit shows the running boss with health, attackers and time left [protects=an open boss round appears as a cockpit tile with its HP and attacker count; fails_when=the tile is missing or shows another round's numbers; no_claim=the round endpoint is mocked and damage rules are covered by the worker suites]", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "boss_fight", enabled: true, settings: JSON.stringify(bossFightDefaultsForLanguage("en")) },
    ],
  });
  await page.route(`**/api/channels/${channelId}/modules/boss_fight/round`, (route) => route.fulfill(json({
    round: { id: "fictional_boss_round", currentHp: 410, maxHp: 540, attackers: 3, closesAt: new Date(Date.now() + 60_000).toISOString() },
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${channelId}?lang=en`);

  const tile = page.getByTestId("live-boss-fight-tile");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("410 / 540 HP");
  await expect(tile).toContainText("3 attackers");
});
