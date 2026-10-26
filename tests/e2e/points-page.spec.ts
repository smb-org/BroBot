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

interface PointsPageControls {
  adjustmentRequests: { accountId: string; body: { operationId: string; delta: number; reason: string } }[];
  settingsSaves: { revision: number; settings: Record<string, unknown> }[];
  waitForDelayedAdjustment: () => Promise<void>;
  releaseDelayedAdjustment: () => void;
}

const installPointsPage = async (page: Page, initialAccounts: Account[], includeTimers = false): Promise<PointsPageControls> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    modules: [
      {
        id: "points",
        enabled: true,
        settings: JSON.stringify({ currencyName: "Punkte", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }),
      },
      ...(includeTimers ? [{ id: "timers", enabled: true, settings: "{}" }] : []),
    ],
  });
  const accounts = [...initialAccounts];
  const history: Record<string, unknown>[] = [];
  const appliedOperations = new Set<string>();
  const failedOperations = new Set<string>();
  const controls: PointsPageControls = {
    adjustmentRequests: [],
    settingsSaves: [],
    waitForDelayedAdjustment: () => delayedAdjustmentStarted,
    releaseDelayedAdjustment: () => { releaseDelayedAdjustment?.(); },
  };
  let pendingOperationId: string | null = null;
  let settingsRevision = 1;
  let settings = { currencyName: "Punkte", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 };
  const historyReads = new Map<string, number>();
  let releaseDelayedAdjustment: (() => void) | null = null;
  let signalDelayedAdjustment: () => void = () => undefined;
  const delayedAdjustmentStarted = new Promise<void>((resolve) => { signalDelayedAdjustment = resolve; });
  await page.route(`**${POINTS_PATH}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(POINTS_PATH.length);
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
    if (path === "/settings" && route.request().method() === "GET") {
      return json({ settings, revision: settingsRevision, variables: [] });
    }
    if (path === "/settings" && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { revision: number; settings: typeof settings };
      settings = body.settings;
      settingsRevision += 1;
      controls.settingsSaves.push(body);
      return json({ settings, revision: settingsRevision, variables: [] });
    }
    if (path === "/summary") return json({ circulation: 4_820, jackpots: { quiz: 1_256 }, inRounds: 300, accounts: accounts.length, month: "2026-10" });
    if (path === "/accounts" && route.request().method() === "GET") {
      return json({ rows: [...accounts].sort((left, right) => right.balance - left.balance), cursor: undefined });
    }
    const accountMatch = path.match(/^\/accounts\/([^/]+)$/u);
    if (accountMatch !== null && route.request().method() === "GET") {
      const account = accounts.find((entry) => entry.accountId === decodeURIComponent(accountMatch[1] ?? ""));
      return account === undefined
        ? json({ error: "points_account_missing" }, 404)
        : json({ accountId: account.accountId, login: account.login, balance: account.balance });
    }
    if (path.endsWith("/rank")) return json({ rank: 3, net: 340 });
    if (path.endsWith("/history")) {
      const accountId = path.split("/").at(-2) ?? "";
      const reads = historyReads.get(accountId) ?? 0;
      historyReads.set(accountId, reads + 1);
      if (accountId === "viewer_error" && reads === 0) return json({ error: "history_unavailable" }, 503);
      return json({ rows: history, cursor: undefined });
    }
    if (path.endsWith("/adjust") && route.request().method() === "POST") {
      const accountId = decodeURIComponent(path.split("/").at(-2) ?? "");
      const body = route.request().postDataJSON() as { operationId: string; delta: number; reason: string };
      controls.adjustmentRequests.push({ accountId, body });
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (account === undefined) return json({ error: "points_account_missing" }, 404);
      if (body.reason === "Nicht genug Punkte") return json({ error: "insufficient_balance" }, 400);
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
      if (body.reason === "Verzögerte Antwort") {
        signalDelayedAdjustment();
        await new Promise<void>((resolve) => { releaseDelayedAdjustment = resolve; });
      }
      return json({ balance: account.balance, auditPending: true }, 202);
    }
    return json({ error: "unhandled_points_request" }, 404);
  });
  return controls;
};

test("keeps the account layout inside the viewport at desktop widths (protects=title, save status and selected row stay readable at 1440px and 1920px; fails_when=the title collapses, save cluster clips, row gains an accent bar, or page overflows; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [
    { accountId: "viewer_demo", login: "pixelpilz", balance: 1_000, monthNet: 340 },
    { accountId: "viewer_zero", login: "funkenflug", balance: 620, monthNet: null },
  ]);
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  const row = page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" });
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
    const actionsBox = await page.locator(".points-page-actions").boundingBox();
    expect((actionsBox?.y ?? 0) + (actionsBox?.height ?? 0), `page actions end above the inspector header at ${String(viewport.width)}px`).toBeLessThanOrEqual(headerBox?.y ?? 0);
    await expect(page.getByRole("button", { name: "Einstellungen" })).toHaveCount(1);
    await expect(header.getByRole("button", { name: "Weitere Aktionen" })).toHaveCount(0);

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
  const row = page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" });
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
  await expect(page.locator(".points-history .list-pagination-footer__count")).toHaveText("1 Eintrag");
  await expect(page.locator(".list-toolbar__usage")).toHaveText("1 Konto");
});

test("shows the empty account state with the chat prompt and timer action (protects=empty collection directs the streamer to the chat game and timer setup; fails_when=it shows a selection hint or omits the timer action; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, []);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);

  await expect(page.getByText("Noch keine Konten. Punkte entstehen, sobald jemand im Chat schreibt.")).toBeVisible();
  await expect(page.getByText("Sag deinem Chat Bescheid: !spiele")).toBeVisible();
  await expect(page.getByRole("button", { name: "Als Timer anlegen" })).toHaveCount(1);
  await expect(page.locator(".points-detail-empty").getByRole("button", { name: "Als Timer anlegen" })).toBeVisible();
  await page.locator(".points-page-actions").getByRole("button", { name: "Weitere Aktionen" }).click();
  await expect(page.getByRole("menuitem", { name: "Als Timer anlegen" })).toBeVisible();
  await expect(page.locator(".collection-page__list-content .list-pagination-footer")).toHaveCount(0);
});

test("keeps a delayed correction response attached to the account that was submitted (protects=late correction responses cannot overwrite the newly selected account; fails_when=the new account balance or preview shows the old response; no_claim=points APIs are mocked)", async ({ page }) => {
  const controls = await installPointsPage(page, [
    { accountId: "viewer_alice", login: "nachtfalke", balance: 1_000, monthNet: 0 },
    { accountId: "viewer_bob", login: "pixelpilz", balance: 200, monthNet: 0 },
  ]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "nachtfalke" }).click();
  await page.getByLabel("Betrag ±").fill("15");
  await page.getByLabel("Grund").fill("Verzögerte Antwort");
  await page.locator(".points-detail__header .ui-save-bar__save").click();
  await controls.waitForDelayedAdjustment();

  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" }).click();
  await expect(page.getByRole("heading", { name: "pixelpilz" })).toBeVisible();
  await expect(page.locator(".points-detail__balance")).toContainText("200");
  await expect(page.locator(".points-correction__preview")).toHaveText("Neuer Stand: 200 Punkte");
  controls.releaseDelayedAdjustment();
  await expect(page.locator(".points-detail__balance")).toContainText("200");
  await expect(page.locator(".points-correction__preview")).toHaveText("Neuer Stand: 200 Punkte");
});

test("restores an audit-pending correction after switching accounts so it can be retried (protects=an audit-pending correction remains retryable after account selection changes; fails_when=retry data is lost, editable, or submitted with a new operation identity; no_claim=module APIs are mocked)", async ({ page }) => {
  const controls = await installPointsPage(page, [
    { accountId: "viewer_alice", login: "nachtfalke", balance: 1_000, monthNet: 0 },
    { accountId: "viewer_bob", login: "pixelpilz", balance: 200, monthNet: 0 },
  ]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "nachtfalke" }).click();
  const correctionFields = page.locator(".points-correction__fields input");
  await correctionFields.nth(0).fill("15");
  await correctionFields.nth(1).fill("stream prize");
  const header = page.locator(".points-detail__header");
  await header.locator(".ui-save-bar__save").click();
  await expect(header.locator(".ui-save-bar__save")).toBeVisible();
  await expect(header.locator(".ui-save-bar__discard")).toBeDisabled();

  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" }).click();
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "nachtfalke" }).click();

  await expect(correctionFields.nth(0)).toHaveValue("15");
  await expect(correctionFields.nth(1)).toHaveValue("stream prize");
  await expect(header.locator(".ui-save-bar__save")).toBeEnabled();
  await expect(header.locator(".ui-save-bar__discard")).toBeDisabled();
  await expect(correctionFields.nth(0)).toBeDisabled();
  await expect(correctionFields.nth(1)).toBeDisabled();

  await header.locator(".ui-save-bar__save").click();
  await expect(correctionFields.nth(0)).toBeEnabled();
  await expect(correctionFields.nth(0)).toHaveValue("");
  expect(controls.adjustmentRequests).toHaveLength(2);
  expect(controls.adjustmentRequests[1]).toEqual(controls.adjustmentRequests[0]);
});

test("clears retry state after a definite insufficient-balance rejection (protects=definite correction rejection restores editable draft controls; fails_when=the UI keeps an ambiguous retry action or locks the draft; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [{ accountId: "viewer_demo", login: "pixelpilz", balance: 20, monthNet: 0 }]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" }).click();
  await page.getByLabel("Betrag ±").fill("-10");
  await page.getByLabel("Grund").fill("Nicht genug Punkte");
  await page.locator(".points-detail__header .ui-save-bar__save").click();

  const header = page.locator(".points-detail__header");
  await expect(header.getByRole("status")).toContainText("Stand darf nicht unter 0 fallen");
  await expect(header.getByRole("button", { name: "Speichern" })).toBeEnabled();
  await expect(header.getByRole("button", { name: "Erneut versuchen" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Verwerfen" })).toBeEnabled();
  await expect(page.getByLabel("Grund")).toBeEnabled();
});

test("shows a reserved field error when the correction reason exceeds the server limit (protects=the reason limit is visible before submitting; fails_when=an overlong reason can be saved or the error shifts the layout; no_claim=module APIs are mocked)", async ({ page }) => {
  const controls = await installPointsPage(page, [{ accountId: "viewer_demo", login: "pixelpilz", balance: 100, monthNet: 0 }]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" }).click();
  await page.getByLabel("Betrag ±").fill("5");
  const reason = page.getByLabel("Grund");
  await reason.fill("R".repeat(161));

  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Der Grund darf höchstens 160 Zeichen lang sein.");
  await expect(page.locator(".points-detail__header").getByRole("button", { name: "Speichern" })).toBeDisabled();
  await expect(page.locator(".points-detail__header").getByRole("button", { name: "Verwerfen" })).toBeEnabled();
  expect(controls.adjustmentRequests).toHaveLength(0);
});

test("shows history loading, retryable errors, and confirmed empty results in one reserved area (protects=history states occupy one stable area and errors remain retryable; fails_when=loading, error, and empty states shift content or an error looks empty; no_claim=history responses are controlled by route mocks)", async ({ page }) => {
  await installPointsPage(page, [
    { accountId: "viewer_error", login: "funkenflug", balance: 120, monthNet: 0 },
    { accountId: "viewer_empty", login: "abendstern", balance: 80, monthNet: 0 },
  ]);
  const releaseFirstHistory: { current: () => void } = { current: () => undefined };
  let signalFirstHistory: () => void = () => undefined;
  const firstHistoryStarted = new Promise<void>((resolve) => { signalFirstHistory = resolve; });
  const firstHistoryResponse = new Promise<void>((resolve) => { releaseFirstHistory.current = resolve; });
  await page.route(`**${POINTS_PATH}/accounts/viewer_error/history*`, async (route) => {
    signalFirstHistory();
    await firstHistoryResponse;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "history_unavailable" }) });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "funkenflug" }).click();

  const history = page.locator(".points-history");
  await firstHistoryStarted;
  await expect(history.getByRole("status")).toHaveText("Verlauf wird geladen …");
  const loadingBox = await page.locator(".points-history__content").boundingBox();
  releaseFirstHistory.current();
  await expect(history.getByRole("alert")).toHaveText("Verlauf konnte nicht geladen werden.");
  await expect(history.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
  await expect(history.getByText("Noch kein Verlauf.", { exact: true })).toHaveCount(0);
  const errorBox = await page.locator(".points-history__content").boundingBox();
  expect(errorBox?.height).toBe(loadingBox?.height);
  expect(errorBox?.y).toBe(loadingBox?.y);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "abendstern" }).click();
  await expect(history.getByText("Noch kein Verlauf.", { exact: true })).toBeVisible();
  const emptyBox = await page.locator(".points-history__content").boundingBox();
  expect(emptyBox?.height).toBe(errorBox?.height);
  expect(emptyBox?.y).toBe(errorBox?.y);
});

test("loads points settings, discards an edit, and saves explicitly (protects=settings require an explicit save and discard restores stored values; fails_when=typing autosaves or discard retains the draft; no_claim=module settings APIs are mocked)", async ({ page }) => {
  const controls = await installPointsPage(page, []);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await expect(page.getByRole("button", { name: "Einstellungen" })).toHaveCount(1);
  await page.getByRole("button", { name: "Einstellungen" }).click();

  const settings = page.locator(".points-settings");
  await expect(settings.getByRole("heading", { name: "Punkte-Einstellungen" })).toBeVisible();
  const startBonus = settings.getByLabel("Startguthaben");
  await expect(startBonus).toHaveValue("100");
  await startBonus.fill("125");
  expect(controls.settingsSaves).toHaveLength(0);
  await settings.getByRole("button", { name: "Verwerfen" }).click();
  await expect(startBonus).toHaveValue("100");

  const currencyName = settings.getByLabel("Währungsname");
  await currencyName.fill("Sterne");
  expect(controls.settingsSaves).toHaveLength(0);
  await settings.getByRole("button", { name: "Speichern" }).click();
  await expect.poll(() => controls.settingsSaves).toHaveLength(1);
  expect(controls.settingsSaves[0]).toMatchObject({
    revision: 1,
    settings: { currencyName: "Sterne", startBonus: 100 },
  });
  await expect(currencyName).toHaveValue("Sterne");

  await settings.getByRole("button", { name: "Zur Liste" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByText("Noch keine Konten. Punkte entstehen, sobald jemand im Chat schreibt.")).toBeVisible();
});

test("keeps the correction save button quiet until there is something to save (protects=Speichern is visibly inactive for an empty correction and becomes primary without moving; fails_when=the empty form shows a gold button or the button jumps when the form turns dirty; no_claim=module APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [{ accountId: "viewer_demo", login: "pixelpilz", balance: 1_000, monthNet: 340 }]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-account-list").getByRole("button").filter({ hasText: "pixelpilz" }).click();
  const save = page.locator(".points-detail__header").getByRole("button", { name: "Speichern" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const quietBox = await save.boundingBox();
  const fieldsBox = await page.locator(".points-correction__fields").boundingBox();

  await page.getByLabel("Betrag ±").fill("15");
  await page.getByLabel("Grund").fill("Kanalwette");
  await expect(save).toBeEnabled();
  await expect(save).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await save.boundingBox()).toEqual(quietBox);
  expect(await page.locator(".points-correction__fields").boundingBox()).toEqual(fieldsBox);
});

test("prepares the games timer text and creates it only after an explicit save (protects=timer setup starts with the games prompt and creates only after save; fails_when=opening the action creates a timer or the saved text differs; no_claim=timer and preview APIs are mocked)", async ({ page }) => {
  await installPointsPage(page, [], true);
  let createdInput: Record<string, unknown> | null = null;
  const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/timers/timers`, async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill(json({ timers: [] }));
    createdInput = route.request().postDataJSON() as Record<string, unknown>;
    const input = createdInput as { name: string; messageText: string; chatTarget: string | null; trigger: unknown };
    return route.fulfill(json({ timer: {
      id: "timer-games",
      name: input.name,
      enabled: true,
      messageText: input.messageText,
      chatTarget: input.chatTarget,
      trigger: input.trigger,
      revision: 1,
      nextRunAt: null,
      nextRunState: null,
      lastRunAt: null,
      createdAt: "2026-10-19T12:00:00.000Z",
      updatedAt: "2026-10-19T12:00:00.000Z",
    } }));
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/timers/event-time-sources`, (route) => route.fulfill(json({ sources: [] })));
  await page.route(`**/api/channels/${CHANNEL_ID}/template-variables`, (route) => route.fulfill(json({ variables: [] })));
  await page.route("**/api/csrf", (route) => route.fulfill(json({ token: "csrf-points" })));
  await page.route(`**/api/channels/${CHANNEL_ID}/template-preview`, async (route) => {
    const body = route.request().postDataJSON() as { text: string };
    return route.fulfill(json({ text: body.text, diagnostics: [] }));
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/modules/points`);
  await page.locator(".points-page-actions").getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name: "Als Timer anlegen" }).click();
  await expect(page).toHaveURL(`/channels/${CHANNEL_ID}/modules/timers`);

  const editor = page.locator(".timer-editor");
  const timerName = editor.getByRole("textbox", { name: "Name" });
  const message = editor.locator("textarea");
  await expect(timerName).toHaveValue("Spiele");
  await expect(message).toHaveValue("Spiel mit! Schreib !spiele, um verfügbare Spiele und deine Punkte zu sehen.");
  expect(createdInput).toBeNull();
  await editor.locator(".ui-save-bar__save").click();
  await expect.poll(() => createdInput).not.toBeNull();
  expect(createdInput).toMatchObject({
    name: "Spiele",
    messageText: "Spiel mit! Schreib !spiele, um verfügbare Spiele und deine Punkte zu sehen.",
  });
});
