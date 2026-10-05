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
  await expect(page.locator(".ui-tag-input__warning")).toContainText("A duplicate warning.");
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
  await page.getByRole("button", { name: "Toggle dialog error" }).click();
  await expect(page.getByText("A dialog error.")).toBeVisible();
  expect((await dialog.boundingBox())?.height).toBe(dialogHeight);
});

test("the save bar keeps its height on mobile", async ({ page }) => {
  await page.goto("/tests/e2e/layout-fixture.html");
  await expect(page.locator(".ui-save-bar")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileHeight = (await page.locator(".ui-save-bar").boundingBox())?.height;
  expect(mobileHeight).toBe(64);
});
