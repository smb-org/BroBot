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

test("API source list keeps its final populated row reachable at desktop and mobile widths", async ({ page }) => {
  const sources = Array.from({ length: 8 }, (_, index) => ({
    name: `source_${String(index)}`,
    url: `https://example.com/${String(index)}`,
    expression: "$.status",
    revision: 1,
    updatedAt: "2030-01-01T12:00:00.000Z",
  }));
  await routeJson(page, "/api/channels/channel-a/modules/api_source/sources", { sources });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "api_source");
    const list = page.getByTestId("api-source-list-slot").locator(".api-source-panel__list");
    await expect(list.locator("li")).toHaveCount(sources.length);
    const lastRow = await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      const lastButton = element.querySelector("li:last-child button");
      if (!(lastButton instanceof HTMLElement)) throw new Error("The last source button is missing.");
      const listBounds = element.getBoundingClientRect();
      const buttonBounds = lastButton.getBoundingClientRect();
      return { listBottom: listBounds.bottom, buttonBottom: buttonBounds.bottom, scrollable: element.scrollHeight > element.clientHeight };
    });
    expect(lastRow.scrollable).toBe(true);
    expect(lastRow.buttonBottom).toBeLessThanOrEqual(lastRow.listBottom + 0.5);
  }
});

test("text-library picker space is reserved until populated variables arrive", async ({ page }) => {
  let signalRequest: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
  let releaseResponse: () => void = () => undefined;
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", { commands: [], variables: [] });
  await page.route("**/api/channels/channel-a/template-variables", async (route) => {
    signalRequest();
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [
      { name: "welcome", moduleId: "text_library", isTextBlock: true },
    ] }) });
  });

  await page.setViewportSize({ width: 1280, height: 844 });
  await gotoPanel(page, "text_commands");
  await page.getByRole("button", { name: "Add command" }).click();
  await requestStarted;
  const response = page.getByRole("textbox", { name: "Response" });
  await expect(response).toBeVisible();
  const editor = page.locator(".command-template-editor").first();
  const pickerSlot = page.getByTestId("command-library-picker-slot").first();
  const desktopBefore = { editor: await box(editor), slot: await box(pickerSlot) };

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBefore = { editor: await box(editor), slot: await box(pickerSlot) };
  releaseResponse();
  await expect(page.getByRole("combobox", { name: "Text from library" }).first()).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 844 });
  expect({ editor: await box(editor), slot: await box(pickerSlot) }).toEqual(desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  expect({ editor: await box(editor), slot: await box(pickerSlot) }).toEqual(mobileBefore);
});

test("votekick loading sections reserve their populated structure", async ({ page }) => {
  const running = {
    id: "running-a", targetUserId: "target-a", targetLogin: "sampleviewer", initiatorUserId: "starter-a",
    status: "running", threshold: 3, yesVotes: 1, noVotes: 0, ballotRevision: 1, durationSeconds: null,
    startedAt: "2030-01-01T12:00:00.000Z", endsAt: "2030-01-01T12:01:00.000Z", endedAt: null, liftedAt: null,
  };
  const history = Array.from({ length: 8 }, (_, index) => ({
    ...running,
    id: `history-${String(index)}`,
    targetLogin: `viewer_${String(index)}`,
    status: "expired",
    startedAt: `2030-01-0${String(index + 1)}T12:00:00.000Z`,
    endedAt: `2030-01-0${String(index + 1)}T12:01:00.000Z`,
    durationSeconds: 60,
  }));
  let signalRequest: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
  let releaseResponse: () => void = () => undefined;
  await page.route("**/api/channels/channel-a/modules/votekick/votekicks", async (route) => {
    signalRequest();
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ running, votekicks: [running, ...history], now: "2030-01-01T12:00:30.000Z" }) });
  });

  await page.setViewportSize({ width: 1280, height: 844 });
  await gotoPanel(page, "votekick");
  await requestStarted;
  const content = page.getByTestId("votekick-reserved-content");
  const desktopBefore = await box(content);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBefore = await box(content);
  releaseResponse();
  await expect(content).toContainText("viewer_7");

  await page.setViewportSize({ width: 1280, height: 844 });
  expect(await box(content)).toEqual(desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await box(content)).toEqual(mobileBefore);
});

test("timer and FAQ dialogs submit from Enter", async ({ page }) => {
  const variables = { variables: [{ name: "greeting", moduleId: "text_library", isTextBlock: true }] };
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/template-variables", variables);

  let timerCreated = false;
  await page.route("**/api/channels/channel-a/modules/timers/timers", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timers: [] }) });
    timerCreated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timer: {
      id: "timer-created", name: "Hourly", enabled: true, blockName: "greeting", chatTarget: "source_only",
      trigger: { type: "interval", minutes: 30 }, revision: 1, nextRunAt: null, nextRunStreamId: null,
      lastRunAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
    } }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/timers/event-time-sources", { sources: [] });
  await gotoPanel(page, "timers");
  await page.getByRole("button", { name: "Create timer" }).click();
  const timerDialog = page.getByRole("dialog", { name: "Create" });
  await timerDialog.getByRole("textbox", { name: "Name" }).fill("Hourly");
  await timerDialog.getByRole("combobox", { name: "Text block" }).click();
  await page.getByRole("option", { name: "greeting" }).click();
  await expect(timerDialog.locator("form")).toBeAttached();
  await timerDialog.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect.poll(() => timerCreated).toBe(true);

  let faqCreated = false;
  await page.route("**/api/channels/channel-a/modules/faq/entries", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
    faqCreated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entry: {
      id: "faq-created", name: "Greeting", enabled: true, matcher: { type: "keywords", patterns: ["hello"] },
      answerBlock: "greeting", cooldownSeconds: 30, games: [], chatTarget: "source_only", order: 0, revision: 1,
      lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
    } }) });
  });
  await gotoPanel(page, "faq");
  await page.getByRole("button", { name: "Create FAQ entry" }).click();
  const faqDialog = page.getByRole("dialog", { name: "Create entry" });
  await faqDialog.getByRole("textbox", { name: "Name" }).fill("Greeting");
  await faqDialog.getByRole("textbox", { name: "Keywords and phrases" }).fill("hello");
  await faqDialog.getByRole("combobox", { name: "Answer text block" }).click();
  await page.getByRole("option", { name: "greeting" }).click();
  await expect(faqDialog.locator("form")).toBeAttached();
  await faqDialog.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect.poll(() => faqCreated).toBe(true);
});

test("BELABOX immediate action keeps manual results separate from live notices", async ({ page }) => {
  const connectedStatus = {
    configured: true, updatedAt: "2030-01-01T12:00:00.000Z",
    sample: { at: "2030-01-01T12:00:00.000Z", connected: true, bitrateKbps: 3200, rttMs: 41, latencyMs: 115, network: 2, droppedPackets: 0 },
    errorCode: null, polling: true, pollingDesired: true, streamId: "stream-a", belaboxStreamId: "stream-a",
    alertNotice: null, fetchFailureNotice: false, intervalSeconds: 5,
  };
  const disconnectedStatus = {
    ...connectedStatus,
    sample: { ...connectedStatus.sample, connected: false, bitrateKbps: 0 },
    alertNotice: { phase: "alarm", kind: "disconnect", bitrateKbps: 0 },
  };
  let statusCalls = 0;
  await page.route("**/api/channels/channel-a/modules/belabox/status", async (route) => {
    statusCalls += 1;
    const value = statusCalls >= 3 ? disconnectedStatus : connectedStatus;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/belabox/test", { ok: true, connected: true, bitrateKbps: 4200 }, "POST");
  await gotoPanel(page, "belabox-action");

  const notice = page.getByTestId("belabox-immediate-status-slot");
  const result = page.getByTestId("immediate-action-result-slot");
  const button = page.getByRole("button", { name: "Check now" });
  await expect(notice).toContainText("Connected");
  const layoutBefore = { notice: await box(notice), result: await box(result), button: await box(button) };

  await button.click();
  await expect(result).toContainText("4200 kbps");
  await expect(notice).toContainText("Connected");
  expect({ notice: await box(notice), result: await box(result), button: await box(button) }).toEqual(layoutBefore);

  await expect(notice).toContainText(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u, { timeout: 10_000 });
  await expect(result).toBeEmpty();
  expect({ notice: await box(notice), result: await box(result), button: await box(button) }).toEqual(layoutBefore);
});

test("Belabox test results stay inside the reserved result box", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/belabox/status", {
    configured: false, updatedAt: null, sample: null, errorCode: null, polling: false,
    pollingDesired: false, streamId: null, belaboxStreamId: null, alertNotice: null,
    fetchFailureNotice: false, intervalSeconds: 15,
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
  await page.evaluate(() => { window.scrollTo(0, 0); });
  expect(await box(status)).toEqual(statusBefore);
  expect(await box(page.locator(".chat-voting-panel .section-heading"))).toEqual(headingBefore);
  expect(await box(resultArea)).toEqual(resultAreaBefore);
  expect(await box(hintSlot)).toEqual(hintSlotBefore);
  expect(await box(actions)).toEqual(actionsBefore);
});

test("free-text voting results and approval keep the panel layout fixed", async ({ page }) => {
  const terms = Array.from({ length: 200 }, (_, index) => ({
    term: `term-${String(index).padStart(3, "0")}`,
    count: index % 10 + 1,
    approved: false,
  }));
  let approvedTerm: string | null = null;
  const vote = {
    id: "text-vote-a", channelId: "channel-a", preset: "free_text", optionCount: 0, labels: [],
    textMode: "first_word", termFilterReady: true,
    status: "open", openedAt: "2030-01-01T12:00:00.000Z", closesAt: "2030-01-01T12:01:00.000Z",
    requestedDurationSeconds: 60, closedAt: null, closeReason: "timer", counts: [], voterCount: null,
    textResults: null, moreTerms: null,
  };
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    const currentTerms = terms.map((entry) => ({ ...entry, approved: entry.term === approvedTerm }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: [], revision: approvedTerm === null ? 1 : 2, terms: currentTerms,
      moreTerms: 3, termFilterReady: true, hasOpenBallot: true, defaultDurationSeconds: 60,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/approve-term", async (route) => {
    const requestBody = await route.request().postDataJSON() as { pollId: string; term: string };
    expect(requestBody.pollId).toBe(vote.id);
    approvedTerm = requestBody.term;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ terms, moreTerms: 3, revision: 2 }) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  const boxesAtWidth = async (): Promise<Record<string, { x: number; y: number; width: number; height: number }>> => ({
    panel: await box(page.locator(".chat-voting-panel")),
    result: await box(page.locator(".chat-voting-result-area")),
    configuration: await box(page.locator(".chat-voting-configuration")),
    modeSlot: await box(page.getByTestId("chat-voting-text-mode-slot")),
    hint: await box(page.getByTestId("chat-voting-hint-slot")),
    actions: await box(page.locator(".chat-voting-actions")),
  });

  await page.setViewportSize({ width: 1280, height: 844 });
  await gotoPanel(page, "chat_voting");
  const rows = page.locator(".chat-voting-results__term-row");
  await expect(rows).toHaveCount(200);
  const scrollable = await page.locator(".chat-voting-result-area").evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrollable).toBe(true);
  const desktopBefore = await boxesAtWidth();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBefore = await boxesAtWidth();
  await page.locator(".chat-voting-results__term-row button").first().click();
  await expect(page.locator(".chat-voting-results__term-row button")).toHaveCount(199);

  await page.setViewportSize({ width: 1280, height: 844 });
  expect(await boxesAtWidth()).toEqual(desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await boxesAtWidth()).toEqual(mobileBefore);
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
