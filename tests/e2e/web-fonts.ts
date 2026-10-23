import type { Page } from "@playwright/test";

/**
 * Waits until every declared web font face is loaded. The faces use
 * `font-display: swap`, so a box measured while they are still loading shifts
 * by 1-2px once the real glyph metrics arrive. Call before taking a layout baseline.
 */
export async function waitForWebFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
    await document.fonts.ready;
  });
}
