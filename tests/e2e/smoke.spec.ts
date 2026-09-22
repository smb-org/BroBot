import { expect, test } from "@playwright/test";

test.use({ locale: "de-DE" });

test("dashboard and overlay load as separate surfaces", async ({ page }) => {
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
      body: JSON.stringify({ version: "e2e-version", language: "de" }),
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

test("the real worker protects the dashboard and shows the login", async ({ page }) => {
  // Without a session, the worker terminates the route with 401 before any D1 access;
  // the test therefore doesn't depend on the migration state of the e2e store.
  const channelsResponsePromise = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === "/api/channels";
  });

  await page.goto("http://127.0.0.1:8787/");

  const channelsResponse = await channelsResponsePromise;
  expect(channelsResponse.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Anmeldung erforderlich" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mit Twitch anmelden" })).toBeVisible();
});

test("the sidebar stays reachable across every viewport width -- inline above 768px, behind a burger drawer below it", async ({ page }) => {
  const channel = {
    channelId: "kanal-e2e",
    login: "brotkrumen-kanal",
    displayName: "Brotkrumen-Kanal",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
    moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "abo-e2e", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
    tokens: {
      botExpiresAt: "2099-09-20T08:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-09-20T08:00:00.000Z",
    },
    lastError: null,
  };

  await page.route("**/api/channels**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel] }) });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/overview") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...channel, activeModules: [{ moduleId: "text_commands", settings: "{}" }] }),
      });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/modules") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/channels/kanal-e2e/modules/text_commands");
  await expect(page.getByRole("heading", { name: "Textbefehle", level: 1 })).toBeVisible();

  const sidebar = page.getByRole("navigation", { name: "Hauptnavigation" });
  const burger = page.getByRole("button", { name: "Seitenleiste öffnen" });

  // Above the md breakpoint (768px): the sidebar sits inline, no burger needed.
  for (const width of [1280, 1920, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kanal" })).toBeVisible();
    await expect(burger).toBeHidden();
  }

  // Below it: the sidebar becomes a drawer, off-canvas until the burger
  // opens it -- Mantine slides it out with a transform rather than
  // `display: none`, so it stays "visible" by Playwright's own definition
  // and the check has to be about where it is, not whether it's shown.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(burger).toBeVisible();
  await expect(sidebar).not.toBeInViewport();
  await burger.click();
  await expect(sidebar).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: "Kanal" })).toBeVisible();

  // The channel select drops to its own full-width row alongside the burger.
  const brandBox = await page.getByRole("link", { name: "BroBot" }).boundingBox();
  const channelSelectBox = await page.getByRole("combobox", { name: "Kanal auswählen" }).boundingBox();
  expect(brandBox).not.toBeNull();
  expect(channelSelectBox).not.toBeNull();
  expect(channelSelectBox?.y ?? 0).toBeGreaterThan((brandBox?.y ?? 0) + (brandBox?.height ?? 0) - 1);
});
