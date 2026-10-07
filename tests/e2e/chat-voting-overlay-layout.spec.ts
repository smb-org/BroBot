import { expect, test } from "@playwright/test";

test("free-text overlay rows keep fixed columns and tracks at a fixed 480px inside the real canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 600 });
  const measurements: Array<{
    documentWidth: number;
    tallyWidth: number;
    wrapperWidth: number;
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
      const wrapper = tally.parentElement as HTMLElement;
      const labels = rows.map((row) => row.querySelector(".chat-voting-tally__caption")?.children[0]).filter((value): value is Element => value !== undefined);
      const counts = rows.map((row) => row.querySelector(".chat-voting-tally__caption")?.children[1]).filter((value): value is Element => value !== undefined);
      const tracks = rows.map((row) => row.querySelector(".chat-voting-tally__track")).filter((value): value is Element => value !== null);
      return {
        documentWidth: document.documentElement.scrollWidth,
        tallyWidth: rectWidth(tally),
        wrapperWidth: rectWidth(wrapper),
        rowWidths: rows.map(rectWidth),
        labelWidths: labels.map(rectWidth),
        countWidths: counts.map(rectWidth),
        trackWidths: tracks.map(rectWidth),
      };
    }));
  }

  for (const result of measurements) {
    expect(result.documentWidth).toBeLessThanOrEqual(1920);
    expect(result.wrapperWidth).toBe(480);
    expect(result.tallyWidth).toBe(480);
    expect(result.rowWidths).toEqual(Array<number>(5).fill(480));
    expect(new Set(result.countWidths).size).toBe(1);
    expect(result.countWidths).toEqual(Array<number>(5).fill(160));
    expect(result.trackWidths.length).toBe(5);
    expect(new Set(result.trackWidths).size).toBe(1);
    expect(result.trackWidths.every((width) => width === 480)).toBe(true);
  }
  expect(measurements[0]?.countWidths).toEqual(measurements[1]?.countWidths);
  expect(measurements[1]?.countWidths).toEqual(measurements[2]?.countWidths);
  expect(measurements[0]?.trackWidths).toEqual(measurements[1]?.trackWidths);
  expect(measurements[1]?.trackWidths).toEqual(measurements[2]?.trackWidths);
  expect(measurements[1]?.labelWidths).toEqual(measurements[2]?.labelWidths);
});

test("vote question header stays fixed and clamps long text at 390px in the overlay canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const measurements: Array<{ headerHeight: number; tallyHeight: number; resultsTop: number; lineClamp: string }> = [];
  const longTitle = "😀".repeat(80);

  for (const title of [null, "Pizza today?", longTitle]) {
    const parameters = new URLSearchParams({ mobile: "1", title: title ?? "" });
    await page.goto(`/tests/e2e/chat-voting-overlay-fixture.html?${parameters.toString()}`);
    const header = page.locator(".chat-voting-tally__header");
    await expect(header).toBeVisible();
    await expect(header).toHaveText(title ?? "Voting");
    measurements.push(await header.evaluate((element) => {
      const tally = element.closest(".chat-voting-tally");
      const results = tally?.querySelector(".chat-voting-tally__options");
      return {
        headerHeight: element.getBoundingClientRect().height,
        tallyHeight: tally?.getBoundingClientRect().height ?? 0,
        resultsTop: results?.getBoundingClientRect().top ?? 0,
        lineClamp: getComputedStyle(element).webkitLineClamp,
      };
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }

  expect(measurements[0]?.headerHeight).toBeGreaterThan(0);
  expect(new Set(measurements.map(({ headerHeight }) => headerHeight)).size).toBe(1);
  expect(new Set(measurements.map(({ tallyHeight }) => tallyHeight)).size).toBe(1);
  expect(new Set(measurements.map(({ resultsTop }) => resultsTop)).size).toBe(1);
  expect(measurements.map(({ lineClamp }) => lineClamp)).toEqual(["2", "2", "2"]);
});
