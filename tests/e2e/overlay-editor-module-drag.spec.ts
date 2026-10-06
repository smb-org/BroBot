import { expect, test, type Locator, type Page } from "@playwright/test";

const channelId = "channel-overlay-drag";
const overlayId = "overlay-drag";
const channel = {
  channelId,
  login: "overlay-drag",
  displayName: "Overlay drag",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-09-27T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-drag", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};

const dragElement = async (page: Page, element: Locator): Promise<void> => {
  const bounds = await element.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) return;
  const beforeX = Number(await page.locator("#overlay-editor-x").inputValue());
  await element.evaluate((node) => { (node as HTMLElement).style.pointerEvents = "none"; });
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 100, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#overlay-editor-x").inputValue())).toBeGreaterThan(beforeX);
};

test("module overlay elements have visible previews and drag by their measured bounds", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overlay: {
        id: overlayId,
        channelId,
        name: "Drag test",
        width: 1920,
        height: 1080,
        css: "",
        revision: 1,
        createdAt: "2026-09-27T20:15:00.000Z",
        updatedAt: "2026-09-27T20:15:00.000Z",
        elements: [],
      } }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [], count: 0, maximum: 20 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [
        { id: "ads", enabled: true, settings: "{}" },
        { id: "chat_voting", enabled: true, settings: "{}" },
        { id: "text_library", enabled: true, settings: "{}" },
      ] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/text_library/blocks`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ blocks: [] }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Drag test" })).toBeVisible();
  const frame = page.frameLocator('[data-testid="overlay-editor-renderer"]');

  await page.getByRole("button", { name: "Add voting tally" }).click();
  const tally = frame.locator('[data-kind="chat_voting.tally"]');
  await expect(tally).toBeVisible();
  await expect.poll(async () => (await tally.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  await dragElement(page, tally);

  await page.getByRole("button", { name: "Add text block" }).click();
  const textBlock = frame.locator('[data-kind="text_library.block"]');
  await expect(textBlock).toBeVisible();
  await expect(textBlock).toContainText("Choose a text block");
  await expect.poll(async () => (await textBlock.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  await dragElement(page, textBlock);
});
