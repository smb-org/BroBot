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

const installSlotPage = async (page: Page, language: "de" | "en" = "de"): Promise<{
  settingsSaves: Record<string, unknown>[];
  storedSettings: () => typeof DEFAULT_SETTINGS;
}> => {
  const defaultSettings = emoteSlotDefaultSettingsForLanguage(language);
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    modules: [
      { id: "points", enabled: true, settings: JSON.stringify({ currencyName: "Points", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }) },
      { id: "emote_slots", enabled: true, settings: JSON.stringify(defaultSettings) },
    ],
  });
  let settings: typeof DEFAULT_SETTINGS = structuredClone(defaultSettings);
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

const expectNumericRule = async (
  pageRoot: ReturnType<Page["locator"]>,
  label: string,
  value: string,
  expected: string,
  generic: string,
): Promise<void> => {
  const field = pageRoot.getByLabel(label, { exact: true });
  await field.fill(value);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const error = field.locator("xpath=../..").locator(".unit-input__error");
  await expect(error).toContainText(expected);
  await expect(error).not.toContainText(generic);
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

test("shows complete full-width slot previews below their textareas at desktop sizes", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const fields = page.locator(".slot-texts-field .ui-template-text-field");
  const jackpotField = fields.nth(3);
  const jackpotPreview = jackpotField.locator(".ui-template-text-field__preview");
  const jackpotPreviewText = jackpotPreview.locator(".ui-template-text-field__preview-text");
  const jackpotText = page.getByRole("textbox", { name: SLOT_COPY.jackpotText, exact: true });
  await expect(jackpotPreview).toBeVisible();
  const completeMessage = "{slot.symbols}  {slot.net} · Stand {slot.balance} · Jackpot {slot.jackpot} Zusatztext für eine vollständige und ungekürzte Vorschau im Chat";
  await jackpotText.fill(completeMessage);
  await expect(jackpotPreviewText).toContainText("Zusatztext für eine vollständige und ungekürzte Vorschau im Chat");
  await expect(jackpotPreviewText).not.toContainText("…");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    const metrics = await fields.evaluateAll((templateFields) => templateFields.map((field) => {
      const textarea = field.querySelector("textarea")?.getBoundingClientRect();
      const preview = field.querySelector<HTMLElement>(".ui-template-text-field__preview");
      const message = field.querySelector<HTMLElement>(".ui-template-text-field__preview-message");
      const previewRect = preview?.getBoundingClientRect();
      const messageRect = message?.getBoundingClientRect();
      const style = message === null ? null : getComputedStyle(message);
      return textarea === undefined || previewRect === undefined || messageRect === undefined || style === null ? null : {
        textareaWidth: textarea.width,
        textareaLeft: textarea.left,
        textareaBottom: textarea.bottom,
        previewWidth: previewRect.width,
        previewLeft: previewRect.left,
        previewTop: previewRect.top,
        messageHeight: messageRect.height,
        messageClientHeight: message?.clientHeight ?? 0,
        messageScrollHeight: message?.scrollHeight ?? 0,
        lineClamp: style.webkitLineClamp,
        maxHeight: style.maxHeight,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
      };
    }));
    expect(metrics).toHaveLength(4);
    for (const metric of metrics) {
      expect(metric).not.toBeNull();
      expect(Math.abs((metric?.previewWidth ?? 0) - (metric?.textareaWidth ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((metric?.previewLeft ?? 0) - (metric?.textareaLeft ?? 0))).toBeLessThanOrEqual(1);
      expect(metric?.previewTop).toBeGreaterThanOrEqual((metric?.textareaBottom ?? 0) - 1);
      expect(metric?.messageScrollHeight).toBeLessThanOrEqual((metric?.messageClientHeight ?? 0) + 1);
      expect(metric?.lineClamp).not.toBe("3");
      expect(metric?.maxHeight).toBe("none");
      expect(metric?.overflow).toBe("visible");
      expect(metric?.textOverflow).not.toBe("ellipsis");
    }
  }
});

test("invalid numeric drafts stay visible and lock the quote without rendering a rate (protects=non-integer, empty, and out-of-range Slot numbers show rule-specific field errors, preserve the draft, lock saving with one bounded reason, and show the invalid quote only once; fails_when=invalid input throws during render, changes to a valid value, leaves the quote active, duplicates or overflows the header reason, or can be saved; no_claim=server-side settings validation)", async ({ page }) => {
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
  await expect(rate.locator(".slot-rate-value")).toHaveText("–");
  await expect(rate).toContainText(SLOT_COPY.quoteInvalid);
  await expect(rate.locator(".status-led")).toHaveAttribute("aria-label", expect.stringContaining(SLOT_COPY.quoteInvalid));
  await expect(rate.locator(".slot-rate-value")).not.toContainText(SLOT_COPY.quoteInvalid);
  await expect(minStake).toHaveValue("1.5");
  const minStakeError = minStake.locator("xpath=../..").locator(".unit-input__error");
  await expect(minStakeError).toBeVisible();
  await expect(minStakeError).toContainText(SLOT_COPY.minStakeError);
  await expect(minStakeError).not.toContainText(EDITOR_COPY.invalidMessage);
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", EDITOR_COPY.invalidMessage);
  const reasonSlot = pageRoot.locator(".page-header__save .ui-save-bar__status");
  await expect(reasonSlot).toContainText(EDITOR_COPY.invalidMessage);
  await expect(reasonSlot).not.toContainText(quoteLockedReason);
  await expect(reasonSlot.locator(".ui-save-bar__footer")).toHaveCount(0);
  expect(await reasonSlot.evaluate((status) => {
    const bounds = status.getBoundingClientRect();
    return [...status.querySelectorAll(".ui-save-bar__message, .ui-save-bar__footer")].every((item) => {
      const rect = item.getBoundingClientRect();
      return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
        rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 &&
        item.scrollWidth <= item.clientWidth && item.scrollHeight <= item.clientHeight;
    });
  })).toBe(true);

  await minStake.fill("15");
  const defaultStake = pageRoot.getByLabel(SLOT_COPY.defaultStake, { exact: true });
  await defaultStake.fill("1.5");
  await expect(defaultStake.locator("xpath=../..").locator(".unit-input__error")).toContainText(SLOT_COPY.defaultStakeError);
  await defaultStake.fill("50");
  const maxStake = pageRoot.getByLabel(SLOT_COPY.maxStake, { exact: true });
  await maxStake.fill("100001");
  await expect(maxStake.locator("xpath=../..").locator(".unit-input__error")).toContainText(SLOT_COPY.maxStakeError);
  await maxStake.fill("500");
  const seed = pageRoot.getByLabel(SLOT_COPY.seed, { exact: true });
  await seed.fill("");
  await expect(seed).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(seed.locator("xpath=../..").locator(".unit-input__error")).toContainText(SLOT_COPY.seedError);
  await expect(seed).toHaveValue("");
  await seed.press("Tab");
  await expect(seed).toHaveValue("");
  await expect(save).toBeDisabled();

  await seed.fill("500");
  const share = pageRoot.getByLabel(SLOT_COPY.share, { exact: true });
  await share.fill("7.001");
  await expect(share).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(share.locator("xpath=../..").locator(".unit-input__error")).toContainText(SLOT_COPY.shareError);
  await expect(share).toHaveValue("7.001");
  await share.press("Tab");
  await expect(share).toHaveValue("7.001");
  await expect(save).toBeDisabled();

  const cooldown = pageRoot.getByLabel(SLOT_COPY.cooldown, { exact: true });
  await cooldown.fill("3601");
  await expect(cooldown).toHaveAttribute("aria-invalid", "true");
  await expect(rate).toHaveAttribute("data-status", "invalid");
  await expect(cooldown.locator("xpath=../..").locator(".unit-input__error")).toContainText(SLOT_COPY.cooldownError);
  await expect(cooldown).toHaveValue("3601");
  await cooldown.press("Tab");
  await expect(cooldown).toHaveValue("3601");
  await expect(save).toBeDisabled();

  const cherry = DEFAULT_SETTINGS.symbols[0]?.name ?? "";
  const weight = pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", cherry));
  await weight.fill("1.5");
  await expect(weight.locator("xpath=../../..").locator(".unit-input__error")).toContainText(SLOT_COPY.weightError);
  const triple = pageRoot.getByLabel(SLOT_COPY.tripleAria.replace("{name}", cherry));
  await triple.fill("1");
  await expect(triple.locator("xpath=../../..").locator(".unit-input__error")).toContainText(SLOT_COPY.tripleError);
});

test("reconnect closes the symbol picker before showing a closable dialog (protects=the reconnect dialog is fully visible above the picker, explains access in plain words, and restores focus to the symbol control; fails_when=the picker remains mounted over the dialog centre, the close action is missing, scope identifiers are shown, or focus is lost after closing; no_claim=the OAuth grant flow itself)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const pageRoot = page.locator(".module-detail--settings-page");
  const firstSymbol = pageRoot.getByRole("button", { name: `${SLOT_COPY.chooseSymbol}: ${DEFAULT_SETTINGS.symbols[0]?.name ?? ""}` });
  await firstSymbol.click();
  const picker = page.getByRole("dialog", { name: SLOT_COPY.picker.title });
  await expect(picker.getByRole("button", { name: SLOT_COPY.reconnect, exact: true })).toBeVisible();
  await picker.getByRole("button", { name: SLOT_COPY.reconnect, exact: true }).click();

  const dialog = page.getByRole("dialog", { name: SLOT_COPY.reconnectDialogTitle });
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveCount(0);
  await expect(dialog.locator(".ui-dialog__close")).toBeVisible();
  await expect(dialog).not.toContainText("user:read:emotes");
  expect(await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const centre = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return centre !== null && element.contains(centre);
  })).toBe(true);

  await dialog.locator(".ui-dialog__close").click();
  await expect(dialog).toHaveCount(0);
  await expect(firstSymbol).toBeFocused();
});

test("invalid Slot header uses one bounded reason (protects=invalid fields take priority over the payout lock reason inside the fixed save cluster; fails_when=both reasons render, the save title names the lower priority lock, or any header content overflows its box; no_claim=save server validation)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);
  const pageRoot = page.locator(".module-detail--settings-page");
  await pageRoot.getByLabel(SLOT_COPY.minStake, { exact: true }).fill("1.5");

  const saveCluster = pageRoot.locator(".page-header__save");
  const reasonSlot = saveCluster.locator(".ui-save-bar__status");
  await expect(reasonSlot).toContainText(EDITOR_COPY.invalidMessage);
  await expect(reasonSlot).not.toContainText(SLOT_COPY.quoteLockedReason);
  await expect(reasonSlot.locator(".ui-save-bar__footer")).toHaveCount(0);
  await expect(pageRoot.getByRole("button", { name: EDITOR_COPY.saveLabel })).toHaveAttribute("title", EDITOR_COPY.invalidMessage);
  expect(await saveCluster.evaluate((cluster) => {
    const header = cluster.closest(".page-header");
    if (header === null) return false;
    const headerBounds = header.getBoundingClientRect();
    const clusterBounds = cluster.getBoundingClientRect();
    const elements = [cluster, ...cluster.querySelectorAll("*")].filter((element) => !element.classList.contains("sr-only"));
    return elements.every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= clusterBounds.left - 1 && rect.right <= clusterBounds.right + 1 &&
        rect.top >= clusterBounds.top - 1 && rect.bottom <= clusterBounds.bottom + 1 &&
        rect.left >= headerBounds.left - 1 && rect.right <= headerBounds.right + 1 &&
        rect.top >= headerBounds.top - 1 && rect.bottom <= headerBounds.bottom + 1 &&
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight;
    });
  })).toBe(true);
});

test("invalid payout line uses a dash for its value and explains the state once (protects=the invalid rate occupies the value slot with one neutral dash and one status explanation; fails_when=the unavailable-rate sentence appears twice or the value slot is not a dash; no_claim=payout calculation for valid settings)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);
  const pageRoot = page.locator(".module-detail--settings-page");
  const rate = pageRoot.locator(".slot-rate-line");
  await pageRoot.getByLabel(SLOT_COPY.minStake, { exact: true }).fill("1.5");
  await expect(rate.locator(".slot-rate-value")).toHaveText("–");
  await expect(rate.locator(".status-led__label")).toHaveText(SLOT_COPY.quoteInvalid);
  await expect(rate.locator(".slot-rate-value")).not.toContainText(SLOT_COPY.quoteInvalid);
});

test("German Slot numeric fields show their matching rules (protects=stake, seed, share, cooldown, reel weight, and payout errors name their allowed range or precision in German; fails_when=an invalid numeric field shows the generic settings message or English text; no_claim=server validation and other editor fields)", async ({ page }) => {
  await installSlotPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);
  const pageRoot = page.locator(".module-detail--settings-page");
  await expectNumericRule(pageRoot, SLOT_COPY.minStake, "1.5", SLOT_COPY.minStakeError, EDITOR_COPY.invalidMessage);
  await expectNumericRule(pageRoot, SLOT_COPY.defaultStake, "1.5", SLOT_COPY.defaultStakeError, EDITOR_COPY.invalidMessage);
  await expectNumericRule(pageRoot, SLOT_COPY.maxStake, "100001", SLOT_COPY.maxStakeError, EDITOR_COPY.invalidMessage);
  await expectNumericRule(pageRoot, SLOT_COPY.seed, "1000001", SLOT_COPY.seedError, EDITOR_COPY.invalidMessage);
  await expectNumericRule(pageRoot, SLOT_COPY.share, "7.001", SLOT_COPY.shareError, EDITOR_COPY.invalidMessage);
  await expectNumericRule(pageRoot, SLOT_COPY.cooldown, "3601", SLOT_COPY.cooldownError, EDITOR_COPY.invalidMessage);
  const weight = pageRoot.getByLabel(SLOT_COPY.weightAria.replace("{name}", DEFAULT_SETTINGS.symbols[0]?.name ?? ""));
  await weight.fill("1.5");
  await expect(weight.locator("xpath=../../..").locator(".unit-input__error")).toContainText(SLOT_COPY.weightError);
  const triple = pageRoot.getByLabel(SLOT_COPY.tripleAria.replace("{name}", DEFAULT_SETTINGS.symbols[0]?.name ?? ""));
  await triple.fill("1");
  await expect(triple.locator("xpath=../../..").locator(".unit-input__error")).toContainText(SLOT_COPY.tripleError);
});

test.describe("English Slot numeric field rules", () => {
  test.use({ locale: "en-US" });

  test("shows the matching English rule below each invalid number field (protects=English Slot number errors identify the exact allowed range or precision for stake, seed, share, cooldown, weight, and payout fields; fails_when=any invalid numeric field shows the generic settings message or a German rule; no_claim=server validation and non-numeric editor fields)", async ({ page }) => {
    await installSlotPage(page, "en");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

    const pageRoot = page.locator(".module-detail--settings-page");
    const copy = emoteSlotsCatalog.en.panel;
    const invalidMessage = emoteSlotSettingsEditorCatalog.en.invalidMessage;
    await expectNumericRule(pageRoot, copy.minStake, "1.5", copy.minStakeError, invalidMessage);
    await expectNumericRule(pageRoot, copy.defaultStake, "1.5", copy.defaultStakeError, invalidMessage);
    await expectNumericRule(pageRoot, copy.maxStake, "100001", copy.maxStakeError, invalidMessage);
    await expectNumericRule(pageRoot, copy.seed, "1000001", copy.seedError, invalidMessage);
    await expectNumericRule(pageRoot, copy.share, "7.001", copy.shareError, invalidMessage);
    await expectNumericRule(pageRoot, copy.cooldown, "3601", copy.cooldownError, invalidMessage);

    const weight = pageRoot.getByLabel(copy.weightAria.replace("{name}", "Cherry"));
    await weight.fill("1.5");
    await expect(weight.locator("xpath=../../..").locator(".unit-input__error")).toContainText(copy.weightError);
    const triple = pageRoot.getByLabel(copy.tripleAria.replace("{name}", "Cherry"));
    await triple.fill("1");
    await expect(triple.locator("xpath=../../..").locator(".unit-input__error")).toContainText(copy.tripleError);
  });
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

test("jackpot header shows zero before the first funded spin (protects=a loaded points summary without an emote_slots entry renders the jackpot amount 0; fails_when=the header shows the label with an empty amount; no_claim=jackpot funding and settlement)", async ({ page }) => {
  await installSlotPage(page);
  await page.route(`**${pointsSummaryPath}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jackpots: {} }),
  }));
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);
  await expect(page.locator(".slot-jackpot-meta")).toHaveText(SLOT_COPY.jackpotCurrent.replace("{amount}", "0"));
});
