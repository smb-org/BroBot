import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";

import { emoteSlotDefaultSettingsForLanguage } from "../../src/modules/emote_slots/contracts";
import { calculateSlotPayoutRate, formatSlotPayoutRate } from "../../src/modules/emote_slots/domain/payout-rate";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { emoteSlotSettingsEditorCatalog } from "../../src/modules/emote_slots/panel/locale";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "kanal_slot_demo";
const DEFAULT_SETTINGS = emoteSlotDefaultSettingsForLanguage("de");
const SLOT_COPY = emoteSlotsCatalog.de.panel;
const EDITOR_COPY = emoteSlotSettingsEditorCatalog.de;
const DEFAULT_RATE = formatSlotPayoutRate(calculateSlotPayoutRate(DEFAULT_SETTINGS), "de");
const settingsPath = `/api/channels/${CHANNEL_ID}/modules/emote_slots/settings`;
const emotesPath = `/api/channels/${CHANNEL_ID}/modules/emote_slots/emotes`;
const pointsSummaryPath = `/api/channels/${CHANNEL_ID}/modules/points/summary`;

const installSlotPage = async (page: Page): Promise<{
  settingsSaves: Record<string, unknown>[];
  storedSettings: () => typeof DEFAULT_SETTINGS;
}> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    modules: [
      { id: "points", enabled: true, settings: JSON.stringify({ currencyName: "Points", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }) },
      { id: "emote_slots", enabled: true, settings: JSON.stringify(DEFAULT_SETTINGS) },
    ],
  });
  let settings: typeof DEFAULT_SETTINGS = structuredClone(DEFAULT_SETTINGS);
  let revision = 1;
  const settingsSaves: Record<string, unknown>[] = [];
  await page.route(`**${settingsPath}`, async (route: Route) => {
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
    if (route.request().method() === "GET") return json({ settings, revision, variables: [] });
    const body = route.request().postDataJSON() as { settings: typeof settings; revision: number };
    if (body.revision !== revision) return json({ error: "module_settings_changed_concurrently" }, 409);
    settings = body.settings;
    revision += 1;
    settingsSaves.push(body);
    return json({ settings, revision, warnings: [] });
  });
  await page.route(`**${emotesPath}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      emoji: { items: [
        { source: "emoji", code: "🍒", name: "Cherry" },
        { source: "emoji", code: "🍋", name: "Lemon" },
      ] },
      twitch: { status: "reconnect_required", items: [{ source: "twitch", code: "pixelwave", twitchId: "emote_demo_1", name: "Pixelwave" }] },
    }),
  }));
  await page.route(`**${pointsSummaryPath}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jackpots: { emote_slots: 1_256 } }),
  }));
  return { settingsSaves, storedSettings: () => settings };
};

const box = async (locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number; width: number; height: number }> => {
  const value = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Math.round(number * 100) / 100])) as {
    x: number; y: number; width: number; height: number;
  };
};

test("slot quote states stay fixed, lock unsafe saves, and persist explicit edits (protects=the live rate, locked save state, grouped picker, fixed layout, and reload persistence; fails_when=weight edits do not recalculate, a rate at or above 100% can save, status changes move the page, or reload loses the saved value; no_claim=chat settlement and real Helix delivery are covered by worker tests)", async ({ page }, testInfo: TestInfo) => {
  const fixture = await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const pageRoot = page.locator(".module-detail--settings-page");
  const rate = pageRoot.locator(".slot-rate-line");
  const save = pageRoot.getByRole("button", { name: EDITOR_COPY.saveLabel });
  await expect(pageRoot).toBeVisible();
  await expect(rate).toContainText(DEFAULT_RATE);
  await expect(pageRoot.locator(".slot-jackpot-meta")).toHaveText(SLOT_COPY.jackpotCurrent.replace("{amount}", "1.256"));
  const rateBox = await box(rate);
  const columnsBox = await box(pageRoot.locator(".settings-page__columns"));
  const settingsColumns = pageRoot.locator(".settings-page__columns > .settings-page__column");
  const reelColumnBox = await box(settingsColumns.nth(0));
  const stakesColumnBox = await box(settingsColumns.nth(1));
  const chatColumnBox = await box(settingsColumns.nth(2));
  expect(reelColumnBox.width).toBeGreaterThan(stakesColumnBox.width * 1.8);
  expect(chatColumnBox.x).toBeGreaterThan(stakesColumnBox.x);
  expect(chatColumnBox.y).toBeCloseTo(stakesColumnBox.y, 0);
  expect(stakesColumnBox.y).toBeGreaterThanOrEqual(reelColumnBox.y + reelColumnBox.height);
  const tableBox = await box(pageRoot.locator(".slot-reel-table"));
  expect(stakesColumnBox.y).toBeGreaterThan(tableBox.y + tableBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const rows = pageRoot.locator(".slot-reel-table tbody tr");
  for (const row of await rows.all()) {
    const rowBox = await box(row);
    expect(rowBox.height).toBeGreaterThanOrEqual(52);
    expect(rowBox.height).toBeLessThanOrEqual(60);
  }
  await expect(pageRoot.getByRole("radiogroup", { name: SLOT_COPY.jackpotSymbol })).toBeVisible();
  await expect(pageRoot.locator('input[type="radio"]')).toHaveCount(6);
  await expect(pageRoot.getByRole("button", { name: SLOT_COPY.insertVariable, exact: true })).toHaveCount(4);
  await expect(pageRoot.locator(".slot-rate-value")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("slot-1440x900-default.png"), fullPage: false, animations: "disabled" });

  const firstSymbol = pageRoot.getByRole("button", { name: `${SLOT_COPY.chooseSymbol}: ${DEFAULT_SETTINGS.symbols[0]?.name ?? ""}` });
  await firstSymbol.click();
  const picker = page.getByRole("dialog", { name: SLOT_COPY.picker.title });
  await expect(picker.getByText(SLOT_COPY.emoji, { exact: true })).toBeVisible();
  await expect(picker.getByText(SLOT_COPY.twitch, { exact: true })).toBeVisible();
  await expect(picker.getByText(SLOT_COPY.reconnect, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const jackpotName = DEFAULT_SETTINGS.symbols.find(({ isJackpot }) => isJackpot)?.name ?? "";
  const jackpotWeight = pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", jackpotName));
  await jackpotWeight.fill("99");
  await expect(rate).toContainText(SLOT_COPY.quoteLocked);
  await expect(save).toBeDisabled();
  const lockedRateBox = await box(rate);
  const lockedColumnsBox = await box(pageRoot.locator(".settings-page__columns"));
  expect(lockedRateBox).toEqual(rateBox);
  expect(lockedColumnsBox).toEqual(columnsBox);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(save).toHaveAttribute("data-variant", "neutral");
  await page.screenshot({ path: testInfo.outputPath("slot-1440x900-error.png"), fullPage: false, animations: "disabled" });

  await page.setViewportSize({ width: 1920, height: 1080 });
  const wideReels = await box(settingsColumns.nth(0));
  const wideStakes = await box(settingsColumns.nth(1));
  const wideChat = await box(settingsColumns.nth(2));
  expect(wideReels.y).toEqual(wideStakes.y);
  expect(wideChat.y).toEqual(wideStakes.y);
  expect(wideStakes.x).toBeGreaterThan(wideReels.x);
  expect(wideChat.x).toBeGreaterThan(wideStakes.x);
  await expect(pageRoot.locator(".slot-jackpot-meta")).toHaveText(SLOT_COPY.jackpotCurrent.replace("{amount}", "1.256"));
  const metaBox = await box(pageRoot.locator(".slot-jackpot-meta"));
  expect(metaBox.width).toBeGreaterThan(200);
  const wideRate = await box(rate);
  await page.screenshot({ path: testInfo.outputPath("slot-1920x1080-error.png"), fullPage: false, animations: "disabled" });
  await jackpotWeight.fill("1");
  await expect(rate).toContainText(DEFAULT_RATE);
  expect(await box(rate)).toEqual(wideRate);
  await page.screenshot({ path: testInfo.outputPath("slot-1920x1080-default.png"), fullPage: false, animations: "disabled" });
  await pageRoot.getByLabel(SLOT_COPY.seed, { exact: true }).fill("0");
  await pageRoot.getByLabel(SLOT_COPY.share, { exact: true }).fill("0");
  await expect(rate).toContainText(SLOT_COPY.quoteWarning);
  expect(await box(rate)).toEqual(wideRate);
  await expect(save).toBeEnabled();
  await expect(pageRoot.getByText(SLOT_COPY.unsaved, { exact: true })).toBeVisible();
  await pageRoot.getByLabel(SLOT_COPY.seed, { exact: true }).fill("500");
  await pageRoot.getByLabel(SLOT_COPY.share, { exact: true }).fill("7");
  const changedSettings = structuredClone(DEFAULT_SETTINGS);
  const jackpotSymbol = changedSettings.symbols.find(({ isJackpot }) => isJackpot);
  if (jackpotSymbol !== undefined) jackpotSymbol.weight = 2;
  const changedRate = formatSlotPayoutRate(calculateSlotPayoutRate(changedSettings), "de");
  await jackpotWeight.fill("2");
  await expect(rate).toContainText(changedRate);
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.settingsSaves).toHaveLength(1);
  expect(fixture.storedSettings().symbols[5]?.weight).toBe(2);

  await page.reload();
  await expect(pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", jackpotName))).toHaveValue("2");
  await expect(pageRoot.locator(".slot-rate-line")).toContainText(changedRate);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("invalid numeric drafts stay visible and lock the quote without rendering a rate (protects=non-integer, empty, and out-of-range Slot numbers show field errors, preserve the draft, and lock saving with the reserved reason; fails_when=invalid input throws during render, changes to a valid value, leaves the quote active, or can be saved; no_claim=server-side settings validation)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const pageRoot = page.locator(".module-detail--settings-page");
  const rate = pageRoot.locator(".slot-rate-line");
  const save = pageRoot.getByRole("button", { name: EDITOR_COPY.saveLabel });
  const quoteLockedReason = SLOT_COPY.quoteLockedReason;
  const minStake = pageRoot.getByLabel(SLOT_COPY.minStake, { exact: true });
  await minStake.fill("1.5");
  await expect(minStake).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(rate).toContainText(SLOT_COPY.quoteInvalid);
  await expect(minStake).toHaveValue("1.5");
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", quoteLockedReason);

  await minStake.fill("15");
  const seed = pageRoot.getByLabel(SLOT_COPY.seed, { exact: true });
  await seed.fill("");
  await expect(seed).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(seed).toHaveValue("");
  await seed.press("Tab");
  await expect(seed).toHaveValue("");
  await expect(save).toBeDisabled();

  await seed.fill("500");
  const share = pageRoot.getByLabel(SLOT_COPY.share, { exact: true });
  await share.fill("7.001");
  await expect(share).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(share).toHaveValue("7.001");
  await share.press("Tab");
  await expect(share).toHaveValue("7.001");
  await expect(save).toBeDisabled();

  const cooldown = pageRoot.getByLabel(SLOT_COPY.cooldown, { exact: true });
  await cooldown.fill("3601");
  await expect(cooldown).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(cooldown).toHaveValue("3601");
  await cooldown.press("Tab");
  await expect(cooldown).toHaveValue("3601");
  await expect(save).toBeDisabled();
});

test("Slot numeric errors keep every following control in place (protects=stakes, seed, share, cooldown, and reel errors reserve their Slot-only height including rate-lock messages; fails_when=any following control shifts after a field error appears; no_claim=layout behavior on other dashboard pages)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 390, height: 1600 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const pageRoot = page.locator(".module-detail--settings-page");
  const position = async (locator: ReturnType<Page["locator"]>): Promise<number> => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const container = element.closest(".settings-page__columns");
    return Math.round((rect.y - (container?.getBoundingClientRect().y ?? 0) + (container?.scrollTop ?? 0)) * 100) / 100;
  });

  const minStake = pageRoot.getByLabel(SLOT_COPY.minStake, { exact: true });
  const maxStake = pageRoot.getByLabel(SLOT_COPY.maxStake, { exact: true });
  const maxStakeY = await position(maxStake);
  await minStake.fill("1.5");
  await expect(minStake).toHaveAttribute("aria-invalid", "true");
  expect(await position(maxStake)).toBe(maxStakeY);
  await minStake.fill("15");

  const rate = pageRoot.locator(".slot-rate-line");
  const seed = pageRoot.getByLabel(SLOT_COPY.seed, { exact: true });
  const announce = pageRoot.getByLabel(SLOT_COPY.announce, { exact: true });
  const announceY = await position(announce);
  await seed.fill("1000000");
  await expect(rate).toHaveAttribute("data-status", "locked");
  await expect(seed).toHaveAttribute("aria-invalid", "true");
  expect(await position(announce)).toBe(announceY);
  await seed.fill("500");

  const share = pageRoot.getByLabel(SLOT_COPY.share, { exact: true });
  await share.fill("20");
  await expect(rate).toHaveAttribute("data-status", "locked");
  await expect(share).toHaveAttribute("aria-invalid", "true");
  expect(await position(announce)).toBe(announceY);
  await share.fill("7");

  const cooldown = pageRoot.getByLabel(SLOT_COPY.cooldown, { exact: true });
  const chatTarget = pageRoot.getByLabel(SLOT_COPY.targetLabel, { exact: true });
  const chatTargetY = await position(chatTarget);
  await cooldown.fill("3601");
  await expect(cooldown).toHaveAttribute("aria-invalid", "true");
  expect(await position(chatTarget)).toBe(chatTargetY);

  const firstWeight = pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", DEFAULT_SETTINGS.symbols[0]?.name ?? ""));
  const secondRowWeight = pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", DEFAULT_SETTINGS.symbols[1]?.name ?? ""));
  const secondRowY = await position(secondRowWeight);
  await firstWeight.fill("1.5");
  await expect(firstWeight).toHaveAttribute("aria-invalid", "true");
  await expect(firstWeight.locator("xpath=../../..").locator(".unit-input__error")).toBeVisible();
  expect(await position(secondRowWeight)).toBe(secondRowY);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
