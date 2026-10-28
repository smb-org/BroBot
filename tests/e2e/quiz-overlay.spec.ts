import { expect, test } from "@playwright/test";

test("mock quiz phases render in one stable overlay box", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/tests/e2e/quiz-overlay-fixture.html");

  const overlay = page.locator(".quiz-session-overlay");
  const sizes: Array<{ width: number; height: number }> = [];

  await page.getByRole("button", { name: "announce" }).click();
  await expect(overlay).toContainText("Which city sits on the Spree?");
  await expect(overlay.locator(".quiz-session-overlay__option-number")).toHaveCount(4);
  sizes.push(await overlay.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));

  await page.getByRole("button", { name: "open" }).click();
  await expect(overlay).toContainText("remaining");
  sizes.push(await overlay.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));

  await page.getByRole("button", { name: "paused" }).click();
  await expect(overlay).toContainText("Paused · 0:12");
  sizes.push(await overlay.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));

  await page.getByRole("button", { name: "reveal" }).click();
  await expect(overlay.getByText("Correct")).toBeVisible();
  await expect(overlay.locator('[data-correct="true"]')).toContainText("Berlin");
  sizes.push(await overlay.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));

  await page.getByRole("button", { name: "results" }).click();
  await expect(overlay.locator(".quiz-session-overlay__rank")).toHaveCount(10);
  await expect(overlay).toContainText("viewer1");
  sizes.push(await overlay.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));

  expect(sizes).toEqual(Array.from({ length: 5 }, () => ({ width: 640, height: 360 })));
  await page.getByRole("button", { name: "idle" }).click();
  await expect(overlay).toBeHidden();
});
