import { expect, test, type Locator } from "@playwright/test";
import { waitForWebFonts } from "./web-fonts";

test("primitive controls use the shared desktop height and portal layout stays stable", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html?lang=de");
  const anchor = page.locator(".e2e-layout-anchor");
  await expect(anchor).toBeVisible();

  const controls = [
    anchor.locator(":scope > .ui-button").first(),
    anchor.locator(".unit-input__input"),
    anchor.getByRole("combobox", { name: "Mode", exact: true }),
    anchor.locator(".ui-select__search-control > .ui-select__trigger"),
    anchor.locator(".segment-choice").first(),
    anchor.locator(".segment-choice-field--compact .segment-choice"),
  ];
  for (const control of controls) expect((await control.boundingBox())?.height).toBe(32);
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 800 });
    const labels = anchor.locator(".segment-choice__label-full");
    expect(await labels.evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth))).toBe(true);
  }

  await waitForWebFonts(page);
  const anchorHeight = (await anchor.boundingBox())?.height;
  await anchor.getByRole("button", { name: "Popover help" }).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  expect((await anchor.boundingBox())?.height).toBe(anchorHeight);

  await anchor.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Control dialog" })).toBeVisible();
  expect((await anchor.boundingBox())?.height).toBe(anchorHeight);
});

test("segmented labels fit in German and English at both desktop widths", async ({ page }) => {
  for (const language of ["de", "en"] as const) {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 800 });
      await page.goto(`/tests/e2e/ui-basic-controls-fixture.html?lang=${language}`);
      const labelsFit = await page.locator(".segment-choice__label-full").evaluateAll((labels) =>
        labels.every((label) => label.scrollWidth <= label.clientWidth));
      expect(labelsFit).toBe(true);
    }
  }
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
    page.locator('.ui-select__trigger[role="combobox"]').first(),
    page.locator(".ui-select__search-control > .ui-select__trigger").first(),
    page.locator(".segment-choice__option").first(),
  ];
  for (const control of controls) expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(40);

  // The compact shell grows with its touch-sized options instead of clipping them.
  const compact = page.locator(".segment-choice-field--compact .segment-choice");
  const shell = await compact.boundingBox();
  if (shell === null) throw new Error("The compact segment control is not visible.");
  const options = compact.locator(".segment-choice__option");
  for (let index = 0; index < await options.count(); index += 1) {
    const option = await options.nth(index).boundingBox();
    if (option === null) throw new Error("A compact segment option is not visible.");
    expect(option.height).toBeGreaterThanOrEqual(40);
    expect(option.y).toBeGreaterThanOrEqual(shell.y);
    expect(option.y + option.height).toBeLessThanOrEqual(shell.y + shell.height + 0.5);
  }
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

test("portals opened from a narrow inspector stay above its layers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");
  const inspector = page.locator(".list-detail__inspector");
  await expect(inspector).toBeVisible();
  const inspectorLayer = await inspector.evaluate((element) => Number(getComputedStyle(element).zIndex));
  const portalLayer = async (portal: Locator): Promise<number> => portal.evaluate((element) => {
    let ancestor: Element | null = element;
    while (ancestor !== null) {
      const zIndex = Number.parseInt(getComputedStyle(ancestor).zIndex, 10);
      if (Number.isFinite(zIndex) && zIndex > 0) return zIndex;
      ancestor = ancestor.parentElement;
    }
    return 0;
  });

  const select = page.getByRole("combobox", { name: "Inspector select" });
  await select.click();
  const selectPopup = page.locator(".ui-select__dropdown");
  await expect(page.getByRole("option", { name: "Two" })).toBeVisible();
  expect(await portalLayer(selectPopup)).toBeGreaterThan(inspectorLayer);
  await page.getByRole("option", { name: "Two" }).click();

  const search = page.getByRole("combobox", { name: "Inspector search" });
  await search.fill("Paris");
  const searchOption = page.getByRole("option", { name: "Paris" });
  await expect(searchOption).toBeVisible();
  expect(await portalLayer(page.locator(".ui-select__dropdown").last())).toBeGreaterThan(inspectorLayer);
  await searchOption.click();

  await page.getByRole("button", { name: "Inspector actions" }).click();
  const menuItem = page.getByRole("menuitem", { name: "Inspector action" });
  await expect(menuItem).toBeVisible();
  expect(await portalLayer(page.locator(".ui-action-menu__dropdown"))).toBeGreaterThan(inspectorLayer);
  await menuItem.click();

  const help = page.getByRole("button", { name: "Inspector help" });
  await help.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect.poll(() => portalLayer(tooltip)).toBeGreaterThan(inspectorLayer);
  await help.press("Escape");

  await page.getByRole("button", { name: "Open inspector dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Control dialog" });
  await expect(dialog).toBeVisible();
  const dialogLayers = await dialog.evaluate((element) => ({
    backdrop: Number(getComputedStyle(element.parentElement?.querySelector("[data-slot='dialog-backdrop']") ?? element).zIndex),
    content: Number(getComputedStyle(element).zIndex),
  }));
  expect(dialogLayers.backdrop).toBeGreaterThan(inspectorLayer);
  expect(dialogLayers.content).toBeGreaterThan(dialogLayers.backdrop);
  const dialogContentIsHitTestable = await dialog.locator("p").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === element || element.contains(hit);
  });
  expect(dialogContentIsHitTestable).toBe(true);
});

test("inline switches, field adornments, and select errors keep stable layout", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html");

  const search = page.getByRole("textbox", { name: "Members" });
  await expect(search).toBeVisible();
  const iconInput = page.getByRole("textbox", { name: "Icon input" });
  expect(await iconInput.evaluate((input) => Number.parseFloat(getComputedStyle(input).paddingLeft))).toBeGreaterThan(8);

  const stableSelect = page.locator(".ui-select").filter({ has: page.getByRole("combobox", { name: "Stable error" }) });
  const originalHeight = (await stableSelect.boundingBox())?.height;
  await page.getByRole("button", { name: "Toggle select error" }).click();
  await expect(page.getByRole("alert")).toContainText("Choose a mode");
  expect((await stableSelect.boundingBox())?.height).toBe(originalHeight);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/ui-basic-controls-fixture.html?lang=de");
  const segment = page.locator(".segment-choice");
  await expect(segment.locator(".segment-choice__label-full").first()).toBeHidden();
  await expect(segment.locator(".segment-choice__label-compact").first()).toBeVisible();
  const switchRow = page.getByRole("switch", { name: "Inline inspector switch" }).locator("xpath=..");
  const rowLayout = await switchRow.evaluate((row) => {
    const track = row.querySelector("[role='switch']");
    const label = row.querySelector(".ui-switch-row__copy");
    if (track === null || label === null) return null;
    return {
      display: getComputedStyle(row).display,
      trackRight: track.getBoundingClientRect().right,
      rowRight: row.getBoundingClientRect().right,
      labelLeft: label.getBoundingClientRect().left,
      trackCenter: track.getBoundingClientRect().top + track.getBoundingClientRect().height / 2,
      labelCenter: label.getBoundingClientRect().top + label.getBoundingClientRect().height / 2,
    };
  });
  expect(rowLayout?.display).toBe("grid");
  expect(rowLayout?.trackRight).toBeGreaterThan(rowLayout?.labelLeft ?? 0);
  expect((rowLayout?.rowRight ?? 0) - (rowLayout?.trackRight ?? 0)).toBeGreaterThanOrEqual(7);
  expect(Math.abs((rowLayout?.trackCenter ?? 0) - (rowLayout?.labelCenter ?? 0))).toBeLessThanOrEqual(1);
});
