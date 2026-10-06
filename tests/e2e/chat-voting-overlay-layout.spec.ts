import { expect, test } from "@playwright/test";

test("free-text overlay rows keep fixed columns and tracks at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  const measurements: Array<{
    documentWidth: number;
    tallyWidth: number;
    rowWidths: number[];
    labelWidths: number[];
    countWidths: number[];
    trackWidths: number[];
  }> = [];

  for (const termCount of [0, 1, 5]) {
    await page.goto(`/tests/e2e/chat-voting-overlay-fixture.html?terms=${String(termCount)}`);
    await expect(page.locator(".chat-voting-tally__option")).toHaveCount(5);
    measurements.push(await page.locator(".chat-voting-tally").evaluate((tally) => {
      const rectWidth = (element: Element): number => element.getBoundingClientRect().width;
      const rows = [...tally.querySelectorAll(".chat-voting-tally__option")];
      const labels = rows.map((row) => row.querySelector(".chat-voting-tally__caption")?.children[0]).filter((value): value is Element => value !== undefined);
      const counts = rows.map((row) => row.querySelector(".chat-voting-tally__caption")?.children[1]).filter((value): value is Element => value !== undefined);
      const tracks = rows.map((row) => row.querySelector(".chat-voting-tally__track")).filter((value): value is Element => value !== null);
      return {
        documentWidth: document.documentElement.scrollWidth,
        tallyWidth: rectWidth(tally),
        rowWidths: rows.map(rectWidth),
        labelWidths: labels.map(rectWidth),
        countWidths: counts.map(rectWidth),
        trackWidths: tracks.map(rectWidth),
      };
    }));
  }

  for (const result of measurements) {
    expect(result.documentWidth).toBe(320);
    expect(result.tallyWidth).toBe(320);
    expect(result.rowWidths).toEqual(Array<number>(5).fill(320));
    expect(result.labelWidths).toEqual(Array<number>(5).fill(136));
    expect(new Set(result.countWidths).size).toBe(1);
    expect(result.countWidths).toEqual(Array<number>(5).fill(160));
    expect(result.trackWidths.length).toBe(5);
    expect(new Set(result.trackWidths).size).toBe(1);
    expect(result.trackWidths.every((width) => width === 320)).toBe(true);
  }
  expect(measurements[0]?.countWidths).toEqual(measurements[1]?.countWidths);
  expect(measurements[1]?.countWidths).toEqual(measurements[2]?.countWidths);
  expect(measurements[0]?.trackWidths).toEqual(measurements[1]?.trackWidths);
  expect(measurements[1]?.trackWidths).toEqual(measurements[2]?.trackWidths);
  expect(measurements[1]?.labelWidths).toEqual(measurements[2]?.labelWidths);
});
