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

test("error links and text reveals stay clickable and in the viewport at mobile and inspector widths", async ({ page }) => {
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
      { name: "Alpha: Enter a valid alpha value.", details: true },
      { name: "Beta: Choose a value below the allowed maximum.", details: true },
      { name: "Gamma: This complete error explains how to correct the value without leaving the editor.", details: false },
    ];

    for (const link of links) {
      if (!(await errorPopover.isVisible())) await errorTrigger.click();
      await assertInsideViewport(page, errorPopover);
      const errorLink = errorPopover.getByRole("button", { name: link.name });
      await assertInsideViewport(page, errorLink);
      await errorLink.click();
      if (link.details) {
        await expect(editor.locator("details")).toHaveAttribute("data-editor-error", "true");
      } else {
        await expect(page.getByRole("textbox", { name: "Gamma" })).toBeFocused();
      }
    }

    const gamma = editor.locator(".ui-field").filter({ has: page.getByRole("textbox", { name: "Gamma" }) });
    const hintTrigger = gamma.locator(".ui-field__hint .ui-text-reveal__trigger");
    await hintTrigger.scrollIntoViewIfNeeded();
    await hintTrigger.click();
    const hintPopup = page.locator(".ui-text-reveal__popup").filter({ hasText: "the editor clips its scrolling body" });
    await assertInsideViewport(page, hintPopup);
    expect(await hintPopup.evaluate((element) => element.closest(".ui-editor-shell__body"))).toBeNull();
    await expect(hintPopup).toContainText("the editor clips its scrolling body");
    await hintTrigger.click();
    await expect(hintPopup).toBeHidden();

    const errorTextTrigger = gamma.locator(".mantine-InputWrapper-error .ui-text-reveal__trigger");
    await errorTextTrigger.click();
    const fieldErrorPopup = page.locator(".ui-text-reveal__popup").filter({ hasText: "without leaving the editor" });
    await assertInsideViewport(page, fieldErrorPopup);
    expect(await fieldErrorPopup.evaluate((element) => element.closest(".ui-editor-shell__body"))).toBeNull();
    await expect(fieldErrorPopup).toContainText("without leaving the editor");
    await errorTextTrigger.click();
    await expect(fieldErrorPopup).toBeHidden();

    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Long message dialog" });
    await expect(dialog).toBeVisible();
    const dialogErrorTrigger = dialog.locator(".ui-dialog__error-slot .ui-text-reveal__trigger");
    await dialogErrorTrigger.click();
    const dialogErrorPopup = page.locator(".ui-text-reveal__popup").filter({ hasText: "the step needed to correct the request" });
    await assertInsideViewport(page, dialogErrorPopup);
    expect(await dialogErrorPopup.evaluate((element) => element.closest(".mantine-Modal-content"))).toBeNull();
    await expect(dialogErrorPopup).toContainText("the step needed to correct the request");
    await dialogErrorTrigger.click();
    await page.getByRole("button", { name: "Cancel" }).click();
  }
});
