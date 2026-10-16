import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import type { FaqEntry } from "../../src/modules/faq/contracts";

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

const gotoPanel = async (page: Page, panel: string, language?: "de" | "en", realtime = false): Promise<void> => {
  const languageQuery = language === undefined ? "" : `&lang=${language}`;
  const realtimeQuery = realtime ? "&realtime=1" : "";
    await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}${languageQuery}${realtimeQuery}`);
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
test("command editor and variable control stay in place while registered variables arrive", async ({ page }) => {
  let signalRequest: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
  let releaseResponse: () => void = () => undefined;
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", { commands: [], variables: [] });
  await page.route("**/api/channels/channel-a/template-variables", async (route) => {
    signalRequest();
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [
      { name: "text.welcome", moduleId: "text_library", isTextBlock: true },
    ] }) });
  });

  await page.setViewportSize({ width: 1280, height: 844 });
  await gotoPanel(page, "text_commands");
  await page.getByRole("button", { name: "Add command" }).click();
  await requestStarted;
  const response = page.getByRole("textbox", { name: "Response text", exact: true });
  await expect(response).toBeVisible();
  const editor = page.locator(".command-template-editor").first();
  const insertVariable = page.getByRole("button", { name: "Insert variable" });
  const desktopBefore = { editor: await box(editor), insertVariable: await box(insertVariable) };

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".collection-page")).toHaveAttribute("data-single-column", "true");
  const mobileBefore = { editor: await box(editor), insertVariable: await box(insertVariable) };
  releaseResponse();
  await expect(insertVariable).toBeVisible();
  await response.click();
  await page.keyboard.type("{");
  await expect(page.locator(".ui-template-text-field__suggestions")).toContainText("text.welcome");

  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator(".collection-page")).toHaveAttribute("data-single-column", "false");
  expect({ editor: await box(editor), insertVariable: await box(insertVariable) }).toEqual(desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".collection-page")).toHaveAttribute("data-single-column", "true");
  expect({ editor: await box(editor), insertVariable: await box(insertVariable) }).toEqual(mobileBefore);
});

test("template picker keeps its footer visible and scrolls options within the available height", async ({ page }) => {
  const variables = Array.from({ length: 16 }, (_, index) => ({
    name: `variable_${String(index)}`,
    group: "context",
    sample: `value_${String(index)}`,
    maxLength: 20,
    moduleId: "host",
    isTextBlock: false,
    contexts: ["chat_command", "event", "system"],
  }));
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", { commands: [], variables });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables });
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoPanel(page, "text_commands");
  await page.getByRole("button", { name: "Add command" }).click();
  const response = page.getByRole("textbox", { name: "Response" });
  await response.click();
  await page.keyboard.type("{");

  const dropdown = page.locator(".ui-template-text-field__suggestions-dropdown");
  const options = page.getByRole("listbox", { name: "Choose a variable" });
  await expect(dropdown).toBeVisible();
  expect(await options.getByRole("option").count()).toBeGreaterThanOrEqual(variables.length);
  const geometry = await page.evaluate(() => {
    const popup = document.querySelector(".ui-template-text-field__suggestions-dropdown");
    const list = document.querySelector(".ui-template-text-field__suggestions");
    const footerNode = document.querySelector(".ui-template-text-field__key-hints");
    if (!(popup instanceof HTMLElement) || !(list instanceof HTMLElement) || !(footerNode instanceof HTMLElement)) {
      throw new Error("The picker layout elements are missing.");
    }
    const popupRect = popup.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const footerRect = footerNode.getBoundingClientRect();
    return {
      scrollable: list.scrollHeight > list.clientHeight,
      listBottom: listRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      popupBottom: popupRect.bottom,
    };
  });
  expect(geometry.scrollable).toBe(true);
  expect(geometry.listBottom).toBeLessThanOrEqual(geometry.footerTop + 0.5);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.popupBottom + 0.5);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(() => dropdown.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(440.5);
  const tallGeometry = await page.evaluate(() => {
    const popup = document.querySelector(".ui-template-text-field__suggestions-dropdown");
    const list = document.querySelector(".ui-template-text-field__suggestions");
    const footerNode = document.querySelector(".ui-template-text-field__key-hints");
    if (!(popup instanceof HTMLElement) || !(list instanceof HTMLElement) || !(footerNode instanceof HTMLElement)) {
      throw new Error("The picker layout elements are missing.");
    }
    const popupRect = popup.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const footerRect = footerNode.getBoundingClientRect();
    return {
      scrollable: list.scrollHeight > list.clientHeight,
      listBottom: listRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      popupBottom: popupRect.bottom,
    };
  });
  expect(tallGeometry.scrollable).toBe(true);
  expect(tallGeometry.listBottom).toBeLessThanOrEqual(tallGeometry.footerTop + 0.5);
  expect(tallGeometry.footerBottom).toBeLessThanOrEqual(tallGeometry.popupBottom + 0.5);
});

test("FAQ game search opens on its first click and narrow chat controls stay readable", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/faq/entries", { orderRevision: 1, entries: [{
    id: "faq-416", name: "Example", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello", minimumTier: "everyone",
    cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: null, order: 0, revision: 1,
    lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
  }] });
  await routeJson(page, "/api/channels/channel-a/settings", {
    timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
    defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await page.route("**/api/channels/channel-a/games*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ games: [{ id: "g1", name: "A Long Game Name" }] }) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "faq", "en");
  await page.getByRole("button", { name: "Example hello", exact: true }).click();
  await page.getByRole("switch", { name: "Games" }).click();

  const gameSearch = page.getByRole("searchbox", { name: "Games" });
  await gameSearch.click();
  await expect(page.locator(".ui-game-multi-select__popup")).toBeVisible();
  await expect(gameSearch).toHaveAttribute("aria-expanded", "true");

  const target = page.getByRole("button", { name: "Chat target", exact: true });
  const value = target.locator(".ui-chat-target-field__value");
  await expect(target).toBeVisible();
  await expect(value).toHaveText("Use channel default (Only our chat)");
  const targetText = await value.evaluate((element) => ({
    text: element.textContent,
    whiteSpace: getComputedStyle(element).whiteSpace,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(targetText.text).toBe("Use channel default (Only our chat)");
  expect(targetText.whiteSpace).toBe("nowrap");
  expect(targetText.scrollWidth).toBeLessThanOrEqual(targetText.clientWidth);
  await expect(value).toHaveCSS("text-overflow", "ellipsis");

  const helper = page.locator(".ui-template-text-field__helper-row .ui-truncated-text").first();
  const helperStyle = await helper.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { whiteSpace: style.whiteSpace, lineClamp: style.webkitLineClamp };
  });
  expect(helperStyle.whiteSpace).toBe("normal");
  expect(helperStyle.lineClamp).toBe("2");

  await target.click();
  const selectedTarget = page.locator(".ui-chat-target-field__options .ui-chat-target-field__option").nth(1);
  await selectedTarget.focus();
  await page.keyboard.press("ArrowDown");
  await expect(value).toHaveText("Use channel default (Only our chat)");
});

test("FAQ game limit explains the cap without shifting the fields below it", async ({ page }) => {
  const games = Array.from({ length: 9 }, (_, index) => ({ id: `game-${String(index + 1)}`, name: `Game ${String(index + 1)}` }));
  await routeJson(page, "/api/channels/channel-a/modules/faq/entries", { orderRevision: 1, entries: [{
    id: "faq-limit-416", name: "Full game list", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello", minimumTier: "everyone",
    cooldownSeconds: 30, userCooldownSeconds: 0, games, chatTarget: "source_only", order: 0, revision: 1,
    lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
  }] });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await routeJson(page, "/api/channels/channel-a/settings", {
    timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
    defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
  });
  await page.route("**/api/channels/channel-a/games*", async (route) => {
    const url = new URL(route.request().url());
    const results = url.searchParams.has("ids") ? [] : [{ id: "game-10", name: "Game Ten" }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ games: results }) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "faq", "en");
  await page.getByRole("button", { name: "Full game list hello", exact: true }).click();

  const limitMessage = page.locator(".ui-game-multi-select__limit-message");
  const target = page.getByRole("button", { name: "Chat target", exact: true });
  const messageBefore = await limitMessage.boundingBox();
  const targetOffset = async () => target.evaluate((element) => {
    const editor = element.closest<HTMLElement>(".faq-panel__editor");
    if (editor === null) throw new Error("The FAQ editor scroll region is missing.");
    return element.getBoundingClientRect().top - editor.getBoundingClientRect().top + editor.scrollTop;
  });
  const targetBefore = await targetOffset();
  await page.getByRole("searchbox", { name: "Games" }).click();
  await page.getByRole("option", { name: "Game Ten" }).click();
  await expect(page.getByText("10-game limit reached; remove one to add another.")).toBeVisible();

  const messageAfter = await limitMessage.boundingBox();
  const targetAfter = await targetOffset();
  expect(messageBefore?.height).toBeGreaterThan(0);
  expect(messageAfter?.height).toBe(messageBefore?.height);
  expect(targetAfter).toBe(targetBefore);
});

test("FAQ collection uses the shared mobile list, detail, and focus transitions", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/faq/entries", { orderRevision: 1, entries: [{
    id: "faq-mobile", name: "Greeting", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello!", minimumTier: "everyone",
    cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: "source_only", order: 0, revision: 1,
    lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
  }] });
  await routeJson(page, "/api/channels/channel-a/settings", {
    timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
    defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "faq", "en");

  const collection = page.locator(".faq-panel .collection-page");
  const list = collection.locator(".collection-page__list");
  const detail = collection.locator(".collection-page__detail");
  const row = page.getByRole("button", { name: "Greeting hello", exact: true });
  await expect(list).toBeVisible();
  await expect(row).toBeVisible();
  await expect(detail).toBeHidden();
  expect(await collection.locator(".collection-page__list-content").evaluate((element) => element.clientHeight)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await row.click();
  await expect(detail).toBeVisible();
  await expect(page.getByRole("heading", { name: "Greeting" })).toBeFocused();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(list).toBeVisible();
  await expect(row).toBeFocused();

  await row.click();
  await expect(detail).toBeVisible();
  await expect(page.getByRole("heading", { name: "Greeting" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeVisible();
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("text command switch and role inclusion fit their narrow and desktop layouts", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", {
    commands: [], variables: [{ name: "score", value: 1, description: "Points" }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPanel(page, "text_commands", "en");
  await page.getByRole("button", { name: "Add command" }).click();
  await page.getByRole("textbox", { name: "Response text", exact: true }).waitFor();
  const prefixGeometry = await page.evaluate(() => {
    const nameInput = document.querySelector("#command-name");
    const aliases = document.querySelector(".chips-input__control");
    const namePrefix = document.querySelector("#command-name")?.parentElement?.querySelector(".ui-field__leading--prefix");
    const aliasPrefix = aliases?.querySelector(":scope > .ui-field__prefix");
    if (!(nameInput instanceof HTMLElement) || !(aliases instanceof HTMLElement) || !(namePrefix instanceof HTMLElement) || !(aliasPrefix instanceof HTMLElement)) {
      throw new Error("Command name or alias prefix groups are missing.");
    }
    return {
      nameBorder: getComputedStyle(nameInput.parentElement as HTMLElement).borderTopWidth,
      nameInputBorder: getComputedStyle(nameInput).borderTopWidth,
      nameSeparator: getComputedStyle(namePrefix).borderRightWidth,
      aliasBorder: getComputedStyle(aliases).borderTopWidth,
      aliasSeparator: getComputedStyle(aliasPrefix).borderRightWidth,
    };
  });
  expect(prefixGeometry).toEqual({ nameBorder: "1px", nameInputBorder: "0px", nameSeparator: "1px", aliasBorder: "1px", aliasSeparator: "1px" });
  await page.locator(".command-usage-advanced > summary").click();
  const targetSwitch = page.getByRole("switch", { name: "Change channel variable" });
  await targetSwitch.scrollIntoViewIfNeeded();
  const switchFits = await targetSwitch.evaluate((element) => {
    const heading = element.closest(".ui-switch-section__heading");
    if (heading === null) throw new Error("Switch section heading is missing.");
    return element.getBoundingClientRect().right <= heading.getBoundingClientRect().right - 3;
  });
  expect(switchFits).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  const inclusion = page.locator(".ui-role-threshold .ui-select__description .ui-truncated-text").first();
  await expect(inclusion).toBeVisible();
  const inclusionStyle = await inclusion.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { whiteSpace: style.whiteSpace, lineClamp: style.webkitLineClamp };
  });
  expect(inclusionStyle.whiteSpace).toBe("normal");
  expect(inclusionStyle.lineClamp).toBe("2");
  await expect(page.locator(".ui-role-threshold > .ui-locked-reason--reserved")).toHaveCount(0);
});

test("timer creation stays explicit when Enter is pressed in the name", async ({ page }) => {
  const variables = { variables: [{ name: "text.greeting", moduleId: "text_library", isTextBlock: true }] };
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/template-variables", variables);

  let timerCreated = false;
  await page.route("**/api/channels/channel-a/modules/timers/timers", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timers: [] }) });
    timerCreated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timer: {
      id: "timer-created", name: "Hourly", enabled: true, messageText: "Hello, chat!", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
    } }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/timers/event-time-sources", { sources: [] });
  await gotoPanel(page, "timers");
  await page.locator(".collection-page__list-toolbar").getByRole("button", { name: "Create timer" }).click();
  const editor = page.locator(".timer-editor");
  const nameField = editor.getByRole("textbox", { name: "Name" });
  await nameField.fill("Hourly");
  await nameField.press("Enter");
  expect(timerCreated).toBe(false);
  await editor.getByRole("textbox", { name: "Message" }).fill("Hello, chat!");
  await editor.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => timerCreated).toBe(true);
});

test("FAQ collection tests the draft, saves explicitly, and undoes an immediate priority move", async ({ page }) => {
  const stamp = "2030-01-01T12:00:00.000Z";
  let entries: FaqEntry[] = [
    {
      id: "faq-a", name: "Greeting", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello!",
      minimumTier: "everyone", cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: "source_only", order: 0, revision: 1,
      lastUsedAt: null, createdAt: stamp, updatedAt: stamp,
    },
    {
      id: "faq-b", name: "Support", enabled: true, matcher: { type: "keywords", patterns: ["support"] }, answerText: "Ask a moderator.",
      minimumTier: "everyone", cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: "source_only", order: 1, revision: 1,
      lastUsedAt: null, createdAt: stamp, updatedAt: stamp,
    },
  ];
  let orderWrites = 0;
  let orderRevision = 1;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/settings", {
    timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
    defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await page.route("**/api/channels/channel-a/modules/faq/entries", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries, orderRevision }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/channels/channel-a/modules/faq/entries/faq-a", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { answerText: string };
    entries = entries.map((entry) => entry.id === "faq-a" ? { ...entry, answerText: body.answerText, revision: entry.revision + 1 } : entry);
    const entry = entries.find((candidate) => candidate.id === "faq-a");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entry }) });
  });
  await page.route("**/api/channels/channel-a/modules/faq/entries/order", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    orderWrites += 1;
    const body = route.request().postDataJSON() as { order: string[]; revision: number };
    entries = body.order.map((id, order) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`Missing FAQ fixture entry ${id}.`);
      return { ...entry, order };
    });
    orderRevision += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries, orderRevision }) });
  });

  await gotoPanel(page, "faq", "en");
  const sample = page.getByRole("textbox", { name: "Test a sample message" });
  await sample.fill("hello everyone");
  await expect(page.locator(".faq-panel__sample-result")).toHaveText("Matched by “hello”.");
  await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Welcome to the channel!");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await page.getByRole("button", { name: "Greeting hello", exact: true }).press("Alt+ArrowDown");
  await expect.poll(() => orderWrites).toBe(1);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => orderWrites).toBe(2);
  expect(entries.map(({ id }) => id)).toEqual(["faq-a", "faq-b"]);
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

test("saving a dirty saved vote retries after a failed explicit save", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  let template: ChatVoteTemplate = {
    id: "template-start-save", channelId: "channel-a", shortcut: "dinner", title: "Dinner",
    labels: ["Pizza", "Pasta"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let failNextSave = true;
  const operations: string[] = [];
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates: [template], count: 1, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      const update = await route.request().postDataJSON() as Partial<ChatVoteTemplate>;
      if (failNextSave) {
        failNextSave = false;
        operations.push("save-failed");
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error" }) });
        return;
      }
      template = { ...template, ...update, revision: template.revision + 1, updatedAt: "2030-01-01T12:01:00.000Z" };
      operations.push("save");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  const question = page.getByRole("textbox", { name: "Question" });
  await question.fill("Dinner after edit");
  await expect(page.getByRole("button", { name: "Start vote", exact: true })).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(page.locator(".ui-save-bar__status")).toContainText("Not saved – retry");
  expect(operations).toEqual(["save-failed"]);
  await expect(question).toHaveValue("Dinner after edit");

  await save.click();
  await expect(page.locator(".ui-save-bar__status")).toContainText("Saved");
  expect(operations).toEqual(["save-failed", "save"]);
  await expect(question).toHaveValue("Dinner after edit");
});

test("template conflict keeps the draft until Reload accepts the latest version", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  let latest: ChatVoteTemplate = {
    id: "template-conflict", channelId: "channel-a", shortcut: "conflict", title: "Original",
    labels: ["First", "Second"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let patchCount = 0;
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates: [latest], count: 1, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      patchCount += 1;
      latest = { ...latest, title: "Remote change", revision: 2, updatedAt: "2030-01-01T12:01:00.000Z" };
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "chat_vote_template_conflict" }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  const question = page.getByRole("textbox", { name: "Question" });
  await question.fill("Local change");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".ui-save-bar__status")).toContainText("Changed elsewhere – reload");
  expect(patchCount).toBe(1);
  await expect(question).toHaveValue("Local change");
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(question).toHaveValue("Remote change");
  await expect(page.locator(".ui-save-bar__status")).not.toContainText("Changed elsewhere – reload");
});

test("a server shortcut conflict stays on its field and preserves the rest of the draft", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const template: ChatVoteTemplate = {
    id: "template-shortcut-conflict", channelId: "channel-a", shortcut: "first", title: "Original",
    labels: ["First", "Second"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates/template-shortcut-conflict", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "chat_vote_template_shortcut_conflict" }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  const question = page.getByRole("textbox", { name: "Question" });
  await question.fill("Keep this question");
  await page.getByRole("textbox", { name: "Shortcut" }).fill("taken");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const shortcutField = page.locator(".chat-voting-template-inspector .ui-field").filter({ has: page.getByRole("textbox", { name: "Shortcut" }) });
  await expect(shortcutField.locator(".ui-field__error")).toContainText("This shortcut is already in use.");
  await expect(question).toHaveValue("Keep this question");
  await expect(page.getByRole("textbox", { name: "Answer 1" })).toHaveValue("First");
});

test("new saved votes remain local until Save", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  let createCount = 0;
  const templates: ChatVoteTemplate[] = [];
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120,
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates, count: templates.length, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "POST") {
      createCount += 1;
      const draft = await route.request().postDataJSON() as Omit<ChatVoteTemplate, "id" | "channelId" | "revision" | "legacyAlias" | "lastUsedAt" | "createdAt" | "updatedAt">;
      const template: ChatVoteTemplate = {
        id: "template-created", channelId: "channel-a", ...draft, revision: 1, legacyAlias: null,
        lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
      };
      templates.unshift(template);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  await page.locator(".list-toolbar__create button").click();
  await expect(page.locator(".chat-voting-template-inspector")).toBeVisible();
  expect(createCount).toBe(0);
  await page.getByRole("textbox", { name: "Question" }).fill("Vote created on save");
  await page.getByRole("button", { name: "Yes/No", exact: true }).click();
  expect(createCount).toBe(0);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => createCount).toBe(1);
  await expect(page.locator(".chat-voting-template-list .list-row")).toContainText("Vote created on save");
});

test("a second save preserves edits made while a newly created vote is being acknowledged", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  let template: ChatVoteTemplate | null = null;
  let releasePatch: () => void = () => undefined;
  let markPatchStarted: () => void = () => undefined;
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  const patchStarted = new Promise<void>((resolve) => { markPatchStarted = resolve; });
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
  });
  await page.route("**/api/channels/channel-a/modules/chat_voting/templates**", async (route) => {
    if (route.request().method() === "GET") {
      const templates = template === null ? [] : [template];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ templates, count: templates.length, maximum: 100 }) });
      return;
    }
    if (route.request().method() === "POST") {
      const draft = await route.request().postDataJSON() as Partial<ChatVoteTemplate>;
      template = {
        id: "template-created-again", channelId: "channel-a", shortcut: null, title: draft.title ?? "",
        labels: draft.labels ?? [], freeTextMode: null, durationSeconds: 60, revision: 1, legacyAlias: null,
        lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
      };
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      markPatchStarted();
      await patchGate;
      const draft = await route.request().postDataJSON() as Partial<ChatVoteTemplate>;
      template = { ...(template as ChatVoteTemplate), ...draft, revision: (template?.revision ?? 0) + 1, updatedAt: timestamp };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ template }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  await page.locator(".list-toolbar__create button").click();
  const question = page.getByRole("textbox", { name: "Question" });
  await question.fill("First saved version");
  await page.getByRole("button", { name: "Yes/No", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".ui-save-bar__status")).toContainText("Saved");
  await expect(page.locator(".chat-voting-template-list .list-row")).toContainText("First saved version");

  await question.fill("Second save submitted");
  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await patchStarted;
    await question.fill("Edited while acknowledgement is pending");
    releasePatch();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(question).toHaveValue("Edited while acknowledgement is pending");
  } finally {
    releasePatch();
  }
});

test("the saved vote inspector keeps its draft while leaving vote starts to the live cockpit", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const template: ChatVoteTemplate = {
    id: "template-running-note", channelId: "channel-a", shortcut: "running", title: "A deliberately long saved question that needs room to wrap clearly",
    labels: ["Yes", "No"], freeTextMode: null, durationSeconds: 60, revision: 1,
    legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  await routeJson(page, "/api/csrf", { token: "csrf" });
  await page.route("**/api/channels/channel-a/modules/chat_voting/current", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
    }) });
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates: [template], count: 1, maximum: 100 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoPanel(page, "chat_voting", "en");
  const inspector = page.locator(".chat-voting-template-inspector");
  const question = page.getByRole("textbox", { name: "Question" });
  await expect(inspector.getByRole("button", { name: "Start vote", exact: true })).toHaveCount(0);
  await expect(page.locator(".chat-voting-template-list .list-row__action button")).toHaveCount(0);
  const header = inspector.locator(":scope > .page-header");
  const headerColumns = await header.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(headerColumns).not.toMatch(/^56px/u);
  const titleBounds = await box(header.locator(".page-header__main"));
  expect(titleBounds.width).toBeGreaterThan(200);
  const headerRight = await box(header.locator(".page-header__right"));
  const headerBounds = await box(header);
  expect(headerRight.x + headerRight.width).toBeCloseTo(headerBounds.x + headerBounds.width, 0);
  await expect(header.locator(".page-header__save .ui-save-bar")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const selectedLink = page.locator(".chat-voting-template-list .list-row--selected .list-row__link");
  const selectedStyles = await selectedLink.evaluate((element) => ({
    boxShadow: getComputedStyle(element).boxShadow,
    backgroundColor: getComputedStyle(element).backgroundColor,
  }));
  expect(selectedStyles.boxShadow).not.toBe("none");
  expect(selectedStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  const createButton = page.getByRole("button", { name: "Create vote" });
  const firstVote = page.locator(".chat-voting-template-list .list-row__link").first();
  const listToolbarContainer = page.locator(".collection-page__list-toolbar");
  const votingToolbar = page.locator(".chat-voting-collection__toolbar");
  const toolbarRow = page.locator(".chat-voting-collection__toolbar .list-toolbar__row");
  const toolbarSearch = page.locator(".chat-voting-collection__toolbar .list-toolbar__search");
  const toolbarCreate = page.locator(".chat-voting-collection__toolbar .list-toolbar__create");
  const listToolbarContainerBounds = await box(listToolbarContainer);
  const votingToolbarBounds = await box(votingToolbar);
  const toolbarRowBounds = await box(toolbarRow);
  const toolbarSearchBounds = await box(toolbarSearch);
  const toolbarSearchInputBounds = await box(toolbarSearch.locator(".ui-field__input"));
  const toolbarCreateBounds = await box(toolbarCreate);
  expect(votingToolbarBounds.x).toBeCloseTo(listToolbarContainerBounds.x, 0);
  expect(votingToolbarBounds.width).toBeCloseTo(listToolbarContainerBounds.width, 0);
  expect(toolbarSearchBounds.x).toBeCloseTo(toolbarRowBounds.x, 0);
  expect(toolbarSearchBounds.width).toBeCloseTo(toolbarRowBounds.width, 0);
  expect(toolbarSearchInputBounds.width).toBeCloseTo(toolbarRowBounds.width, 0);
  expect(toolbarCreateBounds.x).toBeCloseTo(toolbarRowBounds.x, 0);
  expect(toolbarCreateBounds.y).toBeGreaterThan(toolbarSearchBounds.y);
  const titleStyle = await firstVote.locator(".list-row__title").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      whiteSpace: style.whiteSpace,
      lineClamp: style.getPropertyValue("-webkit-line-clamp"),
      boxOrient: style.getPropertyValue("-webkit-box-orient"),
      lineHeight: Number.parseFloat(style.lineHeight),
      height: element.getBoundingClientRect().height,
    };
  });
  expect(titleStyle.whiteSpace).toBe("normal");
  expect(titleStyle.lineClamp).toBe("2");
  expect(titleStyle.boxOrient).toBe("vertical");
  expect(titleStyle.height).toBeLessThanOrEqual(titleStyle.lineHeight * 2 + 1);
  const createBounds = await box(createButton);
  const firstVoteBounds = await box(firstVote);
  expect(firstVoteBounds.y - createBounds.y - createBounds.height).toBeLessThanOrEqual(24);

  const before = await box(question);
  await question.fill("A saved draft");
  expect(await box(question)).toEqual(before);
  await expect(question).toHaveValue("A saved draft");

  const questionInputBounds = await box(question);
  const questionCount = inspector.locator(".chat-voting-editor__counted-field--question .ui-field__count");
  const questionCountBounds = await box(questionCount);
  expect(questionCountBounds.y).toBeGreaterThanOrEqual(questionInputBounds.y + questionInputBounds.height);
  expect(questionCountBounds.x + questionCountBounds.width).toBeCloseTo(questionInputBounds.x + questionInputBounds.width, 0);

  const firstAnswer = page.getByRole("textbox", { name: "Answer 1" });
  const firstAnswerNumber = inspector.locator(".chat-voting-editor__answer-key").first();
  const answerBounds = await box(firstAnswer);
  const answerNumberBounds = await box(firstAnswerNumber);
  expect(answerNumberBounds.height).toBeCloseTo(answerBounds.height, 0);
  expect(answerNumberBounds.y + answerNumberBounds.height / 2).toBeCloseTo(answerBounds.y + answerBounds.height / 2, 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  const mobileHeader = inspector.locator(":scope > .page-header");
  const mobileMain = await box(mobileHeader.locator(".page-header__main"));
  const mobileRight = await box(mobileHeader.locator(".page-header__right"));
  const mobileHeaderBounds = await box(mobileHeader);
  expect(mobileRight.y).toBeGreaterThanOrEqual(mobileMain.y + mobileMain.height - 0.5);
  expect(mobileRight.x).toBeGreaterThanOrEqual(mobileHeaderBounds.x - 0.5);
  expect(mobileRight.x + mobileRight.width).toBeLessThanOrEqual(mobileHeaderBounds.x + mobileHeaderBounds.width + 0.5);
  await expect(mobileHeader.locator(".page-header__title-row :is(h1, h2, h3)")).toHaveCSS("font-size", "18px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("text command slash help stays stable and optional variable fields mount only when enabled", async ({ page }) => {
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", {
    commands: [], variables: [{ name: "score", value: 1, description: "Points" }],
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await gotoPanel(page, "text_commands");
  await page.getByRole("button", { name: "Add command" }).click();
  const editor = page.locator(".text-command-editor");
  const response = page.getByRole("textbox", { name: "Response text", exact: true });
  await expect(response).toBeVisible();
  const slashHelp = page.locator(".command-slash-help");
  const editorBeforeSlash = await box(editor);

  await response.fill("/t");
  await expect(slashHelp).toContainText("Leading Twitch-style commands");
  await expect(slashHelp).toHaveCSS("position", "absolute");
  expect(await box(editor)).toEqual(editorBeforeSlash);

  await page.locator(".command-usage-advanced > summary").click();
  const actionSlot = page.getByTestId("command-variable-action-slot");
  const actionSection = page.locator(".ui-switch-section").filter({ has: page.getByRole("switch", { name: "Change channel variable" }) });
  await expect(actionSection).toContainText("Applied atomically with the command.");
  await expect(actionSlot).toHaveCount(0);
  await page.getByRole("switch", { name: "Change channel variable" }).click();
  await expect(actionSlot.locator("#command-variable-name")).toBeVisible();
  await expect(actionSection.locator(".ui-switch-section__content")).toBeVisible();
});

test("text-library filters fit the shared list and track mobile chip growth", async ({ page }) => {
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
    const list = page.locator(".collection-page__list-content");
    await expect(list).toBeVisible();
    const toolbar = page.locator(".text-library__list-toolbar");
    const filters = toolbar.locator(".list-toolbar__filters");
    const create = toolbar.getByRole("button", { name: "Add text block" });
    const picker = filters.locator(".ui-game-multi-select--compact");
    const slot = picker.locator(".ui-game-multi-select__selected");
    await expect(picker).toBeVisible();
    const pickerBox = await picker.boundingBox();
    const filtersBox = await filters.boundingBox();
    const createBox = await create.boundingBox();
    expect(pickerBox?.height).toBeLessThanOrEqual(44);
    if (width === 390 || width === 1280) {
      // The collection list is narrow enough for its toolbar container to use the stacked filter layout.
      const toolbarBox = await toolbar.boundingBox();
      expect(pickerBox?.y ?? 0).toBeGreaterThanOrEqual((createBox?.y ?? 0) + (createBox?.height ?? 0) - 0.5);
      expect(pickerBox?.width ?? 0).toBeGreaterThanOrEqual((toolbarBox?.width ?? 0) - 1);
    }
    else {
      // At 700px the category and game filters share a row below the search and create controls.
      expect(pickerBox?.y ?? 0).toBeGreaterThanOrEqual(filtersBox?.y ?? 0);
      expect((pickerBox?.y ?? 0) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual((filtersBox?.y ?? 0) + (filtersBox?.height ?? 0) + 0.5);
    }
    if (width === 700) {
      const filterOverflow = await filters.evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(filterOverflow).toBe(false);
      const searchBox = await toolbar.locator(".list-toolbar__search").boundingBox();
      expect(createBox?.x ?? 0).toBeGreaterThanOrEqual((searchBox?.x ?? 0) + (searchBox?.width ?? 0) - 0.5);
      expect(createBox?.y ?? 0).toBeGreaterThanOrEqual(searchBox?.y ?? 0);
      expect((createBox?.y ?? 0) + (createBox?.height ?? 0)).toBeLessThanOrEqual((searchBox?.y ?? 0) + (searchBox?.height ?? 0) + 0.5);
      expect(filtersBox?.y ?? 0).toBeGreaterThanOrEqual((searchBox?.y ?? 0) + (searchBox?.height ?? 0) - 0.5);
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(pageOverflow).toBe(false);
    }
    const before = { list: await box(list), slot: await box(slot) };
    let previous = before;
    const search = picker.getByRole("searchbox");
    for (const name of ["Just Chatting", "Software and Game Development", "Retro Adventure Collection Deluxe"]) {
      await search.fill("ga");
      await page.getByRole("option", { name }).click();
      const current = { list: await box(list), slot: await box(slot) };
      if (width === 390 || width === 1280) {
        const chipRowGrowth = current.slot.height - previous.slot.height;
        const listGrowth = current.list.y - previous.list.y;
        expect(chipRowGrowth).toBeGreaterThanOrEqual(0);
        expect(listGrowth).toBeGreaterThanOrEqual(chipRowGrowth - 0.5);
        expect(listGrowth).toBeLessThanOrEqual(chipRowGrowth + 4.5);
      }
      else {
        expect(current.list).toEqual(before.list);
        expect(current.slot).toEqual(before.slot);
      }
      previous = current;
    }
    if (width === 390 || width === 1280) {
      const activeFilters = toolbar.locator(".list-toolbar__active-filters");
      await expect(activeFilters).toContainText("Just Chatting");
      await expect(activeFilters).toContainText("Software and Game Development");
      await expect(activeFilters).toContainText("Retro Adventure Collection Deluxe");
      await search.press("Escape");
      await page.getByRole("button", { name: "Reset" }).click();
    }
    else {
      for (let selected = 3; selected > 0; selected -= 1) {
        await picker.locator(".ui-game-multi-select__chip button").first().click();
        expect(await box(list)).toEqual(before.list);
        expect(await box(slot)).toEqual(before.slot);
      }
    }
    expect(await box(list)).toEqual(before.list);
    expect(await box(slot)).toEqual(before.slot);
  }
});

test("text-library detail stays in place while the collection list scrolls", async ({ page }) => {
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
  await page.getByRole("button", { name: "{text.block_1}" }).click();
  const detail = page.locator(".collection-page__detail");
  const list = page.locator(".collection-page__list-content");
  await expect(detail).toBeVisible();
  const before = await detail.evaluate((element) => element.getBoundingClientRect().top);
  await list.evaluate((element) => { element.scrollTop = 100; });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(100);
  const after = await detail.evaluate((element) => element.getBoundingClientRect().top);
  expect(after).toBe(before);
});
