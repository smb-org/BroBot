import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const channelId = "screenshots-415-channel";
const channel = {
  channelId,
  login: "screenshots-415",
  displayName: "Screenshots 415 Channel",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "screenshots-415-subscription", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};

const moduleIds = ["ads", "belabox", "chat_voting", "clips", "faq", "moon", "raid", "sun", "text_commands", "text_library", "timers", "votekick", "weather"];
const routes = [
  ["overview", "/"],
  ["platform", "/platform"],
  ["channel-overview", `/channels/${channelId}`],
  ...["system", "members", "variables", "overlays", "events", "modules", "audit"].map((section) => [section, `/channels/${channelId}/${section}`]),
  ["overlay-new", `/channels/${channelId}/overlays/new?name=Fictional%20Overlay`],
  ["overlay-existing", `/channels/${channelId}/overlays/layout-415`],
  ...moduleIds.map((moduleId) => [`module-${moduleId}`, `/channels/${channelId}/modules/${moduleId}`]),
] as const;

test("capture route screenshots for issue 415", async ({ page }) => {
  test.skip(process.env.ISSUE_415_CAPTURE !== "1", "route screenshots are a manual review artifact");
  test.setTimeout(10 * 60 * 1000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !/^WebSocket connection to 'ws:\/\/localhost:\d+\/ws\/channels\//u.test(text)) browserErrors.push(text);
  });
  await page.addInitScript(() => { window.localStorage.setItem("brobot.palette", "nachtschicht"); });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (data: unknown) => { return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) }); };
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot, platformAdmin: true, viewerIsBot: false });
    if (pathname === "/api/platform") return json({ channels: [] });
    if (pathname === "/api/platform/audit") return json({ entries: [], nextCursor: null });
    if (pathname === `/api/channels/${channelId}/overview`) return json({
      ...channel,
      modules: moduleIds.map((id) => ({ id, enabled: false, settings: "{}" })),
      activeModules: [],
    });
    if (pathname === `/api/channels/${channelId}/settings`) return json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1 });
    if (pathname === `/api/channels/${channelId}/revisions`) return json({ revisions: {} });
    if (pathname === `/api/channels/${channelId}/modules` && route.request().method() === "GET") return json({ modules: moduleIds.map((id) => ({ id, enabled: false, settings: "{}" })) });
    if (pathname === `/api/channels/${channelId}/overlay-tokens`) return json({ tokens: [], nextOffset: null });
    if (pathname === `/api/channels/${channelId}/system`) return json({ broadcasterConnection: channel.broadcasterConnection, bot: channel.bot, botPermissions: null, broadcasterPermissions: null, chatSubscription: channel.chatSubscription, tokens: channel.tokens });
    if (pathname === `/api/channels/${channelId}/members`) return json({ members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "fictional-viewer" });
    if (pathname === `/api/channels/${channelId}/variables`) return json({ variables: [], count: 0, maximum: 25 });
    if (pathname === `/api/channels/${channelId}/overlays`) return json({ overlays: [{ id: "layout-415", name: "Fictional Overlay", elementCount: 0, accessCount: 0, lastUsedAt: null }], maximum: 20, elementMaximum: 20 });
    if (pathname === `/api/channels/${channelId}/audit-log`) return json({ entries: [], nextCursor: null });
    if (pathname === `/api/channels/${channelId}/events`) return json({ entries: [], nextCursor: null });
    if (pathname === "/api/csrf") return json({ token: "screenshots-415-token" });
    return json({});
  });

  const outputDirectory = process.env.ISSUE_415_SCREENSHOT_DIR ?? "/private/tmp/claude-501/-Users-sb-tools-BroBot/1cad8a03-1f71-4060-966c-d4bb551755e6/scratchpad/shots-415/after";
  await mkdir(outputDirectory, { recursive: true });
  for (const [width, height, sizeName] of [[1920, 1080, "1920x1080"], [390, 844, "390x844"]] as const) {
    await page.setViewportSize({ width, height });
    for (const [routeName, path] of routes) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.locator("#root").waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(outputDirectory, `${routeName}-${sizeName}.png`), animations: "disabled" });
    }
  }
  expect(browserErrors).toEqual([]);
});
