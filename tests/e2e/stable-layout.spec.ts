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
  const copyY = await tagError.locator(".ui-truncated-text").evaluate((element) => Math.round(element.getBoundingClientRect().y));
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

test("clipped hints and dialog errors keep full copy in fixed reserved rows", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  const field = page.locator(".ui-field").first();
  const fieldHeight = (await field.boundingBox())?.height;
  const hint = field.locator(".ui-field__hint.ui-truncated-text");
  await expect(hint).toHaveAttribute("title", "A short name.");
  await expect(field.locator(".ui-field__description .sr-only")).toHaveText("A short name.");
  expect((await field.boundingBox())?.height).toBe(fieldHeight);

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Layout dialog" });
  const dialogHeight = (await dialog.boundingBox())?.height;
  const error = dialog.locator(".ui-dialog__error-slot");
  expect((await error.boundingBox())?.height).toBe(36);
  await dialog.getByRole("button", { name: "Toggle dialog error" }).click();
  const fullError = "A dialog error. This explains the complete reason and the step needed to correct the request.";
  await expect(error.locator(".form-error")).toHaveAttribute("title", fullError);
  await expect(error.locator(".form-error")).toContainText(fullError);
  await expect(error.locator(".form-error")).toHaveCSS("-webkit-line-clamp", "2");
  expect((await error.boundingBox())?.height).toBe(36);
  expect((await dialog.boundingBox())?.height).toBe(dialogHeight);
});
