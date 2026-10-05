import { expect, test, type Locator } from "@playwright/test";

test.use({ locale: "de-DE" });

const channelId = "kanal-overlay-copy";
const channel = {
  channelId,
  login: "overlay-copy",
  displayName: "Overlay Copy",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-copy", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};
const overlay = {
  id: "overlay-a",
  channelId,
  name: "Gameplay",
  width: 1920,
  height: 1080,
  css: "",
  revision: 1,
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-20T08:00:00.000Z",
  elements: [],
};
const mainAccess = {
  tokenId: "access-main",
  overlayId: overlay.id,
  label: "OBS Main PC",
  createdAt: "2026-09-20T10:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  recoverable: true,
};
const backupAccess = {
  ...mainAccess,
  tokenId: "access-backup",
  label: "OBS Backup PC",
  createdAt: "2026-09-20T09:00:00.000Z",
};
const overlayUrl = `https://brobot.example/overlay#token=${"f".repeat(43)}`;

test("copying an overlay link stays collapsed and keeps neighboring boxes in place", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          (window as Window & { copiedOverlayLink?: string }).copiedOverlayLink = text;
          return Promise.resolve();
        },
      },
    });
  });
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
    } else if (pathname === "/api/csrf") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "csrf-copy" }) });
    } else if (pathname === `/api/channels/${channelId}/overlays` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          overlays: [{ ...overlay, elementCount: 0, accessCount: 2, lastUsedAt: null }],
          maximum: 20,
          elementMaximum: 20,
        }),
      });
    } else if (pathname === `/api/channels/${channelId}/overlay-tokens`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tokens: [], nextOffset: null }) });
    } else if (pathname === `/api/channels/${channelId}/overlays/${overlay.id}`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overlay }) });
    } else if (pathname === `/api/channels/${channelId}/overlays/${overlay.id}/accesses` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accesses: [mainAccess, backupAccess], activeCount: 2, maximum: 10 }),
      });
    } else if (pathname === `/api/channels/${channelId}/overlays/${overlay.id}/accesses/${mainAccess.tokenId}/reveal`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overlayUrl }) });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/overlays`);
  await page.getByRole("row", { name: /Gameplay/ }).click();

  const mainRow = page.locator(".overlay-access-list__item").filter({ hasText: "OBS Main PC" });
  const backupRow = page.locator(".overlay-access-list__item").filter({ hasText: "OBS Backup PC" });
  await expect(mainRow).toBeVisible();
  const copyButton = mainRow.locator(".overlay-access-list__copy");
  const menuButton = mainRow.getByRole("button", { name: "Aktionen für OBS Main PC" });
  const before = {
    copy: await copyButton.boundingBox(),
    menu: await menuButton.boundingBox(),
    nextRow: await backupRow.boundingBox(),
  };
  expect(before.copy).not.toBeNull();
  expect(before.menu).not.toBeNull();
  expect(before.nextRow).not.toBeNull();

  await copyButton.click();
  await expect(copyButton).toHaveAttribute("aria-label", "Kopiert: OBS Main PC");
  await expect(mainRow.locator(".overlay-access-list__expanded")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { copiedOverlayLink?: string }).copiedOverlayLink)).toBe(overlayUrl);

  const after = {
    copy: await copyButton.boundingBox(),
    menu: await menuButton.boundingBox(),
    nextRow: await backupRow.boundingBox(),
  };
  expect(after.copy).not.toBeNull();
  expect(after.menu).not.toBeNull();
  expect(after.nextRow).not.toBeNull();
  const expectSameBox = (
    beforeBox: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>> | null,
    afterBox: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>> | null,
  ): void => {
    if (beforeBox === null || afterBox === null) throw new Error("An overlay access box is missing.");
    expect(Math.abs(afterBox.x - beforeBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(afterBox.y - beforeBox.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(afterBox.width - beforeBox.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(afterBox.height - beforeBox.height)).toBeLessThanOrEqual(0.5);
  };
  expectSameBox(before.copy, after.copy);
  expectSameBox(before.menu, after.menu);
  expectSameBox(before.nextRow, after.nextRow);
});
