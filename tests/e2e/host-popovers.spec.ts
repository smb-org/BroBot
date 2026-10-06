import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ locale: "de-DE" });

const assertInsideViewport = async (page: Page, element: Locator): Promise<void> => {
  await expect(element).toBeVisible();
  await expect.poll(async () => {
    const box = await element.boundingBox();
    const viewport = page.viewportSize();
    return box !== null && viewport !== null
      && box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width
      && box.y + box.height <= viewport.height;
  }).toBe(true);
};

test("error summaries and clipped field text stay complete at mobile and inspector widths", async ({ page }) => {
  const cases = [
    { viewportWidth: 390, editorWidth: 390 },
    { viewportWidth: 1280, editorWidth: 592 },
  ];

  for (const { viewportWidth, editorWidth } of cases) {
    await page.setViewportSize({ width: viewportWidth, height: 844 });
    await page.goto("/tests/e2e/host-popovers-fixture.html");

    const editor = page.locator(".host-popovers-fixture__editor");
    await expect(editor).toBeVisible();
    expect((await editor.boundingBox())?.width).toBe(editorWidth);

    const status = editor.locator(".ui-save-bar__status");
    await expect(status).toContainText("3 Felder fehlerhaft");
    const statusBox = await status.boundingBox();
    const actionsBox = await editor.locator(".ui-save-bar__actions").boundingBox();
    if (statusBox === null || actionsBox === null) throw new Error("SaveBar status and actions should have layout boxes.");
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(actionsBox.x);

    const errorTrigger = status.getByRole("button", { name: "Fehlerhafte Felder anzeigen" });
    const errorPopover = page.getByRole("dialog", { name: "Fehlerhafte Felder" });
    const links = [
      { name: "Alpha: Enter a valid alpha value.", message: "Enter a valid alpha value.", details: true },
      { name: "Beta: Choose a value below the allowed maximum.", message: "Choose a value below the allowed maximum.", details: true },
      { name: "Gamma: This complete error explains how to correct the value without leaving the editor.", message: "This complete error explains how to correct the value without leaving the editor.", details: false },
    ];

    for (const link of links) {
      if (!(await errorPopover.isVisible())) await errorTrigger.click();
      await assertInsideViewport(page, errorPopover);
      expect(await errorPopover.evaluate((element) => element.closest(".list-detail__inspector"))).not.toBeNull();
      const errorLink = errorPopover.getByRole("button", { name: link.name });
      await assertInsideViewport(page, errorLink);
      await expect(errorPopover).toContainText(link.message);
      const wrappedMessage = errorLink.locator("span").nth(1);
      await expect(wrappedMessage).toHaveText(link.message);
      await expect.poll(async () => wrappedMessage.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
      await expect.poll(async () => wrappedMessage.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("anywhere");
      await errorLink.click();
      if (link.details) {
        await expect(editor.locator("details")).toHaveAttribute("data-editor-error", "true");
      } else {
        await expect(page.getByRole("textbox", { name: "Gamma" })).toBeFocused();
      }
    }

    const gamma = editor.locator(".ui-field").filter({ has: page.getByRole("textbox", { name: "Gamma" }) });
    const hint = "This complete hint stays readable when it is longer than the reserved field row and the editor clips its scrolling body. ".repeat(2);
    const hintText = gamma.locator(".ui-field__hint.ui-truncated-text");
    const fieldError = gamma.locator(".mantine-InputWrapper-error .ui-truncated-text");
    await expect(hintText).toHaveAttribute("title", hint);
    await expect(gamma.locator(".ui-field__description .sr-only")).toHaveText(hint);
    await expect(fieldError).toHaveAttribute("title", "This complete error explains how to correct the value without leaving the editor.");
    await expect(gamma.locator(".mantine-InputWrapper-error .sr-only")).toHaveText("This complete error explains how to correct the value without leaving the editor.");
    const gammaInput = gamma.getByRole("textbox", { name: "Gamma" });
    const gammaDescribedBy = (await gammaInput.getAttribute("aria-describedby"))?.split(" ") ?? [];
    expect(gammaDescribedBy).toContain("field-gamma-description");
    expect(gammaDescribedBy).toContain("field-gamma-error");

    await editor.getByRole("button", { name: "Close inspector" }).click();
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Long message dialog" });
    await expect(dialog).toBeVisible();
    const dialogErrorSlot = dialog.locator(".ui-dialog__error-slot");
    const dialogError = dialogErrorSlot.locator(".form-error");
    await expect(dialogError).toHaveAttribute("title", "This complete dialog error stays readable near the right edge and ends with the step needed to correct the request.");
    expect((await dialogErrorSlot.boundingBox())?.height).toBe(36);
    await expect(dialogError).toHaveCSS("-webkit-line-clamp", "2");
    await page.getByRole("button", { name: "Cancel" }).click();
  }
});

test("Escape closes the open error summary before the inspector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/host-popovers-fixture.html");

  const editor = page.locator(".host-popovers-fixture__editor");
  const errorTrigger = editor.locator(".ui-save-bar__invalid-trigger");
  const errorPopover = page.getByRole("dialog", { name: "Fehlerhafte Felder" });
  const firstErrorLink = errorPopover.getByRole("button", { name: "Alpha: Enter a valid alpha value." });
  const secondErrorLink = errorPopover.getByRole("button", { name: "Beta: Choose a value below the allowed maximum." });

  await editor.getByRole("button", { name: "Close inspector" }).focus();
  for (let index = 0; index < 20 && !(await errorTrigger.evaluate((element) => element === document.activeElement)); index += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(errorTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(firstErrorLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(secondErrorLink).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(errorPopover).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(errorTrigger).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(".list-detail__inspector")).toHaveCount(0);
});

test("conflict recovery label stays fully visible in the mobile SaveBar slot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/host-popovers-fixture.html?conflict");

  const editor = page.locator(".host-popovers-fixture__editor");
  const saveBar = editor.locator(".ui-save-bar");
  const actions = saveBar.locator(".ui-save-bar__actions");
  const reload = actions.getByRole("button", { name: "Serverstand laden" });
  const label = reload.locator(".mantine-Button-label");

  await expect(editor).toBeVisible();
  expect((await saveBar.boundingBox())?.height).toBe(64);
  await expect(actions.getByRole("button")).toHaveCount(1);
  await expect(reload).toBeVisible();
  await expect(label).toHaveText("Serverstand laden");
  await expect.poll(async () => label.evaluate((element) => element.scrollWidth > 0 && element.scrollWidth <= element.clientWidth)).toBe(true);
});
