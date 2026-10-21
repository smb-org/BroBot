import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "api-source-json-path-picker";
const modules = [
  { id: "api_source", enabled: true, settings: "{}", mandatory: false },
];
const channel = {
  channelId,
  login: "json-path-picker",
  displayName: "JSON Path Picker",
  language: "en",
  role: "manager",
  streamState: "offline",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-01T12:00:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-01T12:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "json-path-picker-subscription", reason: null, updatedAt: "2026-10-01T12:00:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
  modules,
};

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const installApiMocks = async (page: Page, sample: unknown, valueForExpression: (expression: string) => string) => {
  const testedExpressions: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot, platformAdmin: false }));
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({ ...channel, activeModules: [{ moduleId: "api_source", settings: "{}" }] }));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === `/api/channels/${channelId}/modules/api_source/sources` && method === "GET") return route.fulfill(json({ sources: [] }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "api-source-json-path-picker-csrf" }));
    if (pathname === `/api/channels/${channelId}/modules/api_source/sources/test` && method === "POST") {
      const body = request.postDataJSON() as { expression?: unknown };
      const expression = typeof body.expression === "string" ? body.expression : "";
      testedExpressions.push(expression);
      return route.fulfill(json({ status: "ok", httpStatus: 200, bytes: 128, json: sample, value: valueForExpression(expression) }));
    }
    return route.fulfill(json({}, 404));
  });
  return { testedExpressions };
};

const openTestStep = async (page: Page, expression: string): Promise<void> => {
  await page.goto(`/channels/${channelId}/modules/api_source?lang=en`);
  await page.getByRole("button", { name: "Create source" }).click();
  const dialog = page.getByRole("dialog", { name: "Create data source" });
  await dialog.getByRole("textbox", { name: "Web address" }).fill("https://api.example.test/weather");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("textbox", { name: "Value from the response" }).fill(expression);
  await dialog.getByRole("button", { name: "Continue" }).click();
};

test("shows the response picker in the create step at desktop and 390px widths", async ({ page }, testInfo) => {
  mkdirSync("test-results/issue-508-api-source", { recursive: true });
  const sample = { weather: { status: "sunny" }, daily: { sunrise: "06:18" }, temperature: 21 };

  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await installApiMocks(page, sample, () => "06:18");
    await openTestStep(page, "$.daily.sunrise");

    const dialog = page.getByRole("dialog", { name: "Create data source" });
    await dialog.getByRole("button", { name: "Test" }).click();
    await expect(dialog.getByRole("tree", { name: "Sample response as a JSON tree" })).toBeVisible();
    await expect(dialog.getByRole("treeitem", { name: /sunrise.*String.*06:18/u })).toBeVisible();
    await page.screenshot({
      path: `test-results/issue-508-api-source/create-step-${String(width)}px-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: false,
    });
    await page.unrouteAll();
  }
});

test("selecting a response leaf replaces the expression and re-testing returns its value", async ({ page }) => {
  const api = await installApiMocks(page, { weather: { temperature: 21, status: "sunny" } }, (expression) =>
    expression === "$.weather.temperature" ? "21" : "previous value");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openTestStep(page, "$.old.path");

  const dialog = page.getByRole("dialog", { name: "Create data source" });
  await dialog.getByRole("button", { name: "Test" }).click();
  await dialog.getByRole("treeitem", { name: /temperature.*Number.*21/u }).click();
  await expect(dialog.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.weather.temperature");
  await expect(dialog.getByRole("treeitem", { name: /status.*String.*sunny/u })).toBeVisible();
  await expect(dialog.getByText("Needs re-test")).toBeVisible();
  await dialog.getByRole("button", { name: "Test" }).click();

  await expect(dialog.locator(".api-source-panel__test-result-value code")).toHaveText("21");
  expect(api.testedExpressions).toEqual(["$.old.path", "$.weather.temperature"]);
});

test("expanding tree nodes leaves the dialog and content below the tree in place", async ({ page }) => {
  await installApiMocks(page, { weather: { daily: { sunrise: "06:18" } } }, () => "06:18");
  await page.setViewportSize({ width: 390, height: 844 });
  await openTestStep(page, "$.weather.daily.sunrise");

  const dialog = page.getByRole("dialog", { name: "Create data source" });
  await dialog.getByRole("button", { name: "Test" }).click();
  const dialogBounds = await dialog.boundingBox();
  const valueBounds = await dialog.locator(".api-source-panel__test-result-value").boundingBox();
  const daily = dialog.getByRole("treeitem", { name: /daily.*Object/u });
  await expect(daily).toHaveAttribute("aria-expanded", "false");
  await daily.locator(":scope > .api-source-json-tree__item").click();
  await expect(dialog.getByRole("treeitem", { name: /sunrise/u })).toBeVisible();

  expect(await dialog.boundingBox()).toEqual(dialogBounds);
  expect(await dialog.locator(".api-source-panel__test-result-value").boundingBox()).toEqual(valueBounds);
});

test("a 24-level response keeps keys, disclosures and leaves visible and clickable at 390px", async ({ page }) => {
  const levels = 24;
  let sample: unknown = { leaf: "end" };
  for (let level = 0; level < levels; level += 1) sample = { a: sample };
  await installApiMocks(page, sample, () => "end");
  await page.setViewportSize({ width: 390, height: 844 });
  await openTestStep(page, "$.old.path");

  const dialog = page.getByRole("dialog", { name: "Create data source" });
  await dialog.getByRole("button", { name: "Test" }).click();
  const tree = dialog.getByRole("tree", { name: "Sample response as a JSON tree" });
  await dialog.getByRole("treeitem", { name: /^Sample response · JSON, Object/u }).focus();
  for (let press = 0; press < levels * 3; press += 1) await page.keyboard.press("ArrowRight");

  const leaf = dialog.getByRole("treeitem", { name: /^leaf, String/u });
  await expect(leaf).toBeFocused();
  const deepestBranch = dialog.getByRole("treeitem", { name: /^a, Object/u }).last();
  const treeBox = await tree.boundingBox();
  expect(treeBox).not.toBeNull();
  if (treeBox === null) return;
  for (const part of [
    deepestBranch.locator(":scope > .api-source-json-tree__item .api-source-json-tree__disclosure"),
    deepestBranch.locator(":scope > .api-source-json-tree__item .api-source-json-tree__key"),
    leaf.locator(":scope > .api-source-json-tree__item .api-source-json-tree__key"),
    leaf.locator(":scope > .api-source-json-tree__item .api-source-json-tree__value"),
  ]) {
    const box = await part.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) continue;
    expect(box.width).toBeGreaterThan(8);
    expect(box.x).toBeGreaterThanOrEqual(treeBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(treeBox.x + treeBox.width);
    expect(box.y).toBeGreaterThanOrEqual(treeBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(treeBox.y + treeBox.height);
  }

  await leaf.locator(":scope > .api-source-json-tree__item").click();
  await expect(dialog.getByRole("textbox", { name: "Value from the response" })).toHaveValue(`$${".a".repeat(levels)}.leaf`);
});
