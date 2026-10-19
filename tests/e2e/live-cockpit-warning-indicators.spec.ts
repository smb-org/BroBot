import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("desktop location warning stays clear of wrapped cockpit indicators", async ({ page }) => {
  const channelId = "kanal-cockpit-warning-indicators";
  const api = await installLiveCockpitMocks(page, {
    channelId,
    location: null,
    modules: [{ id: "belabox", enabled: true, settings: "{}" }],
    belaboxStatus: { bitrateKbps: 500 },
  });

  for (const width of [1400, 1440, 1536, 1600]) {
    api.setLocation(null);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/channels/${channelId}?lang=de`);

    const warningSlot = page.locator(".live-cockpit__warning-slot");
    const warning = warningSlot.locator(".live-cockpit__warning-summary");
    const indicators = page.locator(".live-cockpit-header__indicators .status-led");
    await expect(warningSlot).toHaveAttribute("data-warning-count", "1");
    await expect(warning).toBeVisible();
    await expect(indicators.nth(1)).toContainText("BELABOX · 500 kbit/s verbunden");
    await expect(indicators.nth(2)).toContainText("Overlays · Nicht eingerichtet");

    const overlaps = await warning.evaluate((warningElement) => {
      const warningBox = warningElement.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>(".live-cockpit-header__indicators .status-led"), (indicator) => {
        const indicatorBox = indicator.getBoundingClientRect();
        return {
          label: indicator.getAttribute("aria-label"),
          overlaps: warningBox.left < indicatorBox.right && warningBox.right > indicatorBox.left &&
            warningBox.top < indicatorBox.bottom && warningBox.bottom > indicatorBox.top,
        };
      });
    });
    expect(overlaps).toHaveLength(3);
    for (const indicator of overlaps) {
      expect(indicator.overlaps, `Warning overlaps ${indicator.label ?? "an indicator"} at ${String(width)}px`).toBe(false);
    }

    const layoutWithWarning = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".live-cockpit-header");
      const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
      if (header === null || wall === null) throw new Error("The cockpit header or tile wall is missing.");
      return { headerBottom: header.getBoundingClientRect().bottom, wallTop: wall.getBoundingClientRect().top };
    });

    api.setLocation({ name: "Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" });
    await page.reload();
    await expect(warningSlot).toHaveAttribute("data-warning-count", "0");
    await expect(indicators.nth(1)).toContainText("BELABOX · 500 kbit/s verbunden");
    const layoutWithoutWarning = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".live-cockpit-header");
      const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
      const warningSlot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
      if (header === null || wall === null || warningSlot === null) throw new Error("The cockpit layout is incomplete.");
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        wallTop: wall.getBoundingClientRect().top,
        warningDisplay: getComputedStyle(warningSlot).display,
        warningHeight: warningSlot.getBoundingClientRect().height,
      };
    });
    expect(layoutWithoutWarning.warningDisplay).toBe("none");
    expect(layoutWithoutWarning.warningHeight).toBe(0);
    expect(layoutWithoutWarning.headerBottom).toBe(layoutWithWarning.headerBottom);
    expect(layoutWithoutWarning.wallTop).toBe(layoutWithWarning.wallTop);
  }
});
