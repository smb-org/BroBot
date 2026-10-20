import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";

import { emoteSlotDefaultSettingsForLanguage } from "../../src/modules/emote_slots/contracts";
import { emoteSlotOverlayLabels } from "../../src/modules/emote_slots/overlay/locale";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "en-US" });

const CHANNEL_ID = "fictional-slot-channel-495";
const DEFAULT_SETTINGS = emoteSlotDefaultSettingsForLanguage("en");
const SLOT_COPY = emoteSlotsCatalog.en.panel;
const settingsPath = `/api/channels/${CHANNEL_ID}/modules/emote_slots/settings`;
const emotesPath = `/api/channels/${CHANNEL_ID}/modules/emote_slots/emotes`;
const pointsSummaryPath = `/api/channels/${CHANNEL_ID}/modules/points/summary`;

const activeResponse = {
  emoji: { items: [{ source: "emoji", code: "🍒", name: "Cherry" }] },
  twitch: { status: "ok", items: [{ source: "twitch", code: "moonwave", twitchId: "moon-wave", name: "moonwave", imageUrl: "https://static-cdn.jtvnw.net/emoticons/v2/moon-wave/default/dark/1.0" }] },
  sevenTv: { status: "ok", setName: "Night Shift", items: [{ source: "seven_tv", code: "pixelwave", sevenTvId: "active-emote", name: "pixelwave", imageUrl: "https://cdn.7tv.app/emote/active-emote/3x.webp" }] },
};

const mockImages = async (page: Page): Promise<void> => {
  await page.route(/^https:\/\/(cdn\.7tv\.app|static-cdn\.jtvnw\.net)\//u, (route) => route.request().url().includes("failed-emote")
    ? route.abort()
    : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="16" fill="#68c8e8"/><circle cx="23" cy="26" r="5" fill="#10202c"/><circle cx="43" cy="26" r="5" fill="#10202c"/><path d="M20 42 Q32 52 46 40" fill="none" stroke="#10202c" stroke-width="4"/></svg>' }));
};

const installPickerPage = async (page: Page, response: () => Promise<unknown> = () => Promise.resolve(activeResponse)): Promise<Record<string, unknown>[]> => {
  await mockImages(page);
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    symbols: DEFAULT_SETTINGS.symbols.map((symbol, index) => index === 0
      ? { ...symbol, source: "seven_tv" as const, code: "oldwave", sevenTvId: "removed-emote", name: "oldwave" }
      : index === 1 ? { ...symbol, source: "seven_tv" as const, code: "pixelwave", sevenTvId: "active-emote", name: "pixelwave" }
        : index === 2 ? { ...symbol, source: "twitch" as const, code: "moonwave", twitchId: "moon-wave", name: "moonwave" }
          : symbol),
  };
  const saves: Record<string, unknown>[] = [];
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    modules: [
      { id: "points", enabled: true, settings: JSON.stringify({ currencyName: "Points", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }) },
      { id: "emote_slots", enabled: true, settings: JSON.stringify(settings) },
    ],
  });
  let revision = 1;
  await page.route(`**${settingsPath}`, async (route: Route) => {
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (route.request().method() === "GET") return json({ settings, revision, variables: [] });
    const body = route.request().postDataJSON() as { settings: typeof settings; revision: number };
    if (body.revision !== revision) return json({ error: "module_settings_changed_concurrently" }, 409);
    revision += 1;
    saves.push(body);
    return json({ settings: body.settings, revision, warnings: [] });
  });
  await page.route(`**${emotesPath}`, async (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(await response()),
  }));
  await page.route(`**${pointsSummaryPath}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ jackpots: { emote_slots: 1_256 } }),
  }));
  return saves;
};

test("picker lists only the active 7TV set and keeps stale symbols saveable (protects=the picker names the active set, excludes non-active emotes, renders bounded CDN images in options and rows, reserves a missing tile, mentions 7TV in search, and permits explicit save; fails_when=images are missing or overflow, the search omits 7TV, or a stale symbol blocks saving; no_claim=the live 7TV account's actual current set)", async ({ page }, testInfo: TestInfo) => {
  const saves = await installPickerPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);

  const pageRoot = page.locator(".module-detail--settings-page");
  const firstSymbol = pageRoot.getByRole("button", { name: `${SLOT_COPY.chooseSymbol}: oldwave` });
  await expect(pageRoot.locator(".slot-symbol-missing").first()).toHaveText("not in the active 7TV set");
  const rows = pageRoot.locator(".slot-reel-table tbody tr");
  await expect(rows.nth(0).locator("img")).toHaveCount(0);
  await expect(rows.nth(0).locator(".slot-symbol-placeholder")).toBeVisible();
  for (const index of [1, 2]) {
    const image = rows.nth(index).locator(".slot-symbol img");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    expect(await image.boundingBox()).toMatchObject({ width: 28, height: 28 });
  }
  await expect(rows.nth(1).locator("img")).toHaveAttribute("src", activeResponse.sevenTv.items[0]?.imageUrl ?? "");
  await firstSymbol.click();

  const picker = page.getByRole("dialog", { name: SLOT_COPY.picker.title });
  await expect(picker).toHaveCSS("transform", "none");
  await expect(picker.getByRole("combobox")).toHaveAttribute("placeholder", "Search emoji, Twitch or 7TV emotes");
  for (const code of ["pixelwave", "moonwave"]) {
    const image = picker.getByRole("option", { name: new RegExp(code, "u") }).locator("img");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    expect(await image.boundingBox()).toMatchObject({ width: 20, height: 20 });
  }
  await expect(picker.getByRole("option", { name: /pixelwave/u }).locator("img")).toHaveAttribute("src", activeResponse.sevenTv.items[0]?.imageUrl ?? "");
  await expect(picker.getByText("7TV", { exact: true })).toBeVisible();
  await expect(picker.getByText("7TV · active set: Night Shift")).toBeVisible();
  await expect(picker.getByRole("option", { name: /pixelwave/u })).toBeVisible();
  await expect(picker.getByRole("option", { name: /not-active/u })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("slot-picker-7tv.png"), fullPage: false, animations: "disabled" });
  await page.keyboard.press("Escape");

  const minimum = pageRoot.getByLabel(SLOT_COPY.minStake, { exact: true });
  await minimum.fill("16");
  const save = pageRoot.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  const savedSettings = saves[0]?.settings as { symbols: readonly { source: string; code: string }[]; minStake: number } | undefined;
  expect(savedSettings?.minStake).toBe(16);
  expect(savedSettings?.symbols[0]).toMatchObject({ source: "seven_tv", code: "oldwave" });
});

test("overlay follows the reference and channel locale (protects=two-row layout, minimum type and image sizes, truncated login, localized outcome and numbers, opaque contrast, and dashed fallbacks survive replacement; fails_when=the bar is oversized, text is undersized, dashboard locale leaks, or failed images remain; no_claim=OBS transport and real CDN availability)", async ({ page }, testInfo: TestInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockImages(page);
  await page.goto("/tests/e2e/emote-slot-overlay-fixture.html");

  const overlay = page.getByRole("group", { name: emoteSlotOverlayLabels("de").result });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("+70");
  await expect(overlay).toContainText("1.256");
  await expect(overlay.locator(".emote-slot-overlay__outcome")).toHaveText(emoteSlotOverlayLabels("de").outcomes.win);
  await expect(overlay).toHaveAttribute("data-reduced-motion", "true");
  const bar = await overlay.boundingBox();
  expect(bar?.width).toBeLessThanOrEqual(640);
  expect(bar?.height).toBeLessThanOrEqual(160);
  for (const tile of await overlay.getByTestId("emote-slot-reel").all()) {
    expect(await tile.boundingBox()).toMatchObject({ width: 64, height: 64 });
    await expect(tile).toHaveCSS("animation-name", "none");
  }
  await expect(overlay.locator(".emote-slot-overlay__glyph")).toHaveCSS("font-size", "38px");
  for (const image of await overlay.locator("img").all()) {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const box = await image.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(32);
    expect(box?.height).toBeGreaterThanOrEqual(32);
  }
  for (const element of await overlay.locator(".emote-slot-overlay__main, .emote-slot-overlay__login").all()) {
    expect(await element.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(32);
  }
  for (const element of await overlay.locator(".emote-slot-overlay__secondary").all()) {
    expect(await element.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(22);
  }
  await expect(overlay.locator(".emote-slot-overlay__main").first()).toHaveCSS("font-family", /mono/u);
  const login = overlay.locator(".emote-slot-overlay__login");
  await expect(login).toHaveText("pixelwanderer_with_a_long_login");
  await expect(login).toHaveCSS("text-overflow", "ellipsis");
  expect(await login.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await login.evaluate((node) => Number(getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
  const reels = await overlay.locator(".emote-slot-overlay__reels").boundingBox();
  const name = await login.boundingBox();
  const net = await overlay.locator(".emote-slot-overlay__result .emote-slot-overlay__main").boundingBox();
  const outcome = await overlay.locator(".emote-slot-overlay__outcome").boundingBox();
  const jackpot = await overlay.locator(".emote-slot-overlay__jackpot").boundingBox();
  expect(name?.x).toBeGreaterThan((reels?.x ?? 0) + (reels?.width ?? 0));
  expect(net?.x).toBeGreaterThan((name?.x ?? 0) + (name?.width ?? 0));
  expect(outcome?.y).toBeGreaterThan((net?.y ?? 0) + (net?.height ?? 0) - 1);
  expect(jackpot?.y).toBeGreaterThan((reels?.y ?? 0) + (reels?.height ?? 0));
  const jackpotLabel = await overlay.locator(".emote-slot-overlay__jackpot .emote-slot-overlay__secondary").boundingBox();
  const jackpotValue = await overlay.locator(".emote-slot-overlay__jackpot .emote-slot-overlay__main").boundingBox();
  expect(jackpotLabel?.x).toBe(reels?.x);
  expect((jackpotValue?.x ?? 0) + (jackpotValue?.width ?? 0)).toBe((net?.x ?? 0) + (net?.width ?? 0));
  const colors = await overlay.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, colors: [...node.querySelectorAll("strong, .emote-slot-overlay__secondary")].map((child) => getComputedStyle(child).color) }));
  expect(colors.background).toMatch(/^rgb\(/u);
  const luminance = (rgb: string): number => {
    const [red = 0, green = 0, blue = 0] = (rgb.match(/\d+/gu) ?? []).map((value) => { const channel = Number(value) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  for (const color of colors.colors) expect((luminance(color) + 0.05) / (luminance(colors.background) + 0.05)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: testInfo.outputPath("slot-overlay-spin.png"), fullPage: false, animations: "disabled" });

  await page.getByRole("button", { name: "Trigger next spin" }).click();
  await expect(overlay).toHaveAttribute("data-spin-id", "fixture-spin-two");
  await expect(overlay).toContainText("±0");
  await expect(overlay).toContainText("1.300");
  await expect(overlay.locator(".emote-slot-overlay__outcome")).toHaveText(emoteSlotOverlayLabels("de").outcomes.pair);
  await expect(overlay.locator("img")).toHaveCount(0);
  for (const code of ["ghostwave", "moonwave", "pixelwave"]) {
    await expect(overlay.getByText(code, { exact: true })).toBeVisible();
    expect(await overlay.getByText(code, { exact: true }).evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)).toBe(true);
    await expect(overlay.getByText(code, { exact: true }).locator("..")).toHaveCSS("border-top-style", "dashed");
  }
  await page.screenshot({ path: testInfo.outputPath("slot-overlay-replaced-spin.png"), fullPage: false, animations: "disabled" });
});

test("revision remount resumes reel and jackpot animations from elapsed presentation time (protects=an overlay revision preserves a live spin's reel and jackpot highlight progress; fails_when=the remounted reel or jackpot highlight starts near time zero; no_claim=animation smoothness on every OBS device)", async ({ page }) => {
  await page.goto("/tests/e2e/emote-slot-overlay-fixture.html");
  const overlay = page.getByTestId("emote-slot-overlay");
  await page.getByRole("button", { name: "Trigger next spin" }).click();
  await expect(overlay).toHaveAttribute("data-spin-id", "fixture-spin-two");
  await page.waitForTimeout(450);

  const activeTimesBeforeRemount = await overlay.evaluate((node) => {
    const reel = node.querySelector<HTMLElement>("[data-reel-index='0']");
    const highlight = node.querySelector<HTMLElement>(".emote-slot-overlay__jackpot .emote-slot-overlay__main");
    return {
      reel: reel?.getAnimations().find((animation) => animation.playState === "running")?.effect?.getComputedTiming().progress,
      highlight: highlight?.getAnimations().find((animation) => animation.playState === "running")?.effect?.getComputedTiming().progress,
    };
  });
  expect(Number(activeTimesBeforeRemount.reel)).toBeGreaterThan(0.1);
  expect(Number(activeTimesBeforeRemount.highlight)).toBeGreaterThan(0.1);

  await page.getByRole("button", { name: "Remount overlay revision" }).click();
  await page.waitForTimeout(80);

  const activeTimesAfterRemount = await overlay.evaluate((node) => {
    const reel = node.querySelector<HTMLElement>("[data-reel-index='0']");
    const highlight = node.querySelector<HTMLElement>(".emote-slot-overlay__jackpot .emote-slot-overlay__main");
    return {
      reel: reel?.getAnimations().find((animation) => animation.playState === "running")?.effect?.getComputedTiming().progress,
      highlight: highlight?.getAnimations().find((animation) => animation.playState === "running")?.effect?.getComputedTiming().progress,
    };
  });
  expect.soft(Number(activeTimesAfterRemount.reel)).toBeGreaterThanOrEqual(Number(activeTimesBeforeRemount.reel));
  expect.soft(Number(activeTimesAfterRemount.highlight)).toBeGreaterThanOrEqual(Number(activeTimesBeforeRemount.highlight));
});

test("settled reel and jackpot highlight stay static after a revision remount (protects=elapsed reel and jackpot animations remain settled while the result is still visible; fails_when=revision remount starts a reel or jackpot highlight animation again; no_claim=exact compositor timing on every Chromium platform)", async ({ page }) => {
  await page.goto("/tests/e2e/emote-slot-overlay-fixture.html");
  const overlay = page.getByTestId("emote-slot-overlay");
  await page.getByRole("button", { name: "Trigger next spin" }).click();
  await expect(overlay).toHaveAttribute("data-spin-id", "fixture-spin-two");
  await page.waitForTimeout(3_200);

  await page.getByRole("button", { name: "Remount overlay revision" }).click();

  await expect(overlay).toBeVisible();
  await page.waitForTimeout(80);
  await expect.poll(() => overlay.evaluate((node) => node.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
});

test("7TV status space stays fixed across loading and provider states (protects=loading, long active-set names, no account, and unavailable keep identical picker and status geometry; fails_when=provider content moves or resizes the picker or its status footer; no_claim=layout at mobile widths)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release: (value: unknown) => void = () => undefined;
  await installPickerPage(page, () => new Promise((resolve) => { release = resolve; }));
  for (const status of ["ok", "no_account", "unavailable"] as const) {
    await page.goto(`/channels/${CHANNEL_ID}/modules/emote_slots`);
    await page.getByRole("button", { name: `${SLOT_COPY.chooseSymbol}: oldwave` }).click();
    const picker = page.getByRole("dialog", { name: SLOT_COPY.picker.title });
    const footer = picker.locator(".slot-picker-status--seven-tv");
    await expect(footer).toContainText(SLOT_COPY.sevenTvLoading);
    await expect(picker).not.toHaveAttribute("data-starting-style");
    await expect(picker).toHaveCSS("transform", "none");
    const initialPicker = await picker.boundingBox();
    const initialFooter = await footer.boundingBox();
    const setName = "Night Shift ".repeat(7).slice(0, 80);
    release({ ...activeResponse, sevenTv: { status, setName: status === "ok" ? setName : null, items: status === "ok" ? activeResponse.sevenTv.items : [] } });
    await expect(footer).toContainText(status === "ok" ? SLOT_COPY.sevenTvActiveSet(setName) : status === "no_account" ? SLOT_COPY.sevenTvNoAccount : SLOT_COPY.sevenTvUnavailable);
    expect(await picker.boundingBox()).toEqual(initialPicker);
    expect(await footer.boundingBox()).toEqual(initialFooter);
    expect(initialFooter?.height).toBe(42);
    await expect(footer).toContainText(SLOT_COPY.sevenTvChatHint);
  }
});
