import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE" });

const breadcrumbSegmentKeys = ["brand-mark", "channel", "area", "module"] as const;

const assertBreadcrumbGeometry = async (page: Page): Promise<void> => {
  const measurement = await page.locator(".topbar__breadcrumb").evaluate((breadcrumb) => {
    const topbar = breadcrumb.closest<HTMLElement>(".topbar");
    if (topbar === null) throw new Error("Die Brotkrume liegt nicht in der Kopfleiste.");

    const segmentElements = [
      { key: "brand-mark", classNames: ["brand-mark"] },
      { key: "channel", classNames: ["topbar__channel-switch", "topbar__channel-segment"] },
      { key: "area", classNames: ["topbar__breadcrumb-area"] },
      { key: "module", classNames: ["topbar__breadcrumb-module"] },
    ].map(({ key, classNames }) => {
      const element = Array.from(breadcrumb.children).find((child) => classNames.some((className) => child.classList.contains(className)));
      if (!(element instanceof HTMLElement)) throw new Error(`Brotkrumen-Segment fehlt: ${key}`);
      const rect = element.getBoundingClientRect();
      return { key, left: rect.left, right: rect.right };
    });
    const separators = Array.from(breadcrumb.querySelectorAll<HTMLElement>(".topbar__breadcrumb-separator"));
    const gap = Number.parseFloat(getComputedStyle(breadcrumb).columnGap);
    const topbarRect = topbar.getBoundingClientRect();
    return {
      topbar: { left: topbarRect.left, right: topbarRect.right, width: topbarRect.width },
      segments: segmentElements,
      separatorWidths: separators.map((separator) => separator.getBoundingClientRect().width),
      gap,
    };
  });

  expect(measurement.segments.map(({ key }) => key)).toEqual([...breadcrumbSegmentKeys]);
  expect([...measurement.segments].sort((first, second) => first.left - second.left).map(({ key }) => key)).toEqual([...breadcrumbSegmentKeys]);
  const leftHalf = measurement.topbar.left + measurement.topbar.width / 2;
  const maxSeparatorWidth = Math.max(...measurement.separatorWidths);
  // Zwischen Segmenten liegen zwei Flex-Gaps und ein Trennzeichen; 1px erlaubt Subpixel-Rundung.
  const maximumSegmentGap = measurement.gap * 2 + maxSeparatorWidth + 1;

  for (const segment of measurement.segments) {
    expect(segment.left).toBeGreaterThanOrEqual(measurement.topbar.left);
    expect(segment.right).toBeLessThanOrEqual(leftHalf);
    expect(segment.right).toBeLessThanOrEqual(measurement.topbar.right);
  }
  for (const [index, segment] of measurement.segments.entries()) {
    const nextSegment = measurement.segments[index + 1];
    if (nextSegment === undefined) continue;
    expect(nextSegment.left - segment.right).toBeLessThanOrEqual(maximumSegmentGap);
  }
};

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

test("die Brotkrumensegmente bleiben bei jeder Fensterbreite zusammen", async ({ page }) => {
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

  for (const width of [1280, 1920, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await assertBreadcrumbGeometry(page);
  }
});
