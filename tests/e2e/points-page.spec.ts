import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "kanal_demo";
const POINTS_PATH = `/api/channels/${CHANNEL_ID}/modules/points`;

interface Account {
  accountId: string;
  login: string;
  balance: number;
  monthNet: number | null;
}

const installPointsPage = async (page: Page, initialAccounts: Account[]): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    modules: [{
      id: "points",
      enabled: true,
      settings: JSON.stringify({ currencyName: "Punkte", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }),
    }],
  });
  const accounts = [...initialAccounts];
  const history: Record<string, unknown>[] = [];
  const appliedOperations = new Set<string>();
  const failedOperations = new Set<string>();
  let pendingOperationId: string | null = null;
  await page.route(`**${POINTS_PATH}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(POINTS_PATH.length);
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
    if (path === "/settings" && route.request().method() === "GET") {
      return json({ settings: { currencyName: "Punkte", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }, revision: 1, variables: [] });
    }
    if (path === "/summary") return json({ circulation: 4_820, jackpots: { quiz: 1_256 }, inRounds: 300, accounts: accounts.length, month: "2026-10" });
    if (path === "/accounts" && route.request().method() === "GET") {
      return json({ rows: [...accounts].sort((left, right) => right.balance - left.balance), cursor: undefined });
    }
    if (path.endsWith("/rank")) return json({ rank: 3, net: 340 });
    if (path.endsWith("/history")) return json({ rows: history, cursor: undefined });
    if (path.endsWith("/adjust") && route.request().method() === "POST") {
      const accountId = decodeURIComponent(path.split("/").at(-2) ?? "");
      const body = route.request().postDataJSON() as { operationId: string; delta: number; reason: string };
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (account === undefined) return json({ error: "points_account_missing" }, 404);
      if (body.reason === "Netzwerkfehler" && !failedOperations.has(body.operationId)) {
        failedOperations.add(body.operationId);
        return json({ error: "correction_failed" }, 500);
      }
      if (appliedOperations.has(body.operationId)) return json({ balance: account.balance, auditPending: false });
      if (pendingOperationId !== null) {
        if (pendingOperationId !== body.operationId) return json({ error: "operation_conflict" }, 409);
        appliedOperations.add(body.operationId);
        pendingOperationId = null;
        return json({ balance: account.balance, auditPending: false });
      }
      pendingOperationId = body.operationId;
      account.balance += body.delta;
      history.unshift({
        operationId: `admin:${body.operationId}`,
        kind: "admin",
        moduleId: "points",
        delta: body.delta,
        balanceAfter: account.balance,
        at: "2026-10-19T12:00:00.000Z",
        detail: { reason: body.reason, actorLogin: "kanal_demo" },
      });
      return json({ balance: account.balance, auditPending: true }, 202);
    }
    return json({ error: "unhandled_points_request" }, 404);
  });
};

test("keeps the account layout inside the viewport at desktop widths (protects=title, save status and selected row stay readable at 1440px and 1920px; fails_when=the title collapses, save cluster clips, row gains an accent bar, or page overflows; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [
    { accountId: "viewer_demo", login: "pixelpilz", balance: 1_000, monthNet: 340 },
    { accountId: "viewer_zero", login: "funkenflug", balance: 620, monthNet: null },
  ]);
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  const row = page.getByRole("listitem").filter({ hasText: "pixelpilz" });
  await expect(row).toBeVisible();
  await expect(page.getByText("+340 im Oktober", { exact: true })).toBeVisible();
  await expect(page.getByText("Noch kein Spiel im Oktober", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Person suchen")).toHaveAccessibleName("Person suchen");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await row.click();
    const title = page.locator(".points-detail__header h2");
    await expect(title).toBeVisible();
    const box = await title.boundingBox();
    expect(box, `account title has a box at ${String(viewport.width)}px`).not.toBeNull();
    expect(box?.width, `account title width at ${String(viewport.width)}px`).toBeGreaterThanOrEqual(120);
    expect(box?.height, `account title height at ${String(viewport.width)}px`).toBeLessThan(40);

    await page.getByLabel("Betrag ±").fill("15");
    await page.getByLabel("Grund").fill("Kanalwette");
    const header = page.locator(".points-detail__header");
    const headerBox = await header.boundingBox();
    const saveButton = header.getByRole("button", { name: "Speichern" });
    const saveBox = await saveButton.boundingBox();
    expect(headerBox, `detail header has a box at ${String(viewport.width)}px`).not.toBeNull();
    expect(saveBox, `save button has a box at ${String(viewport.width)}px`).not.toBeNull();
    expect(saveBox?.x).toBeGreaterThanOrEqual(0);
    expect((saveBox?.x ?? 0) + (saveBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect(saveBox?.y).toBeGreaterThanOrEqual(headerBox?.y ?? 0);
    expect((saveBox?.y ?? 0) + (saveBox?.height ?? 0)).toBeLessThanOrEqual((headerBox?.y ?? 0) + (headerBox?.height ?? 0));
    const status = header.getByRole("status");
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Ungespeichert");

    const leftBorderWidth = await row.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderLeftWidth));
    expect(leftBorderWidth).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await saveButton.click();
    await expect(status).toHaveText("Korrektur gebucht · Protokollierung ausstehend");
    await expect(header.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
    await header.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(status).toHaveText("Gespeichert");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByLabel("Betrag ±").fill("25");
    await page.getByLabel("Grund").fill("Netzwerkfehler");
    await header.getByRole("button", { name: "Speichern" }).click();
    await expect(status).toHaveText("× Korrektur konnte nicht gespeichert werden.");
    await expect(header.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
    await header.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(status).toHaveText("Korrektur gebucht · Protokollierung ausstehend");
    await header.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(status).toHaveText("Gespeichert");
  }
});

test("lists accounts, selects one, corrects its balance, and shows the history row (protects=correction retry shows a pending audit and reuses one committed balance and history row; fails_when=retry duplicates the correction or omits the pending status; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [{ accountId: "viewer_demo", login: "pixelpilz", balance: 1_000, monthNet: 340 }]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);

  await expect(page.getByRole("heading", { name: "Punkte" }).first()).toBeVisible();
  await expect(page.getByText("Spiele", { exact: true }).first()).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "pixelpilz" });
  await expect(row).toContainText("1.000");
  await row.click();
  await expect(page.getByRole("heading", { name: "pixelpilz" })).toBeVisible();
  await page.getByLabel("Betrag ±").fill("15");
  await page.getByLabel("Grund").fill("Kanalwette");
  await expect(page.getByText("Neuer Stand: 1.015 Punkte")).toBeVisible();
  await page.locator(".points-detail__header .ui-save-bar__save").click();

  await expect(page.locator(".points-detail__header [role='status']")).toHaveText("Korrektur gebucht · Protokollierung ausstehend");
  await expect(page.locator(".points-detail__balance")).toContainText("1.015");
  await expect(page.locator(".points-correction__preview")).toHaveText("Neuer Stand: 1.015 Punkte");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.locator(".points-detail__header [role='status']")).toHaveText("Gespeichert");
  await expect(page.locator(".points-detail__balance")).toContainText("1.015");
  await expect(page.getByText("Korrektur · Kanalwette · von kanal_demo", { exact: true })).toHaveCount(1);
  await expect(page.locator(".points-history__table")).toContainText("+15");
});

test("shows the empty account state with the chat prompt and timer action (protects=empty collection directs the streamer to the chat game and timer setup; fails_when=it shows a selection hint or omits the timer action; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, []);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);

  await expect(page.getByText("Noch keine Konten. Punkte entstehen, sobald jemand im Chat schreibt.")).toBeVisible();
  await expect(page.getByText("Sag deinem Chat Bescheid: !spiele")).toBeVisible();
  await expect(page.getByRole("button", { name: "Als Timer anlegen" })).toHaveCount(2);
  await expect(page.locator(".points-detail-empty").getByRole("button", { name: "Als Timer anlegen" })).toBeVisible();
  await expect(page.locator(".collection-page__list-content .list-pagination-footer")).toHaveCount(0);
});
