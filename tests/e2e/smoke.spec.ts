import { expect, test } from "@playwright/test";

test("Dashboard und Overlay laden als getrennte Oberflächen", async ({ page }) => {
  await page.route("**/api/channels", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ channels: [] }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
  await expect(page.getByText("Noch kein Kanal freigegeben")).toBeVisible();

  const overlayPage = await page.context().newPage();
  await overlayPage.goto("/overlay.html");
  await expect(overlayPage.getByRole("heading", { name: "BroBot Overlay" })).toBeVisible();
  await expect(overlayPage.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await overlayPage.close();
});
