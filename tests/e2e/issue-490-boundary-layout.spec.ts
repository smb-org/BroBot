import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-490-boundary";
const timestamp = "2026-10-19T09:00:00.000Z";
const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

const mockDashboard = async (page: Page): Promise<{ setLocation: (location: { name: string; latitude: number; longitude: number; timeZone: string } | null) => void }> => {
  let location: { name: string; latitude: number; longitude: number; timeZone: string } | null = null;
  const channel = () => ({
    channelId,
    login: "issue490",
    displayName: "Issue 490",
    language: "de" as const,
    role: "manager" as const,
    location,
    broadcasterConnection: "connected" as const,
    channelBotConsent: "granted" as const,
    bot: { status: "connected" as const, reason: null, updatedAt: timestamp },
    botPermissions: null,
    broadcasterPermissions: null,
    moderator: { isModerator: true, checkedAt: timestamp, reason: null },
    chatSubscription: { status: "enabled" as const, subscriptionId: "issue-490-sub", reason: null, updatedAt: timestamp },
    streamState: "offline" as const,
    streamStartedAt: null,
    controls: {
      mute: { active: false, until: null, mode: null },
      pause: { active: false, until: null, mode: null },
    },
    modules: [],
    tokens: {
      botExpiresAt: "2099-10-19T09:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-10-19T09:00:00.000Z",
    },
    lastError: null,
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") {
      const currentChannel = channel();
      return route.fulfill(json({ channels: [currentChannel], bot: currentChannel.bot }));
    }
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel(), activeModules: [] }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [] }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({
      timeZone: "Europe/Berlin", revision: 1, location, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }));
    if (pathname === `/api/channels/${channelId}/broadcast`) return route.fulfill(json({ title: "", game: null, manageScopeAvailable: false }));
    if (pathname === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/audit-log`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "issue-490-csrf" }));
    return route.fulfill(json({}));
  });
  return { setLocation: (nextLocation) => { location = nextLocation; } };
};

test("event and audit person filters keep focus after their query parameters update", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  for (const section of ["events", "audit"] as const) {
    await page.goto(`/channels/${channelId}/${section}?lang=de`);
    const personFilter = page.getByRole("textbox", { name: "Person" });
    await expect(personFilter).toBeVisible();
    await personFilter.fill("alice");
    await expect(page).toHaveURL(new RegExp(`${section}\\?[^#]*actor=alice`, "u"));
    await expect(personFilter).toBeFocused();
    await personFilter.press("e");
    await expect(personFilter).toHaveValue("alicee");
  }
});

test("cockpit warnings flow below the mobile status indicators at 640 to 767 pixels", async ({ page }) => {
  const api = await mockDashboard(page);

  for (const width of [640, 700, 767]) {
    api.setLocation(null);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/channels/${channelId}?lang=de`);

    const warningSlot = page.locator(".live-cockpit__warning-slot");
    await expect(warningSlot).toHaveAttribute("data-warning-count", "1");
    await expect(page.getByText("Overlays · Nicht eingerichtet")).toBeVisible();
    const readLayout = () => page.evaluate(() => {
      const warningSlot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
      const warningSummary = document.querySelector<HTMLElement>(".live-cockpit__warning-summary");
      const indicators = document.querySelector<HTMLElement>(".live-cockpit-header__indicators");
      const header = document.querySelector<HTMLElement>(".live-cockpit-header");
      const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
      if (warningSlot === null || indicators === null || header === null || wall === null) {
        throw new Error("The cockpit warning or status indicators are missing.");
      }
      return {
        position: getComputedStyle(warningSlot).position,
        warningTop: warningSummary?.getBoundingClientRect().top ?? null,
        warningBottom: warningSummary?.getBoundingClientRect().bottom ?? null,
        indicatorsBottom: indicators.getBoundingClientRect().bottom,
        slotHeight: warningSlot.getBoundingClientRect().height,
        slotDisplay: getComputedStyle(warningSlot).display,
        slotVisibility: getComputedStyle(warningSlot).visibility,
        headerBottom: header.getBoundingClientRect().bottom,
        wallTop: wall.getBoundingClientRect().top,
      };
    });
    const geometry = await readLayout();

    expect(geometry.position).toBe("static");
    expect(geometry.slotHeight).toBeGreaterThan(0);
    expect(geometry.warningTop).not.toBeNull();
    expect(geometry.warningBottom).not.toBeNull();
    expect(geometry.warningTop as number).toBeGreaterThanOrEqual(geometry.indicatorsBottom - 1);
    expect(geometry.warningBottom as number).toBeGreaterThan(geometry.warningTop as number);

    api.setLocation({ name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" });
    await page.reload();
    await expect(warningSlot).toHaveAttribute("data-warning-count", "0");
    // Wait for the settled indicator text so wrapping matches the warning state.
    await expect(page.getByText("Overlays · Nicht eingerichtet")).toBeVisible();
    const emptyGeometry = await readLayout();
    expect(emptyGeometry.slotDisplay).toBe("flex");
    expect(emptyGeometry.slotVisibility).toBe("hidden");
    expect(emptyGeometry.slotHeight).toBe(geometry.slotHeight);
    expect(emptyGeometry.headerBottom).toBe(geometry.headerBottom);
    expect(emptyGeometry.wallTop).toBe(geometry.wallTop);
  }
});
