import { expect, test } from "@playwright/test";

test("BELABOX status dimensions stay fixed in fresh, stale, and no-data states", async ({ page }) => {
  for (const layout of ["compact", "detail"] as const) {
    const expectedHeight = layout === "compact" ? 40 : 64;
    const measurements: Array<{ width: number; height: number }> = [];
    for (const state of ["fresh", "stale", "no-data"] as const) {
      await page.goto(`/tests/e2e/fixtures/belabox-status.html?layout=${layout}&state=${state}`);
      const element = page.locator(".belabox-status");
      await expect(element).toBeVisible();
      const measurement = await element.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      });
      measurements.push(measurement);
      expect(measurement).toEqual({ width: 320, height: expectedHeight });
    }
    expect(measurements[0]).toEqual(measurements[1]);
    expect(measurements[1]).toEqual(measurements[2]);
  }
});
