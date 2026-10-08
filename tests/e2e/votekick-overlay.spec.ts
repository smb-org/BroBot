import { expect, test } from "@playwright/test";

test("votekick overlay shows its countdown, vote bars, close outcome, and hide timing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/e2e/votekick-overlay-fixture.html");

  const tally = page.locator(".votekick-tally");
  await expect(tally).toBeVisible();
  await expect(tally).toContainText("@sampleviewer");
  await expect(tally).toContainText("Needed: 5 net yes votes");
  await expect(tally.locator(".overlay-tally__track")).toHaveCount(2);
  await expect(tally.locator(".overlay-tally__countdown")).toHaveText("0:00", { timeout: 5_000 });

  await page.getByRole("button", { name: "Close as passed" }).dispatchEvent("click");
  await expect(tally).toContainText("Passed");
  await expect(tally.locator(".overlay-tally__countdown")).toHaveText("");
  await expect(tally).toBeHidden({ timeout: 3_000 });
});

test("votekick starter role select saves its choice in the settings editor", async ({ page }) => {
  await page.goto("/tests/e2e/votekick-overlay-fixture.html");
  const select = page.getByRole("combobox", { name: "Minimum role to start" });
  await expect(select).toHaveValue("VIP and higher");
  await select.click();
  await page.getByRole("option", { name: "Viewer and higher" }).click();
  await expect(page.getByTestId("starter-role-value")).toHaveText("viewer");
  await expect(select).toHaveValue("Viewer and higher");
});
