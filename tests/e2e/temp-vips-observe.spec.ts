import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ModuleTempVipRow } from "../../src/modules/contract";

const channelId = "channel-temp-vips-observe";
const now = "2026-10-31T12:00:00.000Z";
const settings = { defaultDurationDays: 7, maximumDurationDays: 90, announceExpiry: false };
const widths = [390, 1280, 1920] as const;

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const personRow = (login: string, classification: ModuleTempVipRow["classification"], expiresAt: string | null): ModuleTempVipRow => ({
  userId: `user_${login}`,
  login,
  displayName: login === "pixelpilz" ? "Pixelpilz" : login,
  expiresAt,
  grantedAt: "2026-10-30T12:00:00.000Z",
  grantedByUserId: null,
  grantedByLogin: null,
  source: "observed",
  classification,
  confirmation: "confirmed",
  expiryReminderAt: null,
  removalFailedAt: null,
  removalAttempts: 0,
  removalError: null,
  endReason: null,
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const mockObserveDashboard = async (page: Page): Promise<void> => {
  let rows: ModuleTempVipRow[] = [
    personRow("pixelpilz", "unclassified", null),
    personRow("mondfuchs", "temporary", "2026-10-30T11:00:00.000Z"),
    personRow("nachtfalke", "permanent", null),
  ];
  const timestamp = now;
  const channel = {
    channelId,
    login: "beispielkanal",
    displayName: "Beispielkanal",
    language: "de",
    role: "manager",
    location: null,
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: timestamp },
    botPermissions: null,
    broadcasterPermissions: null,
    moderator: { isModerator: true, checkedAt: timestamp, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "sub-temp-vips-observe", reason: null, updatedAt: timestamp },
    streamState: "online",
    streamStartedAt: "2026-10-31T11:00:00.000Z",
    modules: [{ id: "temp_vips", enabled: true, settings: JSON.stringify(settings), mandatory: false }],
    controls: {
      mute: { active: false, until: null, mode: null },
      pause: { active: false, until: null, mode: null },
    },
    tokens: {
      botExpiresAt: "2099-10-31T12:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-10-31T12:00:00.000Z",
    },
    lastError: null,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/channels") {
      return route.fulfill(json({ channels: [channel], bot: channel.bot, platformAdmin: false, viewerIsBot: false }));
    }
    if (url.pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({ ...channel, activeModules: [{ moduleId: "temp_vips", settings: JSON.stringify(settings) }], viewerCount: 42 }));
    }
    if (url.pathname === `/api/channels/${channelId}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (url.pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (url.pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (url.pathname === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (url.pathname === `/api/channels/${channelId}/system`) {
      return route.fulfill(json({
        broadcasterConnection: "connected", bot: channel.bot, botPermissions: channel.botPermissions,
        broadcasterPermissions: channel.broadcasterPermissions, chatSubscription: channel.chatSubscription,
        chatSubscriptionNeeded: false, subscriptions: [], tokens: channel.tokens,
      }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules` && method === "GET") {
      return route.fulfill(json({ modules: [{ ...channel.modules[0], requiredBroadcasterScopes: [], missingBroadcasterScopes: [], optionalBroadcasterScopes: ["channel:manage:vips"], missingOptionalBroadcasterScopes: ["channel:manage:vips"] }] }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/settings`) {
      return route.fulfill(json({ settings, revision: 1, variables: [] }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/vips`) {
      return route.fulfill(json({ rows, settings, timeZone: "Europe/Berlin", mode: "observe", now }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/vips/observed` && method === "POST") {
      const body = request.postDataJSON() as { login: string };
      const row = personRow(body.login, "unclassified", null);
      rows = [...rows, row];
      return route.fulfill(json({ status: "observed_added", row }));
    }
    if (url.pathname.startsWith(`/api/channels/${channelId}/modules/temp_vips/vips/`) && url.pathname.endsWith("/classify") && method === "POST") {
      const userId = url.pathname.split("/").at(-2) ?? "";
      const body = request.postDataJSON() as { classification: "permanent" | "temporary"; durationMs?: number };
      const row = rows.find((candidate) => candidate.userId === userId);
      if (row === undefined) return route.fulfill(json({ status: "not_managed" }));
      row.classification = body.classification;
      row.expiresAt = body.classification === "temporary" ? new Date(Date.parse(now) + (body.durationMs ?? 7 * 24 * 60 * 60 * 1_000)).toISOString() : null;
      return route.fulfill(json({ status: "classified", row }));
    }
    if (url.pathname.startsWith(`/api/channels/${channelId}/modules/temp_vips/vips/`) && url.pathname.endsWith("/release") && method === "POST") {
      const userId = url.pathname.split("/").at(-2) ?? "";
      rows = rows.filter((candidate) => candidate.userId !== userId);
      return route.fulfill(json({ status: "released" }));
    }
    if (url.pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-temp-vips-observe" }));
    return route.fulfill(json({}));
  });
};

for (const width of widths) {
  test(`shows and classifies observed VIPs with manual add at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.clock.install({ time: new Date(now) });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockObserveDashboard(page);
    await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);

    await expect(page.locator(".temp-vips-mode")).toContainText("Beobachtungsmodus");
    await expect(page.getByRole("button", { name: "VIP per Login ergänzen" })).toBeVisible();
    const rows = page.locator(".temp-vips-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("@mondfuchs");
    await expect(rows.nth(0)).toContainText("Abgelaufen – bitte /unvip @mondfuchs");
    await expect(rows.nth(0).getByRole("button", { name: "Befehl kopieren" })).toBeVisible();
    await expect(rows.nth(1)).toContainText("Neu · nicht eingestuft");
    await expect(rows.nth(1).getByRole("button", { name: "Dauerhaft" })).toBeVisible();
    await expect(rows.nth(1).getByRole("button", { name: "Temporär" })).toBeVisible();
    await expect(rows.nth(0).getByRole("button", { name: "Verwaltung abgeben · VIP behalten" })).toBeVisible();
    await expect(rows.nth(1).getByRole("button", { name: "Verwaltung abgeben · VIP behalten" })).toBeVisible();
    await expect(rows.nth(2).getByRole("button", { name: "Verwaltung abgeben · VIP behalten" })).toBeVisible();
    if (width > 899) await expect(page.getByText(/Hinweis: Verliert Twitch eine Meldung/u)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await rows.nth(0).getByRole("button", { name: "Befehl kopieren" }).click();
    await expect(page.locator(".temp-vips-page__feedback")).toContainText("Befehl kopiert");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/unvip @mondfuchs");

    await rows.nth(1).getByRole("button", { name: "Temporär" }).click();
    const classifyDialog = page.getByRole("dialog", { name: "VIP für Pixelpilz als temporär einstufen" });
    await classifyDialog.getByRole("button", { name: "Übernehmen" }).click();
    await expect(classifyDialog).toBeHidden();
    await expect(page.locator(".temp-vips-row").filter({ hasText: "@pixelpilz" })).not.toContainText("Neu · nicht eingestuft");

    await page.getByRole("button", { name: "VIP per Login ergänzen" }).click();
    const addDialog = page.getByRole("dialog", { name: "VIP per Login ergänzen" });
    await addDialog.getByRole("textbox", { name: "Name" }).fill(`sternchen${String(width)}`);
    await addDialog.getByRole("button", { name: "VIP per Login ergänzen" }).click();
    await expect(addDialog).toBeHidden();
    await expect(page.locator(".temp-vips-row").filter({ hasText: `@sternchen${String(width)}` })).toContainText("Neu · nicht eingestuft");

    if (width === 390) {
      const permanentRow = page.locator(".temp-vips-row").filter({ hasText: "@nachtfalke" });
      await permanentRow.getByRole("button", { name: "Verwaltung abgeben · VIP behalten" }).click();
      await expect(page.locator(".temp-vips-row").filter({ hasText: "@nachtfalke" })).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
