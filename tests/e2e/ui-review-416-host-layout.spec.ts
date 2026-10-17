import { expect, test, type Page } from "@playwright/test";

const channelId = "kanal-ui-416";

const channel = (role: string) => ({
  channelId,
  login: "demo-kanal",
  displayName: "Demo Kanal",
  role,
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-demo", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
});
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

const mockDashboard = async (page: Page, role: string, modules: unknown[]): Promise<void> => {
  const selectedChannel = channel(role);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/channels") return route.fulfill(json({ channels: [selectedChannel], bot: selectedChannel.bot }));
    if (path === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...selectedChannel, activeModules: [] }));
    if (path === `/api/channels/${channelId}/settings`) return route.fulfill(json({
      timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }));
    if (path === `/api/channels/${channelId}/members/search`) return route.fulfill(json({ user: null }));
    if (path === `/api/channels/${channelId}/members`) return route.fulfill(json({ members: [], nextCursor: null, broadcasterCount: 0, viewerUserId: "viewer" }));
    if (path === `/api/channels/${channelId}/modules` && method === "GET") return route.fulfill(json({ modules }));
    if (path === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (path === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (path === `/api/channels/${channelId}/overlay-tokens`) return route.fulfill(json({ tokens: [], nextOffset: null }));
    if (path === `/api/channels/${channelId}/variables`) return route.fulfill(json({ variables: [], count: 0, maximum: 25 }));
    if (path === `/api/channels/${channelId}/events` || path === `/api/channels/${channelId}/audit-log`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (path === "/api/csrf") return route.fulfill(json({ token: "csrf" }));
    return route.fulfill(json({}));
  });
};

test("operator module names and centered lock controls fit at 390px", async ({ page }) => {
  await mockDashboard(page, "operator", [
    { id: "text_commands", enabled: true, settings: "{}" },
    { id: "faq", enabled: false, settings: "{}" },
    { id: "votekick", enabled: true, settings: "{}" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules`);

  const rows = page.locator(".module-workspace .list-row");
  await expect(rows.first()).toBeVisible();
  const namesFit = await page.locator(".module-workspace .list-row__title").evaluateAll((names) =>
    names.every((name) => name.scrollWidth <= name.clientWidth + 1));
  expect(namesFit).toBe(true);

  const reason = page.locator(".module-workspace .module-switch-control .ui-locked-reason").first();
  await expect(reason).toBeVisible();
  const row = reason.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' list-row ')]");
  const rowBox = await row.boundingBox();
  const switchBox = await row.getByRole("switch").boundingBox();
  expect(rowBox).not.toBeNull();
  expect(switchBox).not.toBeNull();
  expect(Math.abs((rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2 - ((switchBox?.y ?? 0) + (switchBox?.height ?? 0) / 2))).toBeLessThanOrEqual(2);
});
