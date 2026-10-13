import { expect, test } from "@playwright/test";
import { e2eWorkerOrigin } from "./worker-fixtures";

test.use({ locale: "de-DE" });

test("dashboard and overlay load as separate surfaces", async ({ page }) => {
  await page.route("**/api/channels", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ channels: [], bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" } }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
  await expect(page.getByText("Noch kein Kanal freigegeben")).toBeVisible();

  const overlayPage = await page.context().newPage();
  await overlayPage.route("**/api/overlay/bootstrap", async (route) => {
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
      body: JSON.stringify({ language: "de", overlay: null, variables: {} }),
    });
  });
  // Playwright runs against the local Vite server, whose HTML entry is overlay.html.
  const validBootstrap = overlayPage.waitForResponse("**/api/overlay/bootstrap");
  await overlayPage.goto("/overlay.html#token=e2e-token");
  const validBootstrapResponse = await validBootstrap;
  expect(validBootstrapResponse.request().headers().authorization).toBe("Bearer e2e-token");
  expect(validBootstrapResponse.status()).toBe(200);
  await expect(overlayPage.locator("#root")).toBeEmpty();
  await expect(overlayPage.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(overlayPage.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(overlayPage.locator("#root")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const invalidBootstrap = overlayPage.waitForResponse("**/api/overlay/bootstrap");
  await overlayPage.evaluate(() => {
    document.body.dataset.sameDocumentMarker = "preserved";
    window.location.hash = "token=invalid-token";
  });
  const invalidBootstrapResponse = await invalidBootstrap;
  expect(invalidBootstrapResponse.request().headers().authorization).toBe("Bearer invalid-token");
  expect(invalidBootstrapResponse.status()).toBe(401);
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

  await page.goto(`${e2eWorkerOrigin}/`);

  const channelsResponse = await channelsResponsePromise;
  expect(channelsResponse.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Anmeldung erforderlich" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mit Twitch anmelden" })).toBeVisible();
});

test("setup navigation stays reachable across desktop and mobile widths", async ({ page }) => {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
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
  const burger = page.getByRole("banner").getByRole("button", { name: /Seitenleiste/u });
  const modulesLink = sidebar.getByRole("link", { name: "Module verwalten", exact: true });
  await modulesLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/channels/kanal-e2e/modules");
  await expect(modulesLink).toHaveAttribute("aria-current", "page");

  // Desktop setup navigation sits inline, with no drawer trigger.
  for (const width of [1280, 1920, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /Textbefehle/u })).toBeVisible();
    await expect(burger).toBeHidden();
  }

  // Below the desktop breakpoint the navigation becomes a drawer.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(burger).toBeVisible();
  await expect(sidebar).not.toBeInViewport();
  await burger.click();
  await expect(sidebar).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: /Textbefehle/u })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(burger).toBeVisible();
  await expect(sidebar).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: /Textbefehle/u })).toBeVisible();
  const lastEntry = sidebar.getByRole("link", { name: /Textbefehle/ });
  await lastEntry.scrollIntoViewIfNeeded();
  await expect(lastEntry).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // At desktop widths the mode switch is centred in the topbar itself.
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = await page.locator(".dashboard-shell__header").boundingBox();
    const mode = await page.locator(".dashboard-header__mode").boundingBox();
    expect(bar).not.toBeNull();
    expect(mode).not.toBeNull();
    expect(Math.abs((mode?.x ?? 0) + (mode?.width ?? 0) / 2 - ((bar?.x ?? 0) + (bar?.width ?? 0) / 2))).toBeLessThanOrEqual(2);
  }

  // The fixed 64px topbar keeps its controls on one row at tablet widths.
  await page.setViewportSize({ width: 600, height: 900 });
  const topbarBox = await page.locator(".dashboard-shell__header").boundingBox();
  const channelSelectBox = await page.getByRole("combobox", { name: "Kanal auswählen" }).boundingBox();
  expect(topbarBox).not.toBeNull();
  expect(channelSelectBox).not.toBeNull();
  expect(channelSelectBox?.y ?? 0).toBeGreaterThanOrEqual(topbarBox?.y ?? 0);
  expect((channelSelectBox?.y ?? 0) + (channelSelectBox?.height ?? 0)).toBeLessThanOrEqual((topbarBox?.y ?? 0) + (topbarBox?.height ?? 0));
});

test("ListDetail uses the shared desktop grid and mobile overlay inspector", async ({ page }) => {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
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
    if (pathname === "/api/channels/kanal-e2e/modules/text_commands/commands") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [{
          channelId: "kanal-e2e",
          name: "hallo",
          text: "Hallo {user}",
          kind: "text",
          enabled: true,
          minimumTier: "everyone",
          cooldownSeconds: 5,
          aliases: [],
          userCooldownSeconds: 0,
          streamCondition: "any",
          responseType: "say",
          variableAction: null,
          useCount: 0,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }], variables: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/channels/kanal-e2e/modules/text_commands");
  await expect(page.getByRole("heading", { name: "Textbefehle", level: 1 })).toBeVisible();

  const list = page.getByRole("region", { name: "Befehle", exact: true });
  const row = page.getByRole("row", { name: /!hallo/ });
  const inspector = page.getByRole("region", { name: "Eigenschaften von !hallo" });

  // At 1280px, selecting a row uses the shared desktop grid with the list
  // beside a fixed-width inspector.
  await page.setViewportSize({ width: 1280, height: 900 });
  await row.click();
  await expect(inspector).toBeVisible();
  const listBoxDesktop = await list.boundingBox();
  const inspectorBoxDesktop = await inspector.boundingBox();
  expect(listBoxDesktop).not.toBeNull();
  expect(inspectorBoxDesktop).not.toBeNull();
  // Side by side: the inspector starts at or after the list's right edge,
  // and roughly on the same row rather than further down the page.
  expect(inspectorBoxDesktop?.x ?? 0).toBeGreaterThanOrEqual((listBoxDesktop?.x ?? 0) + (listBoxDesktop?.width ?? 0) - 1);
  expect(Math.abs((inspectorBoxDesktop?.y ?? 0) - (listBoxDesktop?.y ?? 0))).toBeLessThan(80);
  expect(inspectorBoxDesktop?.width ?? 0).toBeCloseTo(592, -1);

  // Counter-probe: below 1280px the same selection must NOT produce that
  // two-column form -- the inspector floats over the list as a drawer
  // instead, sized to the drawer's own 480px rather than the column's
  // 592px, and overlapping the list horizontally rather than sitting
  // beside it.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(inspector).toBeVisible();
  // The modal drawer makes the list behind it inert and hidden from the
  // accessibility tree, so it is only reachable with includeHidden.
  const hiddenList = page.getByRole("region", { name: "Befehle", exact: true, includeHidden: true });
  const listBoxNarrow = await hiddenList.boundingBox();
  const inspectorBoxNarrow = await inspector.boundingBox();
  expect(listBoxNarrow).not.toBeNull();
  expect(inspectorBoxNarrow).not.toBeNull();
  expect(inspectorBoxNarrow?.width ?? 0).toBeCloseTo(480, -1);
  expect(inspectorBoxNarrow?.x ?? 0).toBeLessThan((listBoxNarrow?.x ?? 0) + (listBoxNarrow?.width ?? 0));
});
