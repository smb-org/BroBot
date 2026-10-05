import { expect, test } from "@playwright/test";

test("field error and warning slots keep their layout boxes stable", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(page.locator(".ui-textarea__warnings")).toBeVisible();

  const selectors = [".ui-field", ".ui-number-field__control", ".ui-number-field", ".ui-select", ".ui-tag-input", ".ui-textarea"];
  const before = await Promise.all(selectors.map(async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (box === null) throw new Error(`Missing layout box for ${selector}.`);
    return box.height;
  }));

  await page.getByRole("button", { name: "Toggle issues" }).click();
  await expect(page.locator(".ui-tag-input__warning")).toContainText("A duplicate warning that should");
  const tagError = page.locator(".ui-tag-input__control .mantine-InputWrapper-error");
  const tagWarning = page.locator(".ui-tag-input__warning");
  const tagErrorBox = await tagError.boundingBox();
  const tagWarningBox = await tagWarning.boundingBox();
  if (tagErrorBox === null || tagWarningBox === null) throw new Error("TagInput error and warning rows should have layout boxes.");
  expect(tagErrorBox.y + tagErrorBox.height).toBeLessThanOrEqual(tagWarningBox.y);
  const markerY = await tagError.locator("[aria-hidden='true']").first().evaluate((element) => Math.round(element.getBoundingClientRect().y));
  const copyY = await tagError.locator(".ui-text-reveal__copy").evaluate((element) => Math.round(element.getBoundingClientRect().y));
  expect(Math.abs(copyY - markerY)).toBeLessThanOrEqual(1);
  const after = await Promise.all(selectors.map(async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (box === null) throw new Error(`Missing layout box for ${selector}.`);
    return box.height;
  }));
  expect(after).toEqual(before);

  const preview = page.locator(".ui-chat-preview");
  const previewHeight = (await preview.boundingBox())?.height;
  await page.getByRole("button", { name: "Toggle preview" }).click();
  await expect(preview.locator(".ui-chat-preview__text")).toHaveAttribute("title", /long preview/u);
  expect((await preview.boundingBox())?.height).toBe(previewHeight);
  expect(await preview.locator(".ui-chat-preview__count").evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.locator(".mantine-Modal-content");
  await expect(dialog).toBeVisible();
  const dialogHeight = (await dialog.boundingBox())?.height;
  if (dialogHeight === undefined) throw new Error("Dialog should have a stable layout box.");
  await page.getByRole("button", { name: "Toggle dialog error" }).click();
  await expect(page.getByText("A dialog error.")).toBeVisible();
  const dialogAfterError = await dialog.boundingBox();
  if (dialogAfterError === null) throw new Error("Dialog should keep its layout box while showing an error.");
  expect(dialogAfterError.height).toBeCloseTo(dialogHeight, 2);
});

test("the save bar keeps its height on mobile", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  await expect(page.locator(".ui-save-bar")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileHeight = (await page.locator(".ui-save-bar").boundingBox())?.height;
  expect(mobileHeight).toBe(64);
});

test("compact header selects remain 44px when hints and errors change", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  const select = page.locator("#layout-header-channel").locator("xpath=ancestor::div[contains(@class, 'ui-select')]");
  await expect(select).toBeVisible();
  expect((await select.boundingBox())?.height).toBe(44);

  await page.getByRole("button", { name: "Toggle issues" }).click();
  expect((await select.boundingBox())?.height).toBe(44);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await select.boundingBox())?.height).toBe(44);

  await page.getByRole("button", { name: "Toggle issues" }).click();
  expect((await select.boundingBox())?.height).toBe(44);
});

test("save action width stays fixed across pending and idle states on desktop and mobile", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  const save = page.locator(".ui-save-bar__save");
  const discard = page.locator(".ui-save-bar__discard");
  const measure = async () => ({
    save: await save.boundingBox(),
    discard: await discard.boundingBox(),
  });

  const beforeDesktop = await measure();
  await page.getByRole("button", { name: "Toggle save pending" }).click();
  await expect(save).toContainText("Saving settings …");
  const pendingDesktop = await measure();
  expect(pendingDesktop.save?.width).toBe(beforeDesktop.save?.width);
  expect(pendingDesktop.discard?.x).toBe(beforeDesktop.discard?.x);

  await page.setViewportSize({ width: 390, height: 844 });
  const beforeMobile = await measure();
  await page.getByRole("button", { name: "Toggle save pending" }).click();
  await expect(save).toContainText("Save");
  const idleMobile = await measure();
  expect(idleMobile.save?.width).toBe(beforeMobile.save?.width);
  expect(idleMobile.discard?.x).toBe(beforeMobile.discard?.x);
});

test("clipped hints and dialog errors reveal full copy by keyboard without moving reserved rows", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  const field = page.locator(".ui-field").first();
  const fieldHeight = (await field.boundingBox())?.height;
  const hint = field.locator(".ui-field__hint");
  const hintTrigger = hint.locator(".ui-text-reveal__trigger");
  await hintTrigger.focus();
  await hintTrigger.press("Enter");
  const hintPopup = page.getByRole("tooltip");
  await expect(hintPopup).toHaveText("A short name.");
  expect(await hintPopup.evaluate((element) => element.closest(".ui-field"))).not.toBeNull();
  expect((await field.boundingBox())?.height).toBe(fieldHeight);
  await hintTrigger.press("Enter");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Layout dialog" });
  const dialogHeight = (await dialog.boundingBox())?.height;
  await dialog.getByRole("button", { name: "Toggle dialog error" }).click();
  const error = dialog.locator(".ui-dialog__error-slot");
  const errorTrigger = error.locator(".ui-text-reveal__trigger");
  await errorTrigger.focus();
  await errorTrigger.press("Space");
  const errorPopup = page.getByRole("tooltip");
  await expect(errorPopup).toContainText("the step needed to correct the request");
  expect(await errorPopup.evaluate((element) => element.closest(".mantine-Modal-content"))).not.toBeNull();
  expect((await dialog.boundingBox())?.height).toBe(dialogHeight);
  await errorTrigger.press("Space");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
