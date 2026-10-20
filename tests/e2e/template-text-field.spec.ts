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
  const userOption = page.getByRole("option", { name: /\{user\}/u });
  await expect(userOption).toHaveCount(1);
  await expect(userOption).toHaveAttribute("tabindex", "-1");
  const userOptionId = await userOption.getAttribute("id");
  expect(userOptionId).not.toBeNull();
  await expect(input).toHaveAttribute("aria-activedescendant", userOptionId ?? "");
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

test("ExpressionField inserts a filtered function and keeps its picker inside a 390px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const input = page.getByRole("textbox", { name: "JSONata expression" });
  const dropdown = page.locator(".ui-template-text-field__suggestions-dropdown");
  const contentBelow = page.locator("#content-below-expression");
  await expect(input).toBeVisible();
  const beforeContent = await contentBelow.boundingBox();

  await input.focus();
  await page.keyboard.type("$");
  await expect(page.getByRole("listbox", { name: "Insert function" })).toBeVisible();
  await expect(page.getByText("Text", { exact: true })).toBeVisible();
  await expect(page.getByText("Date", { exact: true })).toBeVisible();

  const fullPicker = await dropdown.boundingBox();
  expect(fullPicker).not.toBeNull();
  expect(fullPicker?.x).toBeGreaterThanOrEqual(0);
  expect((fullPicker?.x ?? 0) + (fullPicker?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(fullPicker?.y).toBeGreaterThanOrEqual(0);
  expect((fullPicker?.y ?? 0) + (fullPicker?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await contentBelow.boundingBox()).toEqual(beforeContent);

  await page.keyboard.type("from");
  await expect(page.getByRole("option", { name: /fromMillis/u })).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("$fromMillis(");
  await expect(page.locator(".ui-expression-field__signature")).toContainText("$fromMillis(milliseconds, picture)");
  await expect.poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe("$fromMillis(".length);

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("$from");
  await expect(dropdown).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(input).toHaveValue("$from");
  await expect(input).toBeFocused();
});

test("ExpressionField completes an existing call without duplicating its opening parenthesis", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const input = page.getByRole("textbox", { name: "JSONata expression" });
  await input.fill("$round($.amount, 2)");
  await input.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected an expression textarea.");
    element.setSelectionRange("$roun".length, "$roun".length);
  });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("listbox", { name: "Insert function" })).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(input).toHaveValue("$round($.amount, 2)");
});

test("ExpressionField completion remains one native undo step", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const expression = page.getByRole("textbox", { name: "JSONata expression" });
  await expression.focus();
  await page.keyboard.type("$rou");
  await page.keyboard.press("Enter");
  await expect(expression).toHaveValue("$round(");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(expression).toHaveValue("$rou");
});

test("TemplateTextField completion remains one native undo step", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const template = page.getByRole("textbox", { name: "Reply" });
  await template.focus();
  await page.keyboard.type("Hello {us");
  await page.keyboard.press("Enter");
  await expect(template).toHaveValue("Hello {user}");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(template).toHaveValue("Hello {us");
});

test("ExpressionField refuses a function insertion beyond its maximum length", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const expression = page.getByRole("textbox", { name: "JSONata expression" });
  const expressionBefore = `${"x".repeat(508)}$fo`;
  await expression.fill(expressionBefore);
  await page.keyboard.press("Enter");
  await expect(expression).toHaveValue(expressionBefore);
  await expect(page.getByText(/character limit/i)).toBeVisible();
});

test("TemplateTextField refuses a variable insertion beyond its maximum length", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");
  const template = page.getByRole("textbox", { name: "Reply" });
  const templateBefore = `${"x".repeat(17)}{us`;
  await template.fill(templateBefore);
  await page.keyboard.press("Enter");
  await expect(template).toHaveValue(templateBefore);
  await expect(page.locator(".ui-template-text-field__warning").getByText(/character limit/i)).toBeVisible();
});

test("template repair button stays inside the 390px field", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const input = page.getByRole("textbox", { name: "Reply" });
  await input.fill("Hello {usr} welcome ");
  const repair = page.getByRole("button", { name: "Insert {user}" });
  await expect(repair).toBeVisible();
  const geometry = await page.evaluate(() => {
    const warning = document.querySelector(".ui-template-text-field__warning");
    const button = warning?.querySelector("button");
    if (!(warning instanceof HTMLElement) || !(button instanceof HTMLElement)) throw new Error("The repair warning is missing.");
    const warningBounds = warning.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    return { warningRight: warningBounds.right, buttonRight: buttonBounds.right };
  });
  expect(geometry.buttonRight).toBeLessThanOrEqual(390);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.warningRight + 0.5);
});

test("template hint and character counter occupy separate space at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/template-text-field-fixture.html");

  const input = page.getByRole("textbox", { name: "Reply" });
  await input.fill("Hello {usr} welcome ");
  const geometry = await page.evaluate(() => {
    const row = document.querySelector(".ui-template-text-field__helper-row");
    const hint = row?.querySelector(".ui-template-text-field__helper-text");
    const count = row?.querySelector(".ui-template-text-field__count");
    if (!(row instanceof HTMLElement) || !(hint instanceof HTMLElement) || !(count instanceof HTMLElement)) {
      throw new Error("The template field helper elements are missing.");
    }
    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return {
      row: bounds(row),
      hint: bounds(hint),
      count: bounds(count),
      hintFullyVisible: hint.scrollHeight <= hint.clientHeight + 1,
    };
  });
  expect(geometry.hint.bottom).toBeLessThanOrEqual(geometry.count.top + 0.5);
  expect(geometry.count.right).toBeLessThanOrEqual(geometry.row.right + 0.5);
  expect(geometry.hintFullyVisible).toBe(true);
});
