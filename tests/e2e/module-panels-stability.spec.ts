import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

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
      if (ancestor !== document.body && ancestor !== document.documentElement) {
        scrollX += ancestor.scrollLeft;
        scrollY += ancestor.scrollTop;
      }
      ancestor = ancestor.parentElement;
    }
    return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  });
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Math.round(number * 100) / 100])) as {
    x: number; y: number; width: number; height: number;
  };
};

const gotoPanel = async (page: Page, panel: string, language?: "de" | "en"): Promise<void> => {
  const languageQuery = language === undefined ? "" : `&lang=${language}`;
  await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}${languageQuery}`);
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

test("saved chat voting keeps its live action, play slot, and list stable through edits", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  let template: ChatVoteTemplate = {
    id: "template-dinner", channelId: "channel-a", shortcut: "dinner", title: "Dinner",
    labels: ["Pizza", "Pasta"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let vote: Record<string, unknown> | null = {
    id: "vote-previous", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Yes", "No"],
    title: "Previous vote", status: "closed", openedAt: "2030-01-01T11:58:00.000Z", closesAt: "2030-01-01T11:59:00.000Z",
    requestedDurationSeconds: 60, closedAt: "2030-01-01T11:59:00.000Z", closeReason: "manual", counts: [2, 1], voterCount: 3,
  };
  let failNextSave = false;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote === null ? null : vote.counts, revision: vote === null ? 1 : 2,
      terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates: [template], count: 1, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      if (failNextSave) {
        failNextSave = false;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error" }) });
        return;
      }
      const draft = await route.request().postDataJSON() as Partial<ChatVoteTemplate>;
      template = { ...template, ...draft, revision: template.revision + 1, updatedAt: "2030-01-01T12:01:00.000Z" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    const body = await route.request().postDataJSON() as { templateId: string };
    expect(body.templateId).toBe(template.id);
    vote = {
      id: "vote-a", channelId: "channel-a", kind: "options", optionCount: template.labels.length,
      labels: [...template.labels], title: template.title, status: "open", openedAt: "2030-01-01T12:01:00.000Z",
      closesAt: "2030-01-01T12:02:00.000Z", requestedDurationSeconds: 60, closedAt: null,
      closeReason: null, counts: Array<number>(template.labels.length).fill(0), voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/close", async (route) => {
    vote = { ...(vote ?? {}), status: "closed", closedAt: "2030-01-01T12:02:00.000Z", closeReason: "manual" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ closing: true, pollId: "vote-a" }) });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting");
  const live = page.locator(".chat-voting-live");
  const list = page.locator(".chat-voting-list");
  const row = page.locator(".chat-voting-template-list .list-row").first();
  const geometry = async () => ({
    live: await box(live),
    action: await box(live.locator(".chat-voting-live__action-slot")),
    list: await box(list),
    playSlot: await box(row.locator(".list-row__action")),
  });
  await expect(page.locator(".chat-voting-template-list .list-row__action button")).toBeEnabled();
  const baseline = await geometry();
  expect(baseline.action.width).toBe(88);
  expect(baseline.playSlot.width).toBe(36);

  await page.locator(".chat-voting-template-list .list-row__action button").click();
  await expect(page.getByRole("button", { name: "End vote" })).toBeVisible();
  await expect.poll(async () => (await box(row.locator(".list-row__action"))).width).toBe(36);
  expect(await geometry()).toEqual(baseline);

  await page.getByRole("button", { name: "End vote" }).click();
  await expect(page.getByRole("button", { name: "End vote" })).toHaveCount(0);
  expect(await geometry()).toEqual(baseline);

  failNextSave = true;
  await page.getByRole("textbox", { name: "Question" }).fill("Dinner changed");
  await expect(page.getByText("Not saved – retry", { exact: true })).toBeVisible({ timeout: 5_000 });
  expect(await geometry()).toEqual(baseline);

  await page.getByRole("button", { name: "Remove answer 2" }).click();
  await expect(row).toContainText("Incomplete");
  await expect(row.locator(".list-row__action button")).toBeDisabled();
  expect(await geometry()).toEqual(baseline);

  const addAnswer = page.getByRole("button", { name: "Answer", exact: true });
  for (let index = 0; index < 8; index += 1) await addAnswer.click();
  await expect(row).toContainText("9 answers");
  await expect(addAnswer).toBeDisabled();
  expect(await geometry()).toEqual(baseline);
});

test("saved voting inspector stays open at desktop, overlay, and compact widths", async ({ page }) => {
  const openedAt = "2030-01-01T12:00:00.000Z";
  const runningTemplate: ChatVoteTemplate = {
    id: "template-food", channelId: "channel-a", shortcut: "essen", title: "Was essen?",
    labels: ["Pizza", "Burger", "Kebab"], freeTextMode: null, durationSeconds: 300, revision: 2,
    legacyAlias: null, lastUsedAt: openedAt, createdAt: "2030-01-01T11:00:00.000Z", updatedAt: openedAt,
  };
  const selectedTemplate: ChatVoteTemplate = {
    id: "template-stream", channelId: "channel-a", shortcut: "stream", title: "Wer streamt morgen?",
    labels: ["Ich", "Jemand anderes"], freeTextMode: null, durationSeconds: 120, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: "2030-01-01T10:00:00.000Z", updatedAt: "2030-01-01T10:00:00.000Z",
  };
  const vote = {
    id: "vote-food", channelId: "channel-a", kind: "options", optionCount: 3, labels: ["Pizza", "Burger", "Kebab"],
    title: "Was essen wir heute?", status: "open", openedAt, closesAt: "2030-01-01T12:05:00.000Z",
    requestedDurationSeconds: 300, closedAt: null, closeReason: null, counts: [20, 11, 6], voterCount: 37,
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote, counts: vote.counts, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [runningTemplate, selectedTemplate], count: 2, maximum: 100 });
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "language", { value: "de-DE" });
    Object.defineProperty(window.navigator, "languages", { value: ["de-DE", "de"] });
  });
  for (const width of [1440, 1100, 760]) {
    await page.setViewportSize({ width, height: 1200 });
    await gotoPanel(page, "chat_voting", "de");
    await expect(page.locator(".chat-voting-live")).toBeVisible();
    const row = page.locator(".chat-voting-template-list .list-row__link").nth(1);
    await row.click();
    const inspector = page.locator(".chat-voting-template-inspector");
    await expect(inspector).toContainText("Wer streamt morgen?");
    const inspectorLayout = await page.evaluate(() => {
      const root = document.querySelector(".chat-voting-template-inspector");
      const body = root?.querySelector(".chat-voting-editor__body");
      const footer = root?.querySelector(".chat-voting-editor__footer");
      if (!(root instanceof HTMLElement) || !(body instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
        throw new Error("The saved voting inspector body and footer are incomplete.");
      }
      const rootBox = root.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      return {
        bodyAboveFooter: bodyBox.bottom <= footerBox.top,
        footerInsideInspector: footerBox.bottom <= rootBox.bottom + 1,
      };
    });
    expect(inspectorLayout.bodyAboveFooter).toBe(true);
    expect(inspectorLayout.footerInsideInspector).toBe(true);
    const answerFieldGap = await inspector.locator(".chat-voting-editor__answer").first().evaluate((row) => {
      const input = row.querySelector("input");
      const removeButton = row.querySelector(".mantine-Button-root");
      if (!(input instanceof HTMLElement) || !(removeButton instanceof HTMLElement)) {
        throw new Error("The answer input and remove button are incomplete.");
      }
      return removeButton.getBoundingClientRect().left - input.getBoundingClientRect().right;
    });
    expect(answerFieldGap).toBeGreaterThanOrEqual(0);
    expect(answerFieldGap).toBeLessThanOrEqual(8);
    const questionCounterGap = await inspector.locator(".chat-voting-editor__counted-field--question").evaluate((field) => {
      const input = field.querySelector("input");
      const counter = field.querySelector(".ui-field__count");
      if (!(input instanceof HTMLElement) || !(counter instanceof HTMLElement)) {
        throw new Error("The question input and counter are incomplete.");
      }
      return counter.getBoundingClientRect().left - input.getBoundingClientRect().right;
    });
    expect(questionCounterGap).toBeGreaterThanOrEqual(0);
    expect(questionCounterGap).toBeLessThanOrEqual(10);
    await expect(inspector.getByRole("button", { name: "Freitext", exact: true })).toHaveCount(0);
    await expect(inspector.getByRole("spinbutton", { name: "Sekunden" })).toBeDisabled();
    await expect(inspector.getByRole("spinbutton", { name: "Sekunden" })).toHaveValue("120");
    await inspector.locator(".chat-voting-editor__body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastContentIsReachable = await page.evaluate(() => {
      const body = document.querySelector(".chat-voting-editor__body");
      const footer = document.querySelector(".chat-voting-editor__footer");
      const lastContent = body?.lastElementChild;
      if (!(body instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(lastContent instanceof HTMLElement)) {
        throw new Error("The saved voting inspector has no scrollable last section.");
      }
      return lastContent.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1
        && footer.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 1;
    });
    expect(lastContentIsReachable).toBe(true);
    if (width >= 1280) {
      await expect(page.locator(".list-detail")).toHaveClass(/list-detail--open/u);
    } else {
      await expect(page.locator(".list-detail")).toHaveClass(/list-detail--open/u);
    }
  }

  await page.setViewportSize({ width: 1440, height: 1200 });
  await gotoPanel(page, "chat_voting-action", "de");
  await expect(page.locator(".chat-voting-immediate")).toContainText("Abstimmung");
  await expect(page.getByRole("button", { name: "Beenden" })).toBeVisible();
});
test("chat voting immediate action fits the 192px card with two visible rows and inner scroll", async ({ page }) => {
  const openedAt = "2030-01-01T12:00:00.000Z";
  const templates: ChatVoteTemplate[] = Array.from({ length: 6 }, (_, index) => ({
    id: `template-${String(index)}`, channelId: "channel-a", shortcut: `t${String(index)}`, title: `Vorlage ${String(index + 1)}`,
    labels: ["Ja", "Nein"], freeTextMode: null, durationSeconds: 120, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: openedAt, updatedAt: openedAt,
  }));
  const vote = {
    id: "vote-a", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Ja", "Nein"],
    title: "Was essen wir heute Abend?", status: "open", openedAt, closesAt: "2030-01-01T12:02:00.000Z",
    requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [3, 1], voterCount: 4,
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote, counts: vote.counts, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates, count: 6, maximum: 100 });
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "language", { value: "de-DE" });
    Object.defineProperty(window.navigator, "languages", { value: ["de-DE", "de"] });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting-action", "de");
  const card = page.locator(".chat-voting-immediate");
  await expect(card.getByRole("button", { name: "Beenden" })).toBeVisible();
  await expect(card.locator(".list-row")).toHaveCount(6);
  const metrics = await page.evaluate(() => {
    const cardElement = document.querySelector(".chat-voting-immediate") as HTMLElement;
    const list = cardElement.querySelector(".chat-voting-immediate__list") as HTMLElement;
    const card = cardElement.getBoundingClientRect();
    const rows = [...list.querySelectorAll(".list-row")].map((row) => row.getBoundingClientRect());
    const listBox = list.getBoundingClientRect();
    const children = [...cardElement.children].map((child) => child.getBoundingClientRect());
    return {
      cardHeight: card.height,
      cardOverflows: cardElement.scrollHeight > cardElement.clientHeight,
      childrenInside: children.every((child) => child.bottom <= card.bottom + 0.5),
      rowHeight: rows[0]?.height ?? 0,
      visibleRows: rows.filter((row) => row.top >= listBox.top - 0.5 && row.bottom <= listBox.bottom + 0.5).length,
      listScrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(metrics.cardHeight).toBe(192);
  expect(metrics.cardOverflows).toBe(false);
  expect(metrics.childrenInside).toBe(true);
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(34);
  expect(metrics.visibleRows).toBe(2);
  expect(metrics.listScrolls).toBe(true);
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

test("custom duration fits with its controls and unit at desktop and mobile widths", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const template: ChatVoteTemplate = {
    id: "template-custom", channelId: "channel-a", shortcut: "custom", title: "Custom duration",
    labels: ["First", "Second"], freeTextMode: null, durationSeconds: 90, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "chat_voting", "en");
    await page.locator(".chat-voting-template-list .list-row__link").first().click();
    const inspector = page.locator(".chat-voting-template-inspector");
    await expect(inspector).toBeVisible();
    const durationSection = inspector.locator(".inspector-content-section").filter({ hasText: "Duration" }).last();
    const segments = durationSection.locator(".ui-segmented-control__control");
    const durationSlot = durationSection.locator(".chat-voting-editor__duration-slot");
    const numberField = durationSlot.locator(".ui-number-field__stepper");
    const seconds = page.getByRole("spinbutton", { name: "Seconds" });
    await expect(seconds).toHaveValue("90");
    const layout = await page.evaluate(() => {
      const root = document.querySelector(".chat-voting-template-inspector");
      const section = [...document.querySelectorAll(".inspector-content-section")].find((element) => element.textContent.includes("Duration"));
      const controls = section?.querySelector(".ui-segmented-control__control");
      const slot = section?.querySelector(".chat-voting-editor__duration-slot");
      const stepper = slot?.querySelector(".ui-number-field__stepper");
      const field = stepper?.querySelector("input");
      const unit = stepper?.querySelector(".mantine-Input-section");
      if (!(root instanceof HTMLElement) || !(controls instanceof HTMLElement) || !(slot instanceof HTMLElement) || !(stepper instanceof HTMLElement) || !(field instanceof HTMLElement) || !(unit instanceof HTMLElement)) {
        throw new Error("The custom duration field is incomplete.");
      }
      const rootBox = root.getBoundingClientRect();
      const controlsBox = controls.getBoundingClientRect();
      const slotBox = slot.getBoundingClientRect();
      const stepperBox = stepper.getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const unitBox = unit.getBoundingClientRect();
      return {
        slotBelowControls: slotBox.top >= controlsBox.bottom,
        slotInsideInspector: slotBox.left >= rootBox.left && slotBox.right <= rootBox.right,
        slotHeight: slotBox.height,
        stepperInsideSlot: stepperBox.left >= slotBox.left && stepperBox.right <= slotBox.right,
        fieldWidth: fieldBox.width,
        unitInsideStepper: unitBox.left >= stepperBox.left && unitBox.right <= stepperBox.right,
      };
    });
    expect(layout.slotBelowControls).toBe(true);
    expect(layout.slotInsideInspector).toBe(true);
    expect(layout.slotHeight).toBe(44);
    expect(layout.stepperInsideSlot).toBe(true);
    expect(layout.fieldWidth).toBeGreaterThanOrEqual(96);
    expect(layout.unitInsideStepper).toBe(true);
    await expect(segments).toBeVisible();
    await expect(numberField).toBeVisible();
  }
});

test("free-text voting always renders five fixed result rows at desktop and mobile widths", async ({ page }) => {
  const longTerm = "0123456789012345678901234";
  const terms = [
    { term: longTerm, count: 2, approved: false },
    { term: "second", count: 1, approved: false },
  ];
  const timestamp = "2030-01-01T12:00:00.000Z";
  const template: ChatVoteTemplate = {
    id: "template-free-text", channelId: "channel-a", shortcut: "free", title: "Free text",
    labels: [], freeTextMode: "first_word", durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const vote = {
    id: "text-vote-a", channelId: "channel-a", kind: "free_text", optionCount: 0, labels: [], title: "Free text vote",
    textMode: "first_word", termFilterReady: true, status: "open", openedAt: timestamp, closesAt: "2030-01-01T12:01:00.000Z",
    requestedDurationSeconds: 60, closedAt: null, closeReason: null, counts: [], voterCount: 3, textResults: null,
  };
  let approvedTerm: string | null = null;
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: [], revision: approvedTerm === null ? 1 : 2,
      terms: terms.map((entry) => ({ ...entry, approved: entry.term === approvedTerm })),
      moreTerms: 0, hasOpenBallot: true, defaultDurationSeconds: 60,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/approve-term", async (route) => {
    const body = await route.request().postDataJSON() as { pollId: string; term: string };
    expect(body.pollId).toBe(vote.id);
    approvedTerm = body.term;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ terms, moreTerms: 0, revision: 2 }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await routeJson(page, "/api/csrf", { token: "csrf" });

  for (const width of [1440, 390]) {
    approvedTerm = null;
    await page.setViewportSize({ width, height: 844 });
    await gotoPanel(page, "chat_voting", "en");
    const rows = page.locator(".chat-voting-live__rows--free-text .chat-voting-results__term-row");
    await expect(rows).toHaveCount(5);
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))).toEqual(Array<number>(5).fill(34));
    const emptySlots = page.locator(".chat-voting-live__rows--free-text .chat-voting-results__empty-slot");
    await expect(emptySlots).toHaveCount(3);
    await expect(emptySlots.first()).toBeHidden();
    const fullLabel = rows.first().locator(".chat-voting-results__label");
    await expect(fullLabel).toHaveAttribute("title", longTerm);
    expect(await fullLabel.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    if (width === 390) expect(await fullLabel.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const rowsBefore = await box(page.locator(".chat-voting-live__rows"));
    const endButton = page.getByRole("button", { name: "End vote" });
    await expect(endButton).toBeVisible();
    const dangerColors = await endButton.evaluate((element) => ({
      button: (element as HTMLElement).style.getPropertyValue("--button-bg"),
      token: getComputedStyle(document.documentElement).getPropertyValue("--error").trim(),
    }));
    expect(dangerColors.button).toBe(dangerColors.token);
    await rows.locator(".mantine-Button-root").first().click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(5);
    expect(await box(page.locator(".chat-voting-live__rows"))).toEqual(rowsBefore);
  }
});

test("a timer-closed vote leaves the panel draft unchanged", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const labels = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"];
  const template: ChatVoteTemplate = {
    id: "template-timer", channelId: "channel-a", shortcut: "draft", title: "Draft question?",
    labels, freeTextMode: null, durationSeconds: 90, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let vote = null as Record<string, unknown> | null;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote === null ? null : vote.counts, revision: vote?.status === "open" ? 2 : 1,
      terms: null, moreTerms: null, hasOpenBallot: vote?.status === "open", defaultDurationSeconds: 120,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates: [template], count: 1, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      const update = await route.request().postDataJSON() as Partial<ChatVoteTemplate>;
      Object.assign(template, update, { revision: template.revision + 1, updatedAt: "2030-01-01T12:00:01.000Z" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    const body = await route.request().postDataJSON() as { templateId: string };
    expect(body.templateId).toBe(template.id);
    vote = {
      id: "timer-vote", channelId: "channel-a", kind: "options", optionCount: labels.length, labels: [...labels],
      title: template.title, status: "open", openedAt: timestamp, closesAt: "2030-01-01T12:01:30.000Z",
      requestedDurationSeconds: 90, closedAt: null, closeReason: null, counts: Array<number>(labels.length).fill(0), voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting", "en");
  await page.locator(".chat-voting-template-list .list-row__link").first().click();
  const question = page.getByRole("textbox", { name: "Question" });
  const firstAnswer = page.getByRole("textbox", { name: "Answer 1" });
  const seconds = page.getByRole("spinbutton", { name: "Seconds" });
  await expect(question).toHaveValue("Draft question?");
  await expect(firstAnswer).toHaveValue("First");
  await expect(seconds).toHaveValue("90");

  await page.getByRole("button", { name: "Start vote" }).click();
  await expect(page.locator(".chat-voting-live__action-slot .mantine-Button-root")).toBeVisible();
  await expect(question).toHaveValue("Draft question?");
  await expect(firstAnswer).toHaveValue("First");
  await expect(seconds).toHaveValue("90");
  vote = { ...(vote ?? {}), status: "closed", closedAt: "2030-01-01T12:01:30.000Z", closeReason: "timer" };
  await expect(page.getByText("Ended", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(question).toHaveValue("Draft question?");
  await expect(firstAnswer).toHaveValue("First");
  await expect(seconds).toHaveValue("90");
  await expect(page.getByRole("button", { name: "Start vote" })).toBeEnabled();
});

test("an overnight chat voting result keeps its closing time fully visible at 390px", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const openedAt = new Date(2030, 9, 6, 23, 50).toISOString();
  const closedAt = new Date(2030, 9, 7, 0, 10).toISOString();
  const template: ChatVoteTemplate = {
    id: "template-night", channelId: "channel-a", shortcut: "night", title: "Night vote",
    labels: ["Yes", "No"], freeTextMode: null, durationSeconds: 1200, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  const vote = {
    id: "night-vote", channelId: "channel-a", kind: "yes_no", optionCount: 2, labels: ["Yes", "No"],
    title: "Night vote", status: "closed", openedAt, closesAt: closedAt, requestedDurationSeconds: 1200,
    closedAt, closeReason: "timer", counts: [3, 1], voterCount: 4,
  };
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote, counts: [3, 1], revision: 2, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/recent", { votes: [vote] });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting", "de");
  await page.getByText("Zuletzt", { exact: true }).click();
  const row = page.locator(".chat-voting-recent-list .list-row__link").first();
  await row.click();
  const meta = page.locator(".chat-voting-recent-inspector__meta");
  await expect(meta).toContainText("(+1)");
  const closingTime = await page.evaluate((value) => new Intl.DateTimeFormat("de-DE", { timeStyle: "short" }).format(new Date(value)), closedAt);
  await expect(meta).toContainText(closingTime);
  const dimensions = await meta.evaluate((element) => ({ width: element.clientWidth, contentWidth: element.scrollWidth }));
  expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width);
});

test("the mobile live vote block keeps its height when the first vote starts", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const title = "A deliberately long live question that must wrap to only two lines on a narrow screen";
  const template: ChatVoteTemplate = {
    id: "template-mobile", channelId: "channel-a", shortcut: "mobile", title,
    labels: ["First", "Second"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let vote: Record<string, unknown> | null = null;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote?.counts ?? null, revision: 1, terms: null, moreTerms: null,
      hasOpenBallot: vote?.status === "open", defaultDurationSeconds: 60,
    }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    vote = {
      id: "mobile-vote", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["First", "Second"],
      title, status: "open", openedAt: timestamp, closesAt: "2030-01-01T12:01:00.000Z",
      requestedDurationSeconds: 60, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting", "en");
  const live = page.locator(".chat-voting-live");
  const list = page.locator(".chat-voting-list");
  const toolbar = page.locator(".chat-voting-list .list-toolbar");
  const layout = async () => ({ live: await box(live), toolbar: await box(toolbar), list: await box(list) });
  await expect(page.getByText("No vote yet")).toBeVisible();
  const before = await layout();
  await page.getByRole("button", { name: `Start “${title}”` }).click();
  await expect(page.getByRole("button", { name: "End vote" })).toBeVisible();
  expect(await layout()).toEqual(before);
  const question = page.locator(".chat-voting-live__question");
  await expect(question).toHaveText(title);
  const questionLayout = await question.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineClamp: getComputedStyle(element).webkitLineClamp,
  }));
  expect(questionLayout.lineClamp).toBe("2");
  expect(questionLayout.height).toBeLessThanOrEqual(42);
});

test("the mobile live state reserves the same height while loading, failed, empty, and populated", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const title = "A stable mobile vote";
  const template: ChatVoteTemplate = {
    id: "template-stable-mobile", channelId: "channel-a", shortcut: "stable", title,
    labels: ["First", "Second"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let vote: Record<string, unknown> | null = null;
  let releaseFirstRequest: () => void = () => undefined;
  const firstRequestGate = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
  let currentRequests = 0;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    currentRequests += 1;
    if (currentRequests === 1) {
      await firstRequestGate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote, counts: vote?.counts ?? null, revision: 1, terms: null, moreTerms: null,
      hasOpenBallot: vote?.status === "open", defaultDurationSeconds: 60,
    }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await page.route("**/api/channels/channel-a/modules/chat_voting/start", async (route) => {
    vote = {
      id: "stable-mobile-vote", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["First", "Second"],
      title, status: "open", openedAt: timestamp, closesAt: "2030-01-01T12:01:00.000Z",
      requestedDurationSeconds: 60, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ vote }) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "chat_voting", "en");
  const liveState = page.locator(".chat-voting-panel > div > .ui-load-state");
  await expect(liveState).toHaveAttribute("data-status", "loading");
  const loadingHeight = (await box(liveState)).height;
  releaseFirstRequest();
  await expect(liveState).toHaveAttribute("data-status", "error");
  const errorHeight = (await box(liveState)).height;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No vote yet")).toBeVisible();
  const emptyHeight = (await box(liveState)).height;
  await page.getByRole("button", { name: `Start “${title}”` }).click();
  await expect(page.getByRole("button", { name: "End vote" })).toBeVisible();
  const populatedHeight = (await box(liveState)).height;

  expect(errorHeight).toBe(loadingHeight);
  expect(emptyHeight).toBe(loadingHeight);
  expect(populatedHeight).toBe(loadingHeight);
});
