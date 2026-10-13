import { expect, test } from "@playwright/test";

test.use({ locale: "en-US" });

test("TemplateTextField supports the brace, filter, insert, and Escape keyboard flow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const input = page.getByRole("textbox", { name: "Reply" });
  const dropdown = page.locator(".ui-template-text-field__suggestions-dropdown");
  const contentBelow = page.locator("#content-below-picker");
  await expect(input).toBeVisible();
  const beforeContent = await contentBelow.boundingBox();

  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.type("Hello {us");
  await expect(page.getByRole("listbox", { name: "Choose a variable" })).toBeVisible();
  await expect(page.getByText("This module", { exact: true })).toBeVisible();
  await expect(page.getByText("nachtfalke", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /\{user\}/u })).toHaveCount(1);
  await expect(page.getByRole("option", { name: /\{viewers\}/u })).toHaveCount(0);

  const popup = await dropdown.boundingBox();
  expect(popup).not.toBeNull();
  expect(popup?.x).toBeGreaterThanOrEqual(0);
  expect((popup?.x ?? 0) + (popup?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await contentBelow.boundingBox()).toEqual(beforeContent);

  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("Hello {user}");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe("Hello {user}".length);

  await page.keyboard.type(" {missing");
  await expect(dropdown).toBeVisible();
  await expect(dropdown).toContainText("No variables found.");
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(input).toHaveValue("Hello {user} {missing");
  await expect(input).toBeFocused();
});
