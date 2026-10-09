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

const chooseOption = async (page: Page, label: string, option: string): Promise<void> => {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
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
    configured: false, updatedAt: null, mode: "on_demand", sample: null, errorCode: null, polling: false,
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

test("Belabox history keeps its latest twenty streams inside a bounded list", async ({ page }) => {
  const streams = Array.from({ length: 25 }, (_, index) => ({
    streamId: `stream-${String(index)}`,
    startedAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000).toISOString(),
    endedAt: null,
    samples: 1,
    bitrateAvg: 2_400,
    bitrateP10: 2_100,
    lowSeconds: 0,
    disconnectedSeconds: 0,
    disconnectCount: 0,
    droppedTotal: 0,
  }));
  await routeJson(page, "/api/channels/channel-a/modules/belabox/status", {
    configured: true, updatedAt: null, mode: "interval", sample: null, errorCode: null, polling: true,
    pollingDesired: true, streamId: "stream-24", belaboxStreamId: "stream-24",
  });
  await routeJson(page, "/api/channels/channel-a/modules/belabox/streams", streams);
  await routeJson(page, "/api/channels/channel-a/modules/belabox/history*", []);
  await gotoPanel(page, "belabox");

  const list = page.getByTestId("belabox-stream-history-list");
  await expect(list.locator("li")).toHaveCount(20);
  await expect.poll(() => list.evaluate((element) => ({
    maxHeight: getComputedStyle(element).maxHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrolls: element.scrollHeight > element.clientHeight,
  }))).toEqual({ maxHeight: "320px", overflowY: "auto", scrolls: true });
});

test("chat voting keeps configuration and action stable when results become live", async ({ page }) => {
  let vote: Record<string, unknown> | null = null;
  const defaults = {
    yes_no: ["Yes", "No"], digit_01: ["0", "1"], digit_12: ["1", "2"],
    scale_5: ["1", "2", "3", "4", "5"], options_n: ["1", "2"], free_text: [],
  };
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote === null ? null : [3, 1], revision: vote === null ? 1 : 2,
      hasOpenBallot: vote?.status === "open", defaultDurationSeconds: 60, defaultLabels: defaults,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    const requestBody = await route.request().postDataJSON() as { labels: string[] };
    expect(requestBody.labels).toEqual(["Yes", "No"]);
    vote = {
      id: "vote-a", channelId: "channel-a", preset: "yes_no", optionCount: 2, labels: requestBody.labels,
      status: "open", openedAt: "2030-01-01T12:00:00.000Z", closesAt: "2030-01-01T12:01:00.000Z",
      requestedDurationSeconds: 60, closedAt: null, closeReason: null, counts: [3, 1], voterCount: 4,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  await page.setViewportSize({ width: 1280, height: 844 });
  await gotoPanel(page, "chat_voting");
  const setup = page.locator(".chat-voting-setup");
  const result = page.locator(".chat-voting-result");
  const action = page.locator(".chat-voting-action");
  const hint = page.getByTestId("chat-voting-hint-slot");
  await expect(action).toBeEnabled();
  const setupBefore = await box(setup);
  const resultBefore = await box(result);
  const actionBefore = await box(action);
  const hintBefore = await box(hint);
  expect(setupBefore.x).toBeLessThan(resultBefore.x);
  expect(setupBefore.y).toBe(resultBefore.y);

  await action.click();
  await expect(page.getByRole("button", { name: "End vote" })).toBeVisible();
  await expect(page.locator(".chat-voting-results__row")).toHaveCount(2);
  expect(await box(setup)).toEqual(setupBefore);
  expect(await box(action)).toEqual(actionBefore);
  expect(await box(hint)).toEqual(hintBefore);
  expect((await box(result)).x).toBe(resultBefore.x);
  expect((await box(result)).y).toBe(resultBefore.y);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSetup = await box(setup);
  const mobileResult = await box(result);
  const mobileAction = await box(action);
  expect(mobileSetup.y).toBeLessThan(mobileResult.y);
  expect(mobileAction.y).toBeLessThan(mobileResult.y);
});

test("custom duration fits with its controls and unit at desktop and mobile widths", async ({ page }) => {
  const defaults = {
    yes_no: ["Yes", "No"], digit_01: ["0", "1"], digit_12: ["1", "2"],
    scale_5: ["1", "2", "3", "4", "5"], options_n: ["1", "2"], free_text: [],
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false,
    defaultDurationSeconds: 120, defaultLabels: defaults,
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "chat_voting");
    await chooseOption(page, "Duration", "Custom …");
    const seconds = page.getByRole("spinbutton", { name: "Seconds" });
    await seconds.fill("14400");
    const geometry = await seconds.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const stepper = element.closest(".ui-number-field__stepper") as HTMLElement;
      const unit = stepper.querySelector(".mantine-Input-section") as HTMLElement;
      const style = getComputedStyle(element);
      return {
        inputWidth: rect.width,
        contentWidth: rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
        stepperWidth: stepper.getBoundingClientRect().width,
        unitFits: unit.getBoundingClientRect().right <= stepper.getBoundingClientRect().right,
        value: (element as HTMLInputElement).value,
      };
    });
    expect(geometry.value).toBe("14400");
    expect(geometry.inputWidth).toBeGreaterThanOrEqual(128);
    expect(geometry.contentWidth).toBeGreaterThanOrEqual(50);
    expect(geometry.stepperWidth).toBeGreaterThanOrEqual(220);
    expect(geometry.unitFits).toBe(true);
    const label = page.getByRole("textbox", { name: "Label for option 1" });
    await expect(label).toHaveAttribute("aria-label", "Label for option 1");
    await expect(page.locator(".chat-voting-labels .mantine-InputWrapper-label")).toHaveCount(0);
  }
});

test("a timer-closed vote becomes the next draft without changing its configuration", async ({ page }) => {
  const defaults = {
    yes_no: ["Yes", "No"], digit_01: ["0", "1"], digit_12: ["1", "2"],
    scale_5: ["1", "2", "3", "4", "5"], options_n: Array.from({ length: 9 }, (_, index) => String(index + 1)), free_text: [],
  };
  let vote: Record<string, unknown> | null = null;
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    const counts = vote?.preset === "options_n" ? Array<number>(9).fill(0) : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts, revision: vote?.status === "open" ? 2 : 1, terms: null, moreTerms: null,
      hasOpenBallot: vote?.status === "open", defaultDurationSeconds: 120, defaultLabels: defaults,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    const body = await route.request().postDataJSON() as { preset: string; optionCount: number; durationSeconds: number; labels: string[] };
    expect(body).toMatchObject({ preset: "options_n", optionCount: 9, durationSeconds: 90 });
    vote = {
      id: "timer-vote", channelId: "channel-a", preset: body.preset, optionCount: body.optionCount, labels: body.labels,
      status: "open", openedAt: "2030-01-01T12:00:00.000Z", closesAt: "2030-01-01T12:01:30.000Z",
      requestedDurationSeconds: body.durationSeconds, closedAt: null, closeReason: null, counts: Array<number>(9).fill(0), voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting");

  await chooseOption(page, "Vote type", "Options 2–9");
  await page.getByRole("spinbutton", { name: "Number of options" }).fill("9");
  await chooseOption(page, "Duration", "Custom …");
  await page.getByRole("spinbutton", { name: "Seconds" }).fill("90");
  const setup = page.locator(".chat-voting-setup");
  const action = page.locator(".chat-voting-action");

  await page.getByRole("button", { name: "Start vote" }).click();
  await expect(page.getByRole("button", { name: "End vote" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Number of options" })).toHaveValue("9");
  await expect(page.getByRole("spinbutton", { name: "Seconds" })).toHaveValue("90");
  const setupWhileRunningBefore = await box(setup);
  const actionWhileRunningBefore = await box(action);
  vote = { ...(vote as unknown as Record<string, unknown>), status: "closed", closedAt: "2030-01-01T12:01:30.000Z" };

  await expect(page.getByTestId("chat-voting-header-status")).toContainText("Closed", { timeout: 5_000 });
  await expect(page.getByRole("combobox", { name: "Vote type" })).toHaveValue("Options 2–9");
  await expect(page.getByRole("spinbutton", { name: "Number of options" })).toHaveValue("9");
  await expect(page.getByRole("combobox", { name: "Duration" })).toHaveValue("Custom …");
  await expect(page.getByRole("spinbutton", { name: "Seconds" })).toHaveValue("90");
  await expect(page.getByRole("button", { name: "Start vote" })).toBeEnabled();
  expect(await box(setup)).toEqual(setupWhileRunningBefore);
  expect(await box(action)).toEqual(actionWhileRunningBefore);
  const metadata = page.locator(".chat-voting-result__meta");
  const [startTime, endTime] = await page.evaluate(() => [
    new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date("2030-01-01T12:00:00.000Z")),
    new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date("2030-01-01T12:01:30.000Z")),
  ]);
  await expect(metadata).toContainText(startTime);
  await expect(metadata).toContainText(endTime);
  await expect(metadata).not.toContainText("/");
  expect(await metadata.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("free-text voting always renders five fixed result rows at desktop and mobile widths", async ({ page }) => {
  const longTerm = "0123456789012345678901234";
  const terms = [
    { term: longTerm, count: 2, approved: false },
    { term: "second", count: 1, approved: false },
  ];
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
      moreTerms: 0, termFilterReady: true, hasOpenBallot: true, defaultDurationSeconds: 60,
      defaultLabels: { yes_no: ["Yes", "No"], digit_01: ["0", "1"], digit_12: ["1", "2"], scale_5: ["1", "2", "3", "4", "5"], options_n: ["1", "2"], free_text: [] },
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/approve-term", async (route) => {
    const requestBody = await route.request().postDataJSON() as { pollId: string; term: string };
    expect(requestBody.pollId).toBe(vote.id);
    approvedTerm = requestBody.term;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ terms, moreTerms: 0, revision: 2 }) });
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  for (const width of [1280, 390]) {
    approvedTerm = null;
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "chat_voting");
    const rows = page.locator(".chat-voting-results__term-row");
    await expect(rows).toHaveCount(5);
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))).toEqual(Array<number>(5).fill(34));
    const fullLabel = rows.first().locator(".chat-voting-results__label");
    await expect(fullLabel).toHaveAttribute("title", longTerm);
    expect(await fullLabel.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    if (width === 390) expect(await fullLabel.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const setup = page.locator(".chat-voting-setup");
    const result = page.locator(".chat-voting-result");
    const action = page.getByRole("button", { name: "End vote" });
    const setupBefore = await box(setup);
    const resultBefore = await box(result);
    const actionBefore = await box(action);
    if (width === 1280) {
      expect(setupBefore.x).toBeLessThan(resultBefore.x);
      expect(setupBefore.y).toBe(resultBefore.y);
    } else {
      expect(setupBefore.y).toBeLessThan(resultBefore.y);
      expect(actionBefore.y).toBeLessThan(resultBefore.y);
    }
    await expect(rows.filter({ hasText: "—" })).toHaveCount(3);
    await page.locator(".chat-voting-results__term-row button").first().click();
    await expect(rows).toHaveCount(5);
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    expect(await box(setup)).toEqual(setupBefore);
    expect(await box(action)).toEqual(actionBefore);
    if (width === 1280) expect(await box(result)).toEqual(resultBefore);
    else expect((await box(result)).y).toBeGreaterThan((await box(action)).y);
  }
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

test("an overnight chat voting result keeps its closing time fully visible at 390px", async ({ page }) => {
  const defaults = {
    yes_no: ["Yes", "No"], digit_01: ["0", "1"], digit_12: ["1", "2"],
    scale_5: ["1", "2", "3", "4", "5"], options_n: ["1", "2"], free_text: [],
  };
  const vote = {
    id: "night-vote", channelId: "channel-a", preset: "yes_no", optionCount: 2, labels: ["Yes", "No"],
    status: "closed", openedAt: new Date(2030, 9, 6, 23, 50).toISOString(), closesAt: new Date(2030, 9, 7, 0, 10).toISOString(),
    requestedDurationSeconds: 1200, closedAt: new Date(2030, 9, 7, 0, 10).toISOString(), closeReason: "timer", counts: [3, 1], voterCount: 4,
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote, counts: [3, 1], revision: 2, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60, defaultLabels: defaults,
  });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting");

  const meta = page.locator(".chat-voting-result__meta");
  await expect(meta).toContainText("(+1)");
  const clipped = await meta.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped).toBe(false);
});

test("text-library game filter keeps the list position when games are selected and removed at desktop and 390px", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/text_library/library", {
    blocks: [], categories: [], settings: { revision: 1, graphRevision: 1, updatedAt: "2026-09-20T08:00:00.000Z" }, usages: {},
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await routeJson(page, "/api/channels/channel-a/settings", { timeZone: "UTC", revision: 1 });
  await page.route("**/api/channels/channel-a/games?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ games: [
      { id: "1", name: "Just Chatting" }, { id: "2", name: "Software and Game Development" }, { id: "3", name: "Retro Adventure Collection Deluxe" },
    ] }) });
  });

  for (const width of [1280, 700, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "text_library");
    const list = page.getByTestId("text-library-list-slot");
    await expect(list).toBeVisible();
    const toolbar = page.locator(".text-library__list-toolbar");
    const filters = toolbar.locator(".list-toolbar__filters");
    const create = toolbar.getByRole("button", { name: "Add text block" });
    const picker = filters.locator(".ui-game-picker--compact");
    const slot = picker.locator(".ui-game-picker__selected");
    const pickerBox = await picker.boundingBox();
    const filtersBox = await filters.boundingBox();
    const createBox = await create.boundingBox();
    expect(pickerBox?.height).toBeLessThanOrEqual(44);
    expect(pickerBox?.y ?? 0).toBeGreaterThanOrEqual(filtersBox?.y ?? 0);
    expect((pickerBox?.y ?? 0) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual((filtersBox?.y ?? 0) + (filtersBox?.height ?? 0) + 0.5);
    expect(createBox?.x ?? 0).toBeGreaterThanOrEqual((filtersBox?.x ?? 0) + (filtersBox?.width ?? 0) - 0.5);
    if (width === 700) {
      const filterOverflow = await filters.evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(filterOverflow).toBe(true);
    }
    const before = { list: await box(list), slot: await box(slot) };
    const search = page.getByPlaceholder("Search games");
    for (const name of ["Just Chatting", "Software and Game Development", "Retro Adventure Collection Deluxe"]) {
      await search.fill("ga");
      await page.getByRole("option", { name }).click();
      expect(await box(list)).toEqual(before.list);
      expect(await box(slot)).toEqual(before.slot);
    }
    if (width === 390) {
      const activeFilters = toolbar.locator(".list-toolbar__active-filters");
      await expect(activeFilters).toContainText("Just Chatting");
      await expect(activeFilters).toContainText("Software and Game Development");
      await expect(activeFilters).toContainText("Retro Adventure Collection Deluxe");
      await page.getByRole("button", { name: "Reset" }).click();
    }
    else await page.getByRole("button", { name: "Clear game filter (3 selected)" }).click();
    expect(await box(list)).toEqual(before.list);
    expect(await box(slot)).toEqual(before.slot);
  }
});

test("text-library inspector stays at its sticky offset while the page scrolls at desktop width", async ({ page }) => {
  const blocks = Array.from({ length: 40 }, (_, index) => ({
    name: `block_${String(index + 1)}`,
    categoryId: "social",
    games: [],
    variants: [{ id: `variant_${String(index + 1)}`, conditions: {}, texts: ["Hello"] }],
    revision: 1,
  }));
  const categories = [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];
  await routeJson(page, "/api/channels/channel-a/modules/text_library/library", {
    blocks, categories, settings: { revision: 1, graphRevision: 1, updatedAt: "2026-09-20T08:00:00.000Z" }, usages: {}, reservedNames: [],
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await routeJson(page, "/api/channels/channel-a/settings", { timeZone: "UTC", revision: 1 });

  await page.setViewportSize({ width: 1400, height: 800 });
  await gotoPanel(page, "text_library");
  await page.getByRole("button", { name: "{block_1}" }).click();
  const inspector = page.locator(".list-detail__inspector");
  await expect(inspector).toBeVisible();
  await page.evaluate(() => { window.scrollTo(0, 100); });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(100);
  const top = await inspector.evaluate((element) => element.getBoundingClientRect().top);
  expect(top).toBe(16);
});
