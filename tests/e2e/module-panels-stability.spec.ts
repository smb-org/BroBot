import { expect, test, type Locator, type Page } from "@playwright/test";

const routeJson = async (page: Page, path: string, value: unknown, method?: string): Promise<void> => {
  await page.route(`**${path}`, async (route) => {
    if (method !== undefined && route.request().method() !== method) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
};

const box = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const value = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let scrollX = window.scrollX;
    let scrollY = window.scrollY;
    let ancestor = element.parentElement;
    while (ancestor !== null) {
      scrollX += ancestor.scrollLeft;
      scrollY += ancestor.scrollTop;
      ancestor = ancestor.parentElement;
    }
    return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  });
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Math.round(number * 100) / 100])) as {
    x: number; y: number; width: number; height: number;
  };
};

const gotoPanel = async (page: Page, panel: string): Promise<void> => {
  await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}`);
};

test("API source editor and expression hint keep their boxes stable", async ({ page }) => {
  const sources = Array.from({ length: 8 }, (_, index) => ({
    name: `source_${String(index)}`,
    url: `https://example.com/${String(index)}`,
    expression: "$.status",
    revision: 1,
    updatedAt: "2030-01-01T12:00:00.000Z",
  }));
  await routeJson(page, "/api/channels/channel-a/modules/api_source/sources", { sources });
  await gotoPanel(page, "api_source");
  const panel = page.locator(".api-source-panel");
  await expect(page.getByRole("button", { name: "Add source" })).toBeVisible();
  const listSlot = page.getByTestId("api-source-list-slot");
  const listBefore = await box(listSlot);
  expect(await listSlot.locator(".api-source-panel__list").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const panelBefore = await box(panel);

  await page.getByRole("button", { name: "Add source" }).click();
  const dialog = page.getByRole("dialog", { name: "Create source" });
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
  });
  const dialogBefore = await box(dialog);
  const expression = page.getByRole("textbox", { name: "JSONata expression (optional)" });
  await expect(expression).toBeVisible();
  await expression.fill("$.status");
  const dialogAfter = await box(dialog);
  expect(await box(listSlot)).toEqual(listBefore);
  expect(await box(panel)).toEqual(panelBefore);
  expect(dialogAfter).toEqual(dialogBefore);
});

test("Belabox test results stay inside the reserved result box", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/belabox/status", {
    configured: false, updatedAt: null, sample: null, errorCode: null, polling: false,
    pollingDesired: false, streamId: null, belaboxStreamId: null,
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/belabox/test", { ok: true, connected: true, bitrateKbps: 4200 }, "POST");
  await gotoPanel(page, "belabox");
  const button = page.getByRole("button", { name: "Test connection" });
  await expect(button).toBeVisible();
  const buttonBefore = await box(button);
  const resultSlot = page.getByTestId("belabox-test-result-slot");
  const resultBefore = await box(resultSlot);

  await button.click();
  await expect(resultSlot).toContainText("Connected");
  expect(await box(button)).toEqual(buttonBefore);
  expect(await box(resultSlot)).toEqual(resultBefore);
});

test("chat voting header status keeps its box when a live end time appears", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let vote: unknown = null;
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote === null ? null : [0, 0], revision: 1, hasOpenBallot: false, defaultDurationSeconds: 60,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    vote = {
      id: "vote-a", channelId: "channel-a", preset: "yes_no", optionCount: 2, labels: ["Yes", "No"],
      status: "open", openedAt: "2030-01-01T12:00:00.000Z", closesAt: "2030-01-01T12:01:00.000Z",
      requestedDurationSeconds: 60, closedAt: null, closeReason: "manual", counts: [0, 0], voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await gotoPanel(page, "chat_voting");
  const status = page.getByTestId("chat-voting-header-status");
  const detail = page.getByTestId("chat-voting-header-detail");
  const resultArea = page.locator(".chat-voting-result-area");
  const hintSlot = page.getByTestId("chat-voting-hint-slot");
  const actions = page.locator(".chat-voting-actions");
  await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();
  const statusBefore = await box(status);
  const headingBefore = await box(page.locator(".chat-voting-panel .section-heading"));
  const resultAreaBefore = await box(resultArea);
  const hintSlotBefore = await box(hintSlot);
  const actionsBefore = await box(actions);
  expect(statusBefore.width).toBeLessThanOrEqual(240);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(detail).toContainText("ends");
  await expect(actions.locator("button")).toBeVisible();
  expect(await box(status)).toEqual(statusBefore);
  expect(await box(page.locator(".chat-voting-panel .section-heading"))).toEqual(headingBefore);
  expect(await box(resultArea)).toEqual(resultAreaBefore);
  expect(await box(hintSlot)).toEqual(hintSlotBefore);
  expect(await box(actions)).toEqual(actionsBefore);
});

test("text command slash help and variable action keep editor boxes stable", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", {
    commands: [], variables: [{ name: "score", value: 1, description: "Points" }],
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await gotoPanel(page, "text_commands");
  await page.getByRole("button", { name: "Add command" }).click();
  const editor = page.locator(".command-editor-shell");
  const response = page.getByRole("textbox", { name: "Response" });
  await expect(response).toBeVisible();
  const slashHelp = page.locator(".command-slash-help");
  const slashBefore = await box(slashHelp);
  const editorBeforeSlash = await box(editor);

  await response.fill("/t");
  await expect(slashHelp).toContainText("Leading Twitch-style commands");
  expect(await box(slashHelp)).toEqual(slashBefore);
  expect(await box(editor)).toEqual(editorBeforeSlash);

  const actionSlot = page.getByTestId("command-variable-action-slot");
  const actionBefore = await box(actionSlot);
  const editorBeforeAction = await box(editor);
  await page.getByRole("switch", { name: "Change channel variable" }).click();
  await expect(actionSlot.locator("#command-variable-name")).toBeVisible();
  expect(await box(actionSlot)).toEqual(actionBefore);
  expect(await box(editor)).toEqual(editorBeforeAction);
});
