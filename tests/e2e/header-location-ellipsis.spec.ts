import { expect, test } from "@playwright/test";

test.use({ locale: "de-DE" });

// Regression for #279: the header location button used to show the full
// geocoded name and clip it hard once it overflowed its cell, with no
// ellipsis and no coordinates. It now shows only the first name segment
// plus coordinates, truncated with an ellipsis instead of a hard cut, while
// the full name stays the accessible name/title and the menu heading.

const longName = "Sankt Ulrich am Pillersee bei Kitzbühel, Tirol, Österreich";
const shortName = "Sankt Ulrich am Pillersee bei Kitzbühel";

const channel = {
  channelId: "kanal-location-ellipsis",
  login: "brotkrumen-kanal",
  displayName: "Brotkrumen-Kanal",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-location-ellipsis", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
  location: { name: longName, latitude: 48.7758, longitude: 9.1829, timeZone: "Europe/Berlin" },
};

test("the header location button shows the short name with an ellipsis instead of a hard cut", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/overview`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...channel, activeModules: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  const locationButton = page.locator(".dashboard-header__location");
  const name = page.locator(".dashboard-header__location-name");
  const coordinates = page.locator(".dashboard-header__location-coordinates");

  // Escapes the fixture's short name for use inside a `RegExp`, so
  // `toHaveAccessibleName` can assert "contains" instead of an exact match --
  // the accessible name folds the full name in after the visible label, and
  // also drops the (CSS `display: none`) coordinates once they're hidden.
  const asPattern = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const label = page.locator(".dashboard-header__location-label");

  const checkTruncation = async (): Promise<void> => {
    await expect(locationButton).toBeVisible();
    // The full name never appears verbatim in the *visible* label -- only
    // the short first segment (plus coordinates, where the breakpoint keeps
    // them). It does now appear a second time in the button's full text
    // content, folded in via a visually hidden suffix for the accessible
    // name (checked below), so this must scope to the visible label only.
    const visibleText = (await label.textContent()) ?? "";
    expect(visibleText).not.toContain(longName);
    expect(visibleText).toContain(shortName);
    // Title stays the full name regardless of viewport. The accessible name
    // is content-derived (no aria-label override), so it must contain both
    // the always-visible short name and the full name folded in afterwards
    // (WCAG 2.5.3 Label in Name) -- not an exact match, since the
    // coordinates segment is only part of the name while visible.
    await expect(locationButton).toHaveAttribute("title", longName);
    await expect(locationButton).toHaveAccessibleName(asPattern(shortName));
    await expect(locationButton).toHaveAccessibleName(asPattern(longName));

    const box = await locationButton.boundingBox();
    expect(box).not.toBeNull();
    // The header grid cell truncates the label instead of growing past its
    // own cell and pushing or overlapping neighboring header content.
    expect(box?.width ?? 0).toBeLessThanOrEqual(220);

    const overflow = await name.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      textOverflow: getComputedStyle(element).textOverflow,
      overflowX: getComputedStyle(element).overflowX,
    }));
    // The short name is long enough to overflow its own span at both tested
    // widths; when it does, the overflow must be presented as an ellipsis
    // (never a hard, unindicated clip) -- on the name only, never eating
    // into the coordinates next to it (#280).
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    expect(overflow.textOverflow).toBe("ellipsis");
    expect(overflow.overflowX).toBe("hidden");
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channel.channelId}/overview`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await checkTruncation();
  // At this width the coordinates stay visible next to the short name.
  // (`textContent` includes hidden descendants, so visibility -- not text
  // presence -- is what actually distinguishes the two breakpoints.)
  await expect(coordinates).toBeVisible();
  await expect(coordinates).toContainText("48.78, 9.18");

  // Playwright's visibility check doesn't account for CSS clipping, so
  // confirm with real geometry that the ellipsis on the name span never eats
  // into the coordinates: the whole coordinates box stays inside the
  // button's box, not just "visible" per Playwright's actionability check.
  const buttonBox = await locationButton.boundingBox();
  const coordinatesBox = await coordinates.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(coordinatesBox).not.toBeNull();
  if (buttonBox !== null && coordinatesBox !== null) {
    expect(coordinatesBox.x).toBeGreaterThanOrEqual(buttonBox.x);
    expect(coordinatesBox.x + coordinatesBox.width).toBeLessThanOrEqual(buttonBox.x + buttonBox.width);
    expect(coordinatesBox.y).toBeGreaterThanOrEqual(buttonBox.y);
    expect(coordinatesBox.y + coordinatesBox.height).toBeLessThanOrEqual(buttonBox.y + buttonBox.height);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await checkTruncation();
  // Below the header's narrow breakpoint the coordinates move into the menu
  // and drop out of the accessible name too (CSS `display: none` removes a
  // node from accessible-name computation, unlike the visually-hidden
  // full-name suffix).
  await expect(coordinates).toBeHidden();
});
