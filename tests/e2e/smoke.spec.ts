import { expect, test } from "@playwright/test";

test("Dashboard und Overlay laden als getrennte Oberflächen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "BroBot Dashboard" })).toBeVisible();

  const overlayPage = await page.context().newPage();
  await overlayPage.goto("/overlay.html");
  await expect(overlayPage.getByRole("heading", { name: "BroBot Overlay" })).toBeVisible();
  await expect(overlayPage.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await overlayPage.close();
});
