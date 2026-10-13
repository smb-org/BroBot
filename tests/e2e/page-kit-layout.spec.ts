import { expect, test } from "@playwright/test";

test("page kit stays within narrow viewports, uses shared collection widths, and saves explicitly", async ({ page }) => {
  await page.goto("/tests/e2e/page-kit-fixture.html");
  await expect(page.locator(".collection-page__list")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const [width, expectedListWidth] of [[390, null], [1280, 360], [1920, 420], [2560, 480]] as const) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".collection-page__list");
      const detail = document.querySelector<HTMLElement>(".collection-page__detail");
      if (list === null || detail === null) throw new Error("The collection list and detail should render.");
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        listWidth: list.getBoundingClientRect().width,
        detailOverflowY: getComputedStyle(detail).overflowY,
        detailScrollHeight: detail.scrollHeight,
        detailClientHeight: detail.clientHeight,
      };
    });
    const initialGeometry = {
      pageHeader: await page.locator(".page-header").boundingBox(),
      detail: await page.locator(".collection-page__detail").boundingBox(),
    };
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    if (expectedListWidth !== null) expect(geometry.listWidth).toBe(expectedListWidth);
    expect(geometry.detailOverflowY).toBe("auto");
    expect(geometry.detailScrollHeight).toBeGreaterThan(geometry.detailClientHeight);
    expect(initialGeometry.pageHeader).not.toBeNull();
    expect(initialGeometry.detail).not.toBeNull();
    await page.waitForTimeout(250);
    const settledGeometry = {
      pageHeader: await page.locator(".page-header").boundingBox(),
      detail: await page.locator(".collection-page__detail").boundingBox(),
    };
    expect(settledGeometry).toEqual(initialGeometry);
  }

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".ui-save-bar__status")).toContainText("Saved.");
});

test("the mobile tool editor keeps its preview and save bar visible while the window scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/page-kit-fixture.html?tool");
  const preview = page.getByTestId("sticky-preview");
  const saveBar = page.locator(".overlay-editor .ui-save-bar--persistent");
  const field = page.getByTestId("tool-field");

  await expect(preview).toBeVisible();
  await expect(saveBar).toBeVisible();
  await field.click();
  await expect(field).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 600); });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(async () => (await preview.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(76);
  await expect.poll(async () => (await preview.boundingBox())?.y ?? 0).toBeLessThanOrEqual(92);

  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
  await expect.poll(async () => {
    const previewBox = await preview.boundingBox();
    const saveBox = await saveBar.boundingBox();
    return previewBox !== null && saveBox !== null && previewBox.y >= 76 && previewBox.y <= 92 && Math.abs(saveBox.y + saveBox.height - 844) <= 2;
  }).toBe(true);
});
