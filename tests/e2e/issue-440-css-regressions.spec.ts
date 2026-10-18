import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("System status rows stack when the list container is narrow", async ({ page }) => {
  const channelId = "kanal-440-system-container";
  await page.setViewportSize({ width: 820, height: 900 });
  await installLiveCockpitMocks(page, { channelId });
  await page.goto(`/channels/${channelId}/system`);

  const statusList = page.locator(".system-page__status-list");
  await expect(statusList).toBeVisible();
  const layout = await statusList.evaluate((list) => {
    const row = list.querySelector<HTMLElement>(".state-row");
    if (row === null) return null;
    return {
      containerWidth: list.getBoundingClientRect().width,
      columns: getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/u),
    };
  });
  expect(layout).not.toBeNull();
  expect(layout?.containerWidth).toBeLessThan(759);
  expect(layout?.columns).toHaveLength(2);
});

test("disabled chat voting keeps the host tab styling loaded", async ({ page }) => {
  const channelId = "kanal-440-disabled-voting";
  await page.setViewportSize({ width: 1280, height: 800 });
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "chat_voting", enabled: false, settings: "{}" }],
  });
  await page.goto(`/channels/${channelId}/modules/chat_voting`);

  await expect(page.locator(".module-state")).toBeVisible();
  const activeTab = page.getByRole("tab", { name: "Abstimmungen" });
  await expect(activeTab).toBeVisible();
  await expect(activeTab).toHaveAttribute("aria-selected", "true");

  const styles = await activeTab.evaluate((tab) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--brand-text)";
    document.body.appendChild(probe);
    const brandText = getComputedStyle(probe).color;
    probe.remove();
    const computed = getComputedStyle(tab);
    return {
      brandText,
      color: computed.color,
      minHeight: computed.minHeight,
      paddingInlineStart: computed.paddingInlineStart,
      borderBottomWidth: computed.borderBottomWidth,
      borderBottomColor: computed.borderBottomColor,
      borderBottomStyle: computed.borderBottomStyle,
    };
  });
  expect(styles.minHeight).toBe("40px");
  expect(styles.paddingInlineStart).toBe("12px");
  expect(styles.color).toBe(styles.brandText);
  expect(styles.borderBottomWidth).toBe("1px");
  expect(styles.borderBottomStyle).toBe("solid");
  expect(styles.borderBottomColor).toBe(styles.brandText);
});

test("GroupedPicker and invalid-fields popovers retain their tokenized surface", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/e2e/issue-440-popovers-fixture.html");

  const expectTokenizedSurface = async (popup: ReturnType<typeof page.locator>): Promise<void> => {
    const styles = await popup.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        borderWidth: computed.borderTopWidth,
        borderStyle: computed.borderTopStyle,
        borderRadius: computed.borderTopLeftRadius,
        boxShadow: computed.boxShadow,
      };
    });
    expect(styles.borderWidth).toBe("1px");
    expect(styles.borderStyle).toBe("solid");
    expect(styles.borderRadius).toBe("6px");
    expect(styles.boxShadow).not.toBe("none");
  };

  const pickerPopup = page.locator(".ui-grouped-picker__popover");
  await expect(pickerPopup).toBeVisible();
  await expectTokenizedSurface(pickerPopup);

  await page.locator(".ui-save-bar__invalid-trigger").click();
  const invalidPopup = page.locator(".ui-save-bar__invalid-popover");
  await expect(invalidPopup).toBeVisible();
  await expectTokenizedSurface(invalidPopup);
});

test("mobile invalid-field controls keep the full save actions without clipped summary text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/e2e/issue-440-popovers-fixture.html");
  await page.keyboard.press("Escape");

  await expect(page.locator(".ui-save-bar__invalid-summary")).toBeHidden();
  const trigger = page.locator(".ui-save-bar__invalid-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-label", "Fehlerhafte Felder anzeigen");
});
