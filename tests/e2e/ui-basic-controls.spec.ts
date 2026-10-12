import { expect, test } from "@playwright/test";

test("primitive controls use 32px desktop dimensions and portals preserve the page layout", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");
  const anchor = page.locator(".e2e-layout-anchor");
  await expect(anchor).toBeVisible();

  const controls = [
    anchor.locator(":scope > .ui-button").first(),
    anchor.locator(".unit-input__input"),
    anchor.locator('.ui-select__trigger[role="combobox"]'),
    anchor.locator(".ui-select__search-control > .ui-select__trigger"),
    anchor.locator(".segment-choice"),
  ];
  for (const control of controls) expect((await control.boundingBox())?.height).toBe(32);

  const anchorHeight = (await anchor.boundingBox())?.height;
  await anchor.getByRole("button", { name: "Popover help" }).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  expect((await anchor.boundingBox())?.height).toBe(anchorHeight);

  await anchor.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Control dialog" })).toBeVisible();
  expect((await anchor.boundingBox())?.height).toBe(anchorHeight);
});

test("control hit areas are at least 40px with a coarse pointer", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(new URL("/tests/e2e/ui-basic-controls-fixture.html", baseURL).toString());
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  const controls = [
    page.locator(".e2e-layout-anchor > .ui-button").first(),
    page.locator(".unit-input__input"),
    page.locator('.ui-select__trigger[role="combobox"]'),
    page.locator(".ui-select__search-control > .ui-select__trigger"),
    page.locator(".segment-choice__option").first(),
  ];
  for (const control of controls) expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  await context.close();
});

test("StatusLed colors follow the selected palette", async ({ page }) => {
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");
  const status = page.locator('.status-led[data-status="ok"]');
  const color = async (): Promise<string> => status.evaluate((element) => getComputedStyle(element).color);
  const tokenColor = async (): Promise<string> => page.evaluate(() => {
    const sample = document.createElement("span");
    sample.style.color = "var(--color-success-text)";
    document.body.appendChild(sample);
    const value = getComputedStyle(sample).color;
    sample.remove();
    return value;
  });

  expect(await color()).toBe(await tokenColor());
  const defaultPaletteColor = await color();
  await page.evaluate(() => { document.documentElement.dataset.palette = "indigo-nacht"; });
  expect(await color()).toBe(await tokenColor());
  expect(await color()).not.toBe(defaultPaletteColor);
});

test("ActionMenu opens with Enter and returns focus after Escape", async ({ page }) => {
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");
  const trigger = page.getByRole("button", { name: "More actions" });
  await trigger.focus();
  await page.keyboard.press("Enter");

  const item = page.getByRole("menuitem", { name: "Edit settings" });
  await expect(item).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(item).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a select can be opened, changed, and opened again", async ({ page }) => {
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");
  const mode = page.getByRole("combobox", { name: "Mode", exact: true });
  await mode.click();
  await page.getByRole("option", { name: "Two" }).click();
  await expect(mode).toContainText("Two");

  await mode.click();
  await page.getByRole("option", { name: "One" }).click();
  await expect(mode).toContainText("One");
});
