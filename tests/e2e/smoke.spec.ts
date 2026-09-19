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
  await overlayPage.route("**/api/overlay/status", async (route) => {
    const authorization = route.request().headers().authorization;
    expect(route.request().url()).not.toContain("e2e-token");
    expect(route.request().headers().referer ?? "").not.toContain("e2e-token");
    if (authorization !== "Bearer e2e-token") {
      await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "e2e-version" }),
    });
  });
  // Playwright runs against the local Vite server, whose HTML entry is overlay.html.
  await overlayPage.goto("/overlay.html#token=e2e-token");
  await expect(overlayPage.getByText("Version e2e-version")).toBeVisible();
  await expect(overlayPage.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(overlayPage.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(overlayPage.locator("#root")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await overlayPage.evaluate(() => {
    document.body.dataset.sameDocumentMarker = "preserved";
    window.location.hash = "token=invalid-token";
  });
  await expect(overlayPage.locator("#root")).toBeEmpty();
  await expect(overlayPage.locator("body")).toHaveAttribute("data-same-document-marker", "preserved");
  await overlayPage.close();
});

test("der echte Worker schützt das Dashboard und zeigt die Anmeldung", async ({ page }) => {
  // Ohne Session beendet der Worker die Route vor jedem D1-Zugriff mit 401;
  // der Test hängt deshalb nicht vom Migrationsstand des E2E-Speichers ab.
  const channelsResponsePromise = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === "/api/channels";
  });

  await page.goto("http://127.0.0.1:8787/");

  const channelsResponse = await channelsResponsePromise;
  expect(channelsResponse.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Anmeldung erforderlich" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mit Twitch anmelden" })).toBeVisible();
});
