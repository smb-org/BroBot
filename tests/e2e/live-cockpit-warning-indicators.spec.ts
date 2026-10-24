import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("desktop location warning stays clear of wrapped cockpit indicators", async ({ page }) => {
  const channelId = "kanal-cockpit-warning-indicators";
  const api = await installLiveCockpitMocks(page, {
    channelId,
    location: null,
    modules: [{ id: "belabox", enabled: true, settings: "{}" }],
    belaboxStatus: { bitrateKbps: 500 },
  });

  for (const width of [1400, 1440, 1536, 1600, 1920]) {
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
      const cockpit = document.querySelector<HTMLElement>(".live-cockpit");
      const warningSlot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
      const indicatorElements = Array.from(document.querySelectorAll<HTMLElement>(".live-cockpit-header__indicators .status-led"));
      if (header === null || wall === null || cockpit === null || warningSlot === null) throw new Error("The cockpit layout is incomplete.");
      const headerBounds = header.getBoundingClientRect();
      return {
        headerBottom: headerBounds.bottom,
        wallTop: wall.getBoundingClientRect().top,
        warningBottom: warningSlot.getBoundingClientRect().bottom,
        indicatorLineCount: new Set(indicatorElements.map((element) => Math.round(element.getBoundingClientRect().top))).size,
        wallHeaderGap: wall.getBoundingClientRect().top - headerBounds.bottom,
        cockpitRowGap: Number.parseFloat(getComputedStyle(cockpit).rowGap),
      };
    });
    if (width === 1920) {
      expect(layoutWithWarning.indicatorLineCount).toBe(1);
      expect(layoutWithWarning.warningBottom).toBeLessThanOrEqual(layoutWithWarning.headerBottom);
      expect(layoutWithWarning.wallHeaderGap).toBe(layoutWithWarning.cockpitRowGap);
    }

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
        warningVisibility: getComputedStyle(warningSlot).visibility,
        warningHeight: warningSlot.getBoundingClientRect().height,
        warningInert: warningSlot.inert,
        warningAriaHidden: warningSlot.getAttribute("aria-hidden"),
      };
    });
    expect(layoutWithoutWarning.warningDisplay).toBe("flex");
    expect(layoutWithoutWarning.warningVisibility).toBe("hidden");
    expect(layoutWithoutWarning.warningHeight).toBe(36);
    expect(layoutWithoutWarning.warningInert).toBe(true);
    expect(layoutWithoutWarning.warningAriaHidden).toBe("true");
    expect(layoutWithoutWarning.headerBottom).toBe(layoutWithWarning.headerBottom);
    expect(layoutWithoutWarning.wallTop).toBe(layoutWithWarning.wallTop);
  }
});

test.describe("English cockpit status labels", () => {
  test.use({ locale: "en-US" });

  test("three wrapped status indicators keep warning and tile geometry stable at 768 pixels", async ({ page }) => {
    const channelId = "channel-cockpit-three-line-warning";
    const api = await installLiveCockpitMocks(page, {
      channelId,
      channelBotStatus: "disconnected",
      location: null,
      modules: [{ id: "belabox", enabled: true, settings: "{}" }],
      belaboxStatus: { bitrateKbps: 500 },
    });

    const warningSlot = page.locator(".live-cockpit__warning-slot");
    const warning = warningSlot.locator(".live-cockpit__warning-summary");
    const indicators = page.locator(".live-cockpit-header__indicators .status-led");
    let layoutWithWarningAt768: { headerBottom: number; wallTop: number } | undefined;

    for (const width of [768, 900, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 768) await page.goto(`/channels/${channelId}?lang=en`);

      await expect(warningSlot).toHaveAttribute("data-warning-count", "1");
      await expect(warning).toBeVisible();
      await expect(indicators.nth(0)).toContainText("Bot · Not connected");
      await expect(indicators.nth(1)).toContainText("BELABOX · connected · 500 kbps");
      await expect(indicators.nth(2)).toContainText("Overlays · Not set up");
      await waitForWebFonts(page);

      const layoutWithWarning = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".live-cockpit-header");
        const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
        const summary = document.querySelector<HTMLElement>(".live-cockpit-header__summary");
        const title = document.querySelector<HTMLElement>(".live-cockpit-header__title-slot");
        const status = document.querySelector<HTMLElement>(".live-cockpit-header__status");
        const warningSlot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
        const warning = document.querySelector<HTMLElement>(".live-cockpit__warning-summary");
        const indicatorElements = Array.from(document.querySelectorAll<HTMLElement>(".live-cockpit-header__indicators .status-led"));
        if (header === null || wall === null || summary === null || title === null || status === null || warningSlot === null || warning === null) {
          throw new Error("The cockpit layout is incomplete.");
        }

        const metaItems = Array.from(summary.children).filter((element) => !element.classList.contains("sr-only")) as HTMLElement[];
        const measuredItems = [
          ...metaItems.map((element, index) => ({ label: `meta item ${String(index + 1)}`, element })),
          { label: "stream title", element: title },
          { label: "status column", element: status },
        ];
        const overlaps: string[] = [];
        for (const [firstIndex, firstItem] of measuredItems.entries()) {
          const firstBox = firstItem.element.getBoundingClientRect();
          for (const secondItem of measuredItems.slice(firstIndex + 1)) {
            const secondBox = secondItem.element.getBoundingClientRect();
            if (firstBox.left < secondBox.right && firstBox.right > secondBox.left &&
              firstBox.top < secondBox.bottom && firstBox.bottom > secondBox.top) {
              overlaps.push(`${firstItem.label} / ${secondItem.label}`);
            }
          }
        }

        const warningBounds = warning.getBoundingClientRect();
        const indicatorBounds = indicatorElements.map((element) => element.getBoundingClientRect());
        return {
          headerBottom: header.getBoundingClientRect().bottom,
          wallTop: wall.getBoundingClientRect().top,
          metaItemCount: metaItems.length,
          overlaps,
          titleHeight: title.getBoundingClientRect().height,
          warningTop: warningBounds.top,
          warningSlotBottom: warningSlot.getBoundingClientRect().bottom,
          indicatorLineCount: new Set(indicatorBounds.map((bounds) => Math.round(bounds.top))).size,
          indicatorBottom: Math.max(...indicatorBounds.map((bounds) => bounds.bottom)),
          indicatorOverlaps: indicatorBounds.map((bounds) => warningBounds.left < bounds.right && warningBounds.right > bounds.left &&
            warningBounds.top < bounds.bottom && warningBounds.bottom > bounds.top),
        };
      });

      expect(layoutWithWarning.metaItemCount, `Visible header meta item count at ${String(width)}px`).toBe(4);
      expect(layoutWithWarning.overlaps, `Header elements overlap at ${String(width)}px`).toEqual([]);
      expect(layoutWithWarning.titleHeight, `Empty stream title rows should collapse at ${String(width)}px`).toBe(46);
      expect(layoutWithWarning.warningTop, `Warning should follow all indicators at ${String(width)}px`)
        .toBeGreaterThanOrEqual(layoutWithWarning.indicatorBottom);
      expect(layoutWithWarning.warningSlotBottom).toBeLessThanOrEqual(layoutWithWarning.headerBottom);
      expect(layoutWithWarning.indicatorOverlaps, `Warning should not overlap indicators at ${String(width)}px`)
        .toEqual([false, false, false]);
      if (width === 768) {
        expect(layoutWithWarning.indicatorLineCount).toBe(3);
        layoutWithWarningAt768 = { headerBottom: layoutWithWarning.headerBottom, wallTop: layoutWithWarning.wallTop };
      }
    }

    if (layoutWithWarningAt768 === undefined) throw new Error("The 768px warning layout was not measured.");

    api.setLocation({ name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" });
    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    await expect(warningSlot).toHaveAttribute("data-warning-count", "0");
    // Wait for the same indicator texts as in the warning state so wrapping matches.
    await expect(indicators.nth(1)).toContainText("BELABOX · connected · 500 kbps");
    await expect(indicators.nth(2)).toContainText("Overlays · Not set up");
    const layoutWithoutWarning = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".live-cockpit-header");
      const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
      const warningSlot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
      if (header === null || wall === null || warningSlot === null) throw new Error("The cockpit layout is incomplete.");
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        wallTop: wall.getBoundingClientRect().top,
        warningDisplay: getComputedStyle(warningSlot).display,
        warningVisibility: getComputedStyle(warningSlot).visibility,
        warningHeight: warningSlot.getBoundingClientRect().height,
        warningInert: warningSlot.inert,
        warningAriaHidden: warningSlot.getAttribute("aria-hidden"),
      };
    });
    expect(layoutWithoutWarning.warningDisplay).toBe("flex");
    expect(layoutWithoutWarning.warningVisibility).toBe("hidden");
    expect(layoutWithoutWarning.warningHeight).toBe(36);
    expect(layoutWithoutWarning.warningInert).toBe(true);
    expect(layoutWithoutWarning.warningAriaHidden).toBe("true");
    expect(layoutWithoutWarning.headerBottom).toBe(layoutWithWarningAt768.headerBottom);
    expect(layoutWithoutWarning.wallTop).toBe(layoutWithWarningAt768.wallTop);
  });
});
