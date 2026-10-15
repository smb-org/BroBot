import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-429-review";
const channel = {
  channelId,
  login: "demo-kanal",
  displayName: "Demo Kanal",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-429-review", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};
const modules = [
  { id: "text_commands", enabled: true, settings: "{}" },
  { id: "faq", enabled: true, settings: "{}" },
];
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
const commandRecord = (name: string, text: string): Record<string, unknown> => ({
  channelId,
  name,
  text,
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  games: [],
  responseType: "say",
  chatTarget: null,
  variableAction: null,
  timeoutAction: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
  revision: 1,
});

interface MockDashboardOptions {
  failPatches?: boolean;
  role?: "manager" | "operator";
}

interface MockDashboardCounts {
  posts: number;
  patches: number;
  patchRequests: { revision: string | null; payload: Record<string, unknown> }[];
  commandReads: number;
  revisionReads: number;
  revisions: Record<string, number>;
  updateCommand: (command: Record<string, unknown>) => void;
}

const mockDashboard = async (page: Page, { failPatches = false, role = "manager" }: MockDashboardOptions = {}): Promise<MockDashboardCounts> => {
  const actorChannel = role === channel.role ? channel : { ...channel, role };
  const commands = new Map<string, Record<string, unknown>>([["hallo", commandRecord("hallo", "Hallo {user}! Willkommen im Kanal.")]]);
  const counts: MockDashboardCounts = {
    posts: 0,
    patches: 0,
    patchRequests: [],
    commandReads: 0,
    revisionReads: 0,
    revisions: {},
    updateCommand: (command) => { commands.set(String(command.name), command); },
  };
  const faqEntry = {
    id: "faq-429-review",
    name: "Begrüßung",
    enabled: true,
    matcher: { type: "keywords", patterns: ["hallo", "moin"] },
    answerText: "Hallo {user}, schön dass du da bist!",
    minimumTier: "everyone",
    cooldownSeconds: 30,
    userCooldownSeconds: 0,
    games: [],
    chatTarget: "channel_default",
    order: 0,
    revision: 1,
    lastUsedAt: "2026-10-14T06:45:00.000Z",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-10-14T06:45:00.000Z",
  };

  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [actorChannel], bot: actorChannel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({ ...actorChannel, activeModules: modules.map(({ id, settings }) => ({ moduleId: id, settings })) }));
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules }));
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
      if (method === "GET") {
        counts.commandReads += 1;
        return route.fulfill(json({ commands: [...commands.values()], variables: [] }));
      }
      if (method === "POST") {
        counts.posts += 1;
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        const name = typeof payload.name === "string" ? payload.name : "";
        const text = typeof payload.text === "string" ? payload.text : "";
        const command: Record<string, unknown> = { ...commandRecord(name, text), ...payload, revision: 1 };
        commands.set(String(command.name), command);
        return route.fulfill(json({ command, warnings: [] }));
      }
    }
    const commandMatch = new RegExp(`/api/channels/${channelId}/modules/text_commands/commands/([^/]+)$`, "u").exec(pathname);
    if (method === "PATCH" && commandMatch !== null) {
      counts.patches += 1;
      const oldName = decodeURIComponent(commandMatch[1] ?? "");
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      counts.patchRequests.push({ revision: new URL(route.request().url()).searchParams.get("revision"), payload });
      if (failPatches) return route.fulfill(json({ error: "temporary_save_failure" }, 500));
      const previous = commands.get(oldName) ?? commandRecord(oldName, "");
      const command: Record<string, unknown> = { ...previous, ...payload, revision: Number(previous.revision ?? 1) + 1, updatedAt: new Date().toISOString() };
      commands.delete(oldName);
      commands.set(String(command.name), command);
      return route.fulfill(json({ command, warnings: [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules/faq/entries`) return route.fulfill(json({ orderRevision: 1, entries: [faqEntry] }));
    if (pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (pathname === `/api/channels/${channelId}/revisions`) {
      counts.revisionReads += 1;
      return route.fulfill(json({ revisions: counts.revisions }));
    }
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-429-review" }));
    return route.fulfill(json({}));
  });

  return counts;
};

const installCommandRealtime = async (page: Page): Promise<{
  waitForSocket: () => Promise<void>;
  sendRevisionHint: (revision: number) => void;
}> => {
  let sendRevisionHint: ((revision: number) => void) | null = null;
  let messageNumber = 0;
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socket.onMessage(() => undefined);
    sendRevisionHint = (revision) => {
      messageNumber += 1;
      socket.send(JSON.stringify({
        version: 1,
        id: `command-revision-${String(messageNumber)}`,
        createdAt: "2030-01-01T12:00:00.000Z",
        channelId,
        type: "panel.resources.changed",
        payload: { resources: ["module:text_commands:commands"], revisions: { "module:text_commands:commands": revision } },
      }));
    };
  });
  return {
    waitForSocket: async () => { await expect.poll(() => sendRevisionHint !== null).toBe(true); },
    sendRevisionHint: (revision) => {
      if (sendRevisionHint === null) throw new Error("The text command realtime socket is not connected.");
      sendRevisionHint(revision);
    },
  };
};

const openTextCommand = async (page: Page, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${channelId}/modules/text_commands`);
  const row = page.locator(".text-command-row").filter({ hasText: "!hallo" });
  await row.click();
  await expect(page.getByRole("region", { name: "Eigenschaften von !hallo" })).toBeVisible();
};

test("failed command save preserves drafts for inactive response kinds", async ({ page }) => {
  await mockDashboard(page, { failPatches: true });
  await openTextCommand(page, 1280, 800);

  const response = page.getByRole("textbox", { name: "Antworttext" });
  await response.fill("Textentwurf bleibt erhalten");
  const kinds = page.locator(".text-command-kind-choice");
  await kinds.getByRole("button", { name: "Shoutout", exact: true }).click();
  await response.fill("Shoutout-Entwurf für den fehlgeschlagenen Speicherlauf");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Der Textbefehl konnte nicht gespeichert werden.", { exact: true })).toBeVisible();

  await kinds.getByRole("button", { name: "Antworttext", exact: true }).click();
  await expect(response).toHaveValue("Textentwurf bleibt erhalten");
});

test("operator command settings render as properties and keep the operational switch", async ({ page }) => {
  const counts = await mockDashboard(page, { role: "operator" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}/modules/text_commands`);

  const editor = page.getByRole("region", { name: "Eigenschaften von !hallo" });
  await expect(editor).toBeVisible();
  const row = page.locator(".text-command-row").filter({ hasText: "!hallo" });
  await expect(row).toHaveCSS("border-left-width", "4px");
  await expect(editor.locator("dl.properties")).toBeVisible();
  await expect(editor.getByText("Hallo {user}! Willkommen im Kanal.", { exact: true })).toBeVisible();
  const chatTarget = editor.locator("dl.properties > div").filter({ hasText: "Chat-Ziel" }).locator("dd");
  await expect(chatTarget).toHaveText("Nur unser Chat");
  await expect(editor.getByRole("textbox")).toHaveCount(0);

  const active = editor.getByRole("switch", { name: "Aktiv" });
  await expect(active).toBeEnabled();
  await active.click();
  await editor.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => counts.patches).toBe(1);
});

test("operator can toggle a command after realtime content changes using its latest revision", async ({ page }) => {
  const realtime = await installCommandRealtime(page);
  const counts = await mockDashboard(page, { role: "operator" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}/modules/text_commands`);

  const editor = page.getByRole("region", { name: "Eigenschaften von !hallo" });
  await expect(editor).toBeVisible();
  await realtime.waitForSocket();
  await expect.poll(() => counts.revisionReads).toBeGreaterThan(0);
  await page.waitForTimeout(300);

  const row = page.locator(".text-command-row").filter({ hasText: "!hallo" });
  counts.updateCommand({ ...commandRecord("hallo", "Der Verwalter hat die Antwort geändert."), revision: 2 });
  counts.revisions["module:text_commands:commands"] = 2;
  const previousReads = counts.commandReads;
  realtime.sendRevisionHint(2);
  await expect(row).toContainText("Der Verwalter hat die Antwort geändert.");
  await expect.poll(() => counts.commandReads).toBeGreaterThan(previousReads);

  await editor.getByRole("switch", { name: "Aktiv" }).click();
  await editor.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => counts.patchRequests).toHaveLength(1);
  expect(counts.patchRequests[0]).toEqual({ revision: null, payload: { enabled: false, revision: 2 } });
  await expect(editor.getByText("Der Verwalter hat die Antwort geändert.", { exact: true })).toBeVisible();
  await expect(editor.locator(".ui-save-bar__status")).toContainText("Alle Änderungen gespeichert");
});

test("selected command rows keep their visual highlight after focus leaves", async ({ page }) => {
  await mockDashboard(page);
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    await openTextCommand(page, width, height);

    const row = page.locator(".text-command-row").filter({ hasText: "!hallo" });
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row).not.toHaveAttribute("aria-selected");
    await page.getByRole("textbox", { name: "Antworttext" }).focus();
    await expect(row).toHaveCSS("border-left-width", "4px");
    const selectedStyle = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(selectedStyle).not.toBe("rgba(0, 0, 0, 0)");
  }
});

const expectCollectionPaneGeometry = async (page: Page, saveActionsSelector: string): Promise<void> => {
  const geometry = await page.evaluate((selector) => {
    const detail = document.querySelector<HTMLElement>(".collection-page__detail");
    const actions = document.querySelector<HTMLElement>(selector);
    const mainContent = document.querySelector<HTMLElement>(".main-content");
    if (detail === null || actions === null || mainContent === null) throw new Error("The collection pane geometry is incomplete.");
    const detailBox = detail.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const collection = detail.closest<HTMLElement>(".collection-page");
    const collectionBody = collection?.querySelector<HTMLElement>(".collection-page__body");
    const faqEditorGrid = detail.querySelector<HTMLElement>(".faq-panel__editor-grid");
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      mainContentClientWidth: mainContent.clientWidth,
      mainContentScrollWidth: mainContent.scrollWidth,
      detailClientWidth: detail.clientWidth,
      detailScrollWidth: detail.scrollWidth,
      detailLeft: detailBox.left,
      detailRight: detailBox.right,
      actionsLeft: actionsBox.left,
      actionsRight: actionsBox.right,
      collectionColumns: collectionBody == null ? "missing" : getComputedStyle(collectionBody).gridTemplateColumns,
      faqEditorColumns: faqEditorGrid == null ? "missing" : getComputedStyle(faqEditorGrid).gridTemplateColumns,
      visibleOverflowingChildren: Array.from(detail.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 1
            && (bounds.left < detailBox.left - 1 || bounds.right > detailBox.right + 1);
        })
        .map((element) => ({ className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
    };
  }, saveActionsSelector);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.mainContentScrollWidth).toBeLessThanOrEqual(geometry.mainContentClientWidth);
  expect(geometry.detailScrollWidth).toBeLessThanOrEqual(geometry.detailClientWidth + 4);
  expect(geometry.detailClientWidth).toBeGreaterThan(440);
  expect(geometry.collectionColumns).not.toBe("missing");
  expect(geometry.collectionColumns.split(" ")).toHaveLength(1);
  if (saveActionsSelector.includes("faq-panel__detail")) {
    expect(geometry.faqEditorColumns).not.toBe("missing");
    expect(geometry.faqEditorColumns.split(" ")).toHaveLength(1);
  }
  expect(geometry.visibleOverflowingChildren).toEqual([]);
  expect(geometry.actionsLeft).toBeGreaterThanOrEqual(geometry.detailLeft - 1);
  expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.detailRight + 1);
};

for (const [width, height] of [[820, 1180], [1024, 768]] as const) {
  test(`commands and FAQ editors fit the workspace at ${String(width)}x${String(height)}`, async ({ page }) => {
    await mockDashboard(page);
    await openTextCommand(page, width, height);

    await expect(page.locator(".text-command-editor")).toBeVisible();
    const commandSaveActions = page.locator(".text-command-editor__save .ui-save-bar__actions");
    await expect(commandSaveActions.getByRole("button", { name: "Speichern", exact: true })).toBeVisible();
    await expectCollectionPaneGeometry(page, ".text-command-editor__save .ui-save-bar__actions");

    await page.goto(`/channels/${channelId}/modules/faq`);
    const faqEntry = page.locator(".faq-panel__entry").filter({ hasText: "Begrüßung" });
    await faqEntry.click();
    await expect(page.locator(".faq-panel__editor")).toBeVisible();
    const faqSaveActions = page.locator(".faq-panel__detail > .page-header .ui-save-bar__actions");
    await expect(faqSaveActions.getByRole("button", { name: "Speichern", exact: true })).toBeVisible();
    await expectCollectionPaneGeometry(page, ".faq-panel__detail > .page-header .ui-save-bar__actions");
  });
}

test("Ctrl+Enter and Cmd+Enter save the current command draft", async ({ page }) => {
  const counts = await mockDashboard(page);
  await openTextCommand(page, 1280, 800);

  const response = page.getByRole("textbox", { name: "Antworttext" });
  await response.fill("Per Tastenkürzel gespeichert.");
  await response.press("Control+Enter");
  await expect.poll(() => counts.patches).toBe(1);

  await response.fill("Auch mit Cmd+Enter gespeichert.");
  await response.press("Meta+Enter");
  await expect.poll(() => counts.patches).toBe(2);
});

test("Ctrl+Enter does not save while an IME composition is active", async ({ page }) => {
  const counts = await mockDashboard(page);
  await openTextCommand(page, 1280, 800);

  const response = page.getByRole("textbox", { name: "Antworttext", exact: true });
  await response.fill("Ein unfertiger Eingabeentwurf.");
  await response.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, isComposing: true }));
  });
  await response.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, keyCode: 229 }));
  });
  await page.waitForTimeout(100);
  expect(counts.patches).toBe(0);

  await response.press("Control+Enter");
  await expect.poll(() => counts.patches).toBe(1);
});

test("mobile Save and switch turns a new command into its editor", async ({ page }) => {
  const counts = await mockDashboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/text_commands`);
  await page.getByRole("button", { name: "Befehl anlegen", exact: true }).click();
  await page.getByRole("textbox", { name: "Befehlsname" }).fill("neu");
  await page.getByRole("textbox", { name: "Antworttext" }).fill("Eine neue Antwort.");
  await page.getByRole("button", { name: "Zurück", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Speichern und wechseln", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("region", { name: "Eigenschaften von !neu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Antworttext" }).fill("Die bestehende Antwort wird bearbeitet.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => counts.patches).toBe(1);
  expect(counts.posts).toBe(1);
});

test("command editor error and response layouts stay aligned", async ({ page }) => {
  await mockDashboard(page);
  await openTextCommand(page, 1920, 1080);

  const insertVariable = page.getByRole("button", { name: "Variable einfügen", exact: true });
  const preview = page.locator(".text-command-response-fields > .ui-chat-preview");
  const desktopAlignment = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLElement>("#command-text");
    const label = document.querySelector<HTMLElement>(".command-template-editor .ui-template-text-field .mantine-InputWrapper-label");
    const button = document.querySelector<HTMLElement>(".text-command-editor .ui-template-text-field__insert-variable");
    const previewNode = document.querySelector<HTMLElement>(".text-command-response-fields > .ui-chat-preview");
    if (textarea === null || label === null || button === null || previewNode === null) throw new Error("Command response geometry is incomplete.");
    const rect = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    };
    return { textarea: rect(textarea), label: rect(label), button: rect(button), preview: rect(previewNode) };
  });
  expect(Math.abs((desktopAlignment.button.y + desktopAlignment.button.height / 2) - (desktopAlignment.label.y + desktopAlignment.label.height / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(desktopAlignment.preview.y - desktopAlignment.textarea.y)).toBeLessThanOrEqual(2);
  await expect(insertVariable).toBeVisible();
  await expect(preview).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  const narrowAlignment = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLElement>("#command-text");
    const previewNode = document.querySelector<HTMLElement>(".text-command-response-fields > .ui-chat-preview");
    const helper = document.querySelector<HTMLElement>("#command-text-description .ui-template-text-field__helper-row");
    if (textarea === null || previewNode === null || helper === null) throw new Error("Narrow command response geometry is incomplete.");
    const textareaBox = textarea.getBoundingClientRect();
    const previewBox = previewNode.getBoundingClientRect();
    return {
      textarea: { x: textareaBox.x, y: textareaBox.y, width: textareaBox.width, bottom: textareaBox.bottom },
      preview: { x: previewBox.x, y: previewBox.y, width: previewBox.width },
      helper: { clientWidth: helper.clientWidth, scrollWidth: helper.scrollWidth },
    };
  });
  expect(narrowAlignment.preview.y).toBeGreaterThanOrEqual(narrowAlignment.textarea.bottom);
  expect(Math.abs(narrowAlignment.preview.x - narrowAlignment.textarea.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(narrowAlignment.preview.width - narrowAlignment.textarea.width)).toBeLessThanOrEqual(2);
  expect(narrowAlignment.helper.scrollWidth).toBeLessThanOrEqual(narrowAlignment.helper.clientWidth);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "Befehl anlegen", exact: true }).click();
  const roleHeading = page.locator(".text-command-role .ui-section__heading");
  const roleTopBeforeError = await roleHeading.evaluate((element) => element.getBoundingClientRect().top);
  const helperRow = page.locator("#command-text-description .ui-template-text-field__helper-row");
  const responseErrorSlot = page.locator("#command-text-error");
  const normalGap = await helperRow.evaluate((element) => {
    const role = document.querySelector(".text-command-role .ui-section__heading");
    if (role === null) throw new Error("The role heading is missing.");
    return role.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
  expect(normalGap).toBeLessThanOrEqual(48);
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(responseErrorSlot).toBeVisible();
  const errorAlignment = await responseErrorSlot.evaluate((element) => {
    const helper = element.closest(".ui-template-text-field__helper-row");
    const icon = element.querySelector<HTMLElement>("[aria-hidden='true']");
    const message = element.querySelector<HTMLElement>(".ui-truncated-text");
    const role = document.querySelector(".text-command-role .ui-section__heading");
    if (!(helper instanceof HTMLElement) || icon === null || message === null || role === null) throw new Error("The response error geometry is incomplete.");
    return {
      errorTop: element.getBoundingClientRect().top,
      helperTop: helper.getBoundingClientRect().top,
      iconRight: icon.getBoundingClientRect().right,
      messageLeft: message.getBoundingClientRect().left,
      roleTop: role.getBoundingClientRect().top,
    };
  });
  expect(Math.abs(errorAlignment.errorTop - errorAlignment.helperTop)).toBeLessThanOrEqual(1);
  expect(errorAlignment.messageLeft).toBeGreaterThanOrEqual(errorAlignment.iconRight + 3);
  expect(Math.abs(errorAlignment.roleTop - roleTopBeforeError)).toBeLessThanOrEqual(1);

  const roleControlWidth = await page.locator(".text-command-role .ui-role-threshold .ui-select__trigger").evaluate((element) => element.getBoundingClientRect().width);
  const cooldownWidth = await page.locator(".text-command-cooldown .unit-input").evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(cooldownWidth - roleControlWidth)).toBeLessThanOrEqual(1);
});

test("FAQ mobile editor scrolls its final field above the fixed save bar", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/faq`);

  await expect(page.getByRole("heading", { name: "FAQ & Auto-Antworten", level: 1 })).toHaveCount(1);
  const search = page.locator(".faq-panel__toolbar-top input");
  const status = page.locator(".faq-panel__toolbar > .segment-choice-field");
  const searchStatusGap = await search.evaluate((element) => {
    const statusField = document.querySelector(".faq-panel__toolbar > .segment-choice-field");
    if (statusField === null) throw new Error("The FAQ status filter is missing.");
    return statusField.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
  expect(searchStatusGap).toBeLessThanOrEqual(18);
  await expect(status).toBeVisible();
  const orderNote = page.locator(".faq-panel__toolbar .ui-rule-note");
  const orderNoteGeometry = await orderNote.evaluate((element) => {
    const text = element.querySelector<HTMLElement>("div");
    if (text === null) throw new Error("The FAQ ordering note text is missing.");
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textHeight: text.getBoundingClientRect().height,
      textScrollHeight: text.scrollHeight,
      textWhiteSpace: getComputedStyle(text).whiteSpace,
    };
  });
  expect(orderNoteGeometry.scrollWidth).toBeLessThanOrEqual(orderNoteGeometry.clientWidth);
  expect(orderNoteGeometry.textHeight, JSON.stringify(orderNoteGeometry)).toBeGreaterThan(18);

  await page.locator(".faq-panel__entry").filter({ hasText: "Begrüßung" }).click();
  for (const selector of [".faq-panel__entry-name", ".faq-panel__sample-message"]) {
    const countGeometry = await page.locator(selector).evaluate((field) => {
      const hint = field.querySelector<HTMLElement>(".ui-field__hint");
      const count = field.querySelector<HTMLElement>(".ui-field__count");
      const description = field.querySelector<HTMLElement>(".ui-field__description");
      if (hint === null || count === null || description === null) throw new Error("FAQ helper or counter is missing.");
      return {
        hintBottom: hint.getBoundingClientRect().bottom,
        countTop: count.getBoundingClientRect().top,
        countRight: count.getBoundingClientRect().right,
        descriptionRight: description.getBoundingClientRect().right,
      };
    });
    expect(countGeometry.countTop).toBeGreaterThanOrEqual(countGeometry.hintBottom);
    expect(countGeometry.countRight).toBeLessThanOrEqual(countGeometry.descriptionRight + 1);
  }
  const faqHeaderGeometry = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".faq-panel__detail > .page-header");
    const testAction = document.querySelector<HTMLElement>(".faq-panel__detail .page-header__page-actions > button");
    const firstSection = document.querySelector<HTMLElement>(".faq-panel__editor .faq-panel__editor-grid > .faq-panel__column > .ui-section");
    if (header === null || testAction === null || firstSection === null) throw new Error("The FAQ editor header geometry is incomplete.");
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      actionBottom: testAction.getBoundingClientRect().bottom,
      sectionTop: firstSection.getBoundingClientRect().top,
    };
  });
  expect(faqHeaderGeometry.sectionTop).toBeGreaterThanOrEqual(faqHeaderGeometry.headerBottom);
  expect(faqHeaderGeometry.sectionTop).toBeGreaterThanOrEqual(faqHeaderGeometry.actionBottom);
  const back = page.locator(".collection-page__detail-back");
  await expect(back).toBeVisible();
  const backGeometry = await back.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const detail = element.closest(".collection-page__detail");
    if (!(detail instanceof HTMLElement)) throw new Error("The FAQ detail pane is missing.");
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, detailX: detail.getBoundingClientRect().x };
  });
  expect(Math.abs(backGeometry.x - backGeometry.detailX)).toBeLessThanOrEqual(1);
  expect(backGeometry.height).toBeGreaterThanOrEqual(44);

  const games = page.getByRole("switch", { name: "Spiele" });
  if (await games.getAttribute("aria-checked") !== "true") await games.click();
  const editor = page.locator(".faq-panel__editor");
  const lastField = editor.locator(".ui-game-multi-select").last();
  await expect(lastField).toBeVisible();
  await editor.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const finalGeometry = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".faq-panel__editor");
    const target = scroller?.querySelector<HTMLElement>(".ui-game-multi-select");
    const saveBar = document.querySelector<HTMLElement>(".faq-panel__detail .page-header__save");
    if (scroller === null || target == null || saveBar === null) throw new Error("The FAQ mobile scroll geometry is incomplete.");
    const scrollBox = scroller.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const saveBox = saveBar.getBoundingClientRect();
    return {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      targetTop: targetBox.top,
      targetBottom: targetBox.bottom,
      scrollTopEdge: scrollBox.top,
      scrollBottomEdge: scrollBox.bottom,
      saveTop: saveBox.top,
    };
  });
  expect(finalGeometry.scrollHeight).toBeGreaterThan(finalGeometry.clientHeight);
  expect(finalGeometry.scrollTop).toBeGreaterThan(0);
  expect(finalGeometry.targetTop).toBeGreaterThanOrEqual(finalGeometry.scrollTopEdge - 1);
  expect(finalGeometry.targetBottom).toBeLessThanOrEqual(Math.min(finalGeometry.scrollBottomEdge, finalGeometry.saveTop) - 8);

  const faqCounterFont = await page.locator(".faq-panel__entry-name .ui-field__count").evaluate((element) => getComputedStyle(element).fontFamily);
  const faqTemplateCounter = page.locator(".faq-panel__detail .ui-template-text-field__count").first();
  const faqPreviewCounter = page.locator(".faq-panel__detail .ui-chat-preview__count").first();
  expect(await faqTemplateCounter.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(faqCounterFont);
  expect(await faqPreviewCounter.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(faqCounterFont);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/text_commands`);
  await page.locator(".text-command-row").filter({ hasText: "!hallo" }).click();
  const commandBack = page.locator(".collection-page__detail-back");
  const commandBackGeometry = await commandBack.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const detail = element.closest(".collection-page__detail");
    if (!(detail instanceof HTMLElement)) throw new Error("The command detail pane is missing.");
    return { x: bounds.x, height: bounds.height, detailX: detail.getBoundingClientRect().x };
  });
  expect(Math.abs(commandBackGeometry.x - commandBackGeometry.detailX)).toBeLessThanOrEqual(1);
  expect(commandBackGeometry.height).toBeGreaterThanOrEqual(44);
});
