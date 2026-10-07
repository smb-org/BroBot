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
        lineClamp: getComputedStyle(element.querySelector(".chat-voting-tally__header-title") as Element).webkitLineClamp,
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

test("countdown appearance and absence keep the header slot fixed at the canvas size", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const measurements: Array<{
    header: { x: number; y: number; width: number; height: number };
    title: { x: number; y: number; width: number; height: number };
    countdown: { x: number; y: number; width: number; height: number };
    resultsTop: number;
    countdownText: string;
  }> = [];

  for (const mode of ["timed", "open-ended", "off", "closed"]) {
    await page.goto(`/tests/e2e/chat-voting-overlay-fixture.html?countdown=${mode}`);
    const header = page.locator(".chat-voting-tally__header");
    const countdown = page.locator(".chat-voting-tally__countdown");
    await expect(header).toBeVisible();
    await expect(countdown).toHaveText(mode === "timed" ? "1:30" : "");
    measurements.push(await header.evaluate((element) => {
      const rect = (node: Element): { x: number; y: number; width: number; height: number } => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const tally = element.closest(".chat-voting-tally");
      const results = tally?.querySelector(".chat-voting-tally__options");
      const titleElement = element.querySelector(".chat-voting-tally__header-title");
      const countdownElement = element.querySelector(".chat-voting-tally__countdown");
      if (titleElement === null || countdownElement === null || results === null || results === undefined) {
        throw new Error("The voting header layout is incomplete.");
      }
      return {
        header: rect(element),
        title: rect(titleElement),
        countdown: rect(countdownElement),
        resultsTop: results.getBoundingClientRect().top,
        countdownText: countdownElement.textContent,
      };
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
  }

  expect(new Set(measurements.map(({ header }) => JSON.stringify(header))).size).toBe(1);
  expect(new Set(measurements.map(({ title }) => JSON.stringify(title))).size).toBe(1);
  expect(new Set(measurements.map(({ countdown }) => JSON.stringify(countdown))).size).toBe(1);
  expect(new Set(measurements.map(({ resultsTop }) => resultsTop)).size).toBe(1);
  expect(measurements.map(({ countdownText }) => countdownText)).toEqual(["1:30", "", "", ""]);
  expect(measurements[0]?.countdown.width).toBeGreaterThan(0);
  expect(measurements[0]?.countdown.width).toBe(measurements[1]?.countdown.width);
  expect(measurements[0]?.countdown.width).toBe(measurements[2]?.countdown.width);
  expect(measurements[0]?.countdown.width).toBe(measurements[3]?.countdown.width);
});
