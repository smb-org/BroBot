import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const viewports = [[1920, 1080], [1280, 800], [390, 844]] as const;
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

const measureBroadcastLayout = async (page: Page): Promise<{ headerHeight: number; titleHeight: number; contentTop: number }> =>
  page.evaluate(() => {
    const header = document.querySelector(".live-cockpit-header");
    const title = document.querySelector('[data-slot="stream-title-category"]');
    const content = document.querySelector('[data-slot="warning-banner"]');
    if (!(header instanceof HTMLElement) || !(title instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      throw new Error("Cockpit broadcast layout is not mounted.");
    }
    return {
      headerHeight: header.getBoundingClientRect().height,
      titleHeight: title.getBoundingClientRect().height,
      contentTop: content.getBoundingClientRect().top,
    };
  });

for (const [width, height] of viewports) {
  test(`broadcast loading keeps cockpit geometry fixed at ${String(width)}px`, async ({ page }) => {
    const channelId = `review-broadcast-layout-${String(width)}`;
    let releaseResponse = (): void => {};
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await installLiveCockpitMocks(page, { channelId, role: "manager" });
    await page.route(`**/api/channels/${channelId}/broadcast`, async (route: Route) => {
      await responseGate;
      return route.fulfill(json({ title: "A stable title for this stream", game: { id: "509658", name: "Just Chatting" }, manageScopeAvailable: true }));
    });
    await page.setViewportSize({ width, height });
    await page.goto(`/channels/${channelId}`);

    const titleSlot = page.locator('[data-slot="stream-title-category"]');
    await expect(titleSlot).toContainText("Loading stream title and category.");
    const loadingLayout = await measureBroadcastLayout(page);
    releaseResponse();
    await expect(titleSlot).toContainText("A stable title for this stream");
    const loadedLayout = await measureBroadcastLayout(page);

    expect(loadedLayout.headerHeight).toBeCloseTo(loadingLayout.headerHeight, 0);
    expect(loadedLayout.titleHeight).toBeCloseTo(loadingLayout.titleHeight, 0);
    expect(loadedLayout.contentTop).toBeCloseTo(loadingLayout.contentTop, 0);
  });
}

test("broadcast errors degrade footer health and keep retry styled", async ({ page }) => {
  const channelId = "review-broadcast-error";
  await installLiveCockpitMocks(page, { channelId, role: "manager" });
  await page.route(`**/api/channels/${channelId}/broadcast`, (route) => route.fulfill(json({ error: "broadcast_unavailable" }, 503)));
  await page.goto(`/channels/${channelId}`);

  const footer = page.locator(".live-cockpit__status");
  await expect(footer).toContainText("Live data is unavailable right now.");
  await expect(footer).not.toContainText(/All systems ready|Alles bereit/u);
  await expect(footer.locator('.status-led[data-status="warn"]')).toBeVisible();
  await expect(page.locator(".live-cockpit-broadcast__title-row > .ui-button")).toHaveAttribute("data-variant", "secondary");
});

test("broadcast editor uses a styled single-value category search", async ({ page }) => {
  const channelId = "review-broadcast-editor";
  await installLiveCockpitMocks(page, { channelId, role: "manager" });
  await page.route(`**/api/channels/${channelId}/games**`, (route) => route.fulfill(json({ games: [
    { id: "12345", name: "Stardew Valley", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/12345-{width}x{height}.jpg" },
  ] })));
  await page.goto(`/channels/${channelId}`);

  const editButton = page.locator(".live-cockpit-broadcast__edit");
  await expect(editButton).toHaveAttribute("data-variant", "secondary");
  await editButton.click();
  const dialog = page.getByRole("dialog");
  const categorySearch = dialog.locator(".ui-game-multi-select--single-value input");
  await expect(categorySearch).toBeVisible();
  await expect(categorySearch).toHaveAttribute("aria-autocomplete", "list");
  const fieldsToFooterGap = await dialog.evaluate((element) => {
    const fields = element.querySelector(".live-cockpit-broadcast__form");
    const footer = element.querySelector(".ui-form-dialog__footer");
    if (!(fields instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error("Broadcast editor fields or footer are missing.");
    return footer.getBoundingClientRect().top - fields.getBoundingClientRect().bottom;
  });
  expect(fieldsToFooterGap).toBeLessThanOrEqual(10);
  await expect(dialog.getByText("1 von 1 ausgewählt")).toHaveCount(0);
  await expect(dialog.getByText("Es kann nur eine Kategorie gewählt werden.")).toHaveCount(0);
  await categorySearch.fill("Stardew Valley");
  await page.getByRole("option", { name: "Stardew Valley" }).click();
  await expect(dialog.locator(".ui-game-multi-select__single-value")).toContainText("Stardew Valley");
});

test("snooze retry details appear on the ad row and the footer signals warning", async ({ page }) => {
  const channelId = "review-ad-snooze-retry";
  await installLiveCockpitMocks(page, {
    channelId,
    role: "manager",
    modules: [{ id: "ads", enabled: true, settings: "{}" }],
    upcomingAd: true,
  });
  await page.route(`**/api/channels/${channelId}/modules/ads/snooze`, (route) => route.fulfill(json({
    error: "ad_snooze_failed",
    reason: "rate_limited",
    detail: { retryAfter: Date.now() + 60_000 },
  }, 429)));
  await page.goto(`/channels/${channelId}`);

  await page.locator(".live-cockpit-next-item button").click();
  await expect(page.locator(".live-cockpit-next-item__reason.is-warning")).toContainText(/Try again after|Erneut möglich ab/u);
  const footer = page.locator(".live-cockpit__status");
  await expect(footer).toContainText(/Try again after|Erneut möglich ab/u);
  await expect(footer.locator('.status-led[data-status="warn"]')).toBeVisible();
});

test("scope recovery and retry actions use the shared button kit", async ({ page }) => {
  const channelId = "review-broadcast-scope-missing";
  await installLiveCockpitMocks(page, { channelId, role: "broadcaster", broadcasterMissingScopes: ["channel:manage:broadcast"] });
  await page.goto(`/channels/${channelId}`);

  const reconnectButton = page.locator(".live-cockpit-broadcast__actions .ui-button");
  await expect(reconnectButton).toHaveAttribute("data-variant", "secondary");
  await expect(page.locator('[data-slot="stream-title-category"]')).toContainText("channel:manage:broadcast");
  await expect(page.locator('[data-slot="stream-title-category"]')).toHaveCSS("height", "90px");
});
