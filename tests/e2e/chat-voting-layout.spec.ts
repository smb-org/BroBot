import { expect, test, type Page, type Route } from "@playwright/test";
import { waitForWebFonts } from "./web-fonts";

import { DEFAULT_CHAT_VOTING_SETTINGS, type ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "chat-voting-layout-channel";
const timestamp = new Date().toISOString();
const template: ChatVoteTemplate = {
  id: "template-layout",
  channelId,
  shortcut: "ideen",
  title: "Welche Idee soll unser Chat heute ausprobieren?",
  resultText: "Danke fürs Abstimmen! {vote.result}",
  labels: ["Pizza", "Burger", "Döner"],
  answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"],
  offerInCockpit: true,
  freeTextMode: null,
  durationSeconds: 120,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const settings = {
  ...DEFAULT_CHAT_VOTING_SETTINGS,
  resultText: "{vote.result} {var.score} {text.summary} {api.score}",
};
const registeredTemplateVariables = [
  { name: "var.score", moduleId: "host", isTextBlock: false, description: "Punktzahl", group: "channel", maxLength: 10, sample: "8", source: "channel", contexts: ["event"] },
  { name: "text.summary", moduleId: "text_library", isTextBlock: true, description: "Zusammenfassung", maxLength: 500, sample: "Zusammenfassung", contexts: ["event"] },
  { name: "api.score", moduleId: "api_source", isTextBlock: false, description: "Punktzahl", group: "api", maxLength: 100, sample: "8", source: "module", contexts: ["event"] },
];
const channel = {
  channelId,
  login: "musterkanal",
  displayName: "Musterkanal",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "fixture-subscription", reason: null, updatedAt: timestamp },
  chatSubscriptionNeeded: false,
  modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
  tokens: { botExpiresAt: "2099-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-01-01T00:00:00.000Z" },
  lastError: null,
};
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
  { width: 2560, height: 1440 },
] as const;

const fulfillJson = async (route: Route, value: unknown): Promise<void> => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
};

const installVotingFixture = async (page: Page, role: "manager" | "operator" = "manager"): Promise<void> => {
  const channelForRole = { ...channel, role };
  const templates = Array.from({ length: 18 }, (_, index) => ({
    ...template,
    id: index === 0 ? template.id : `template-layout-${String(index)}`,
    title: index === 0 ? template.title : `Weitere Abstimmung ${String(index)}`,
  }));
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const activeModules = [{ moduleId: "chat_voting", settings: JSON.stringify(settings) }];
    if (pathname === "/api/channels") {
      await fulfillJson(route, { channels: [channelForRole], viewerUserId: "fixture-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await fulfillJson(route, { ...channelForRole, activeModules, streamState: "online", streamStartedAt: timestamp, viewerCount: 18, location: null });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await fulfillJson(route, { modules: channel.modules });
    } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      await fulfillJson(route, { templates, count: templates.length, maximum: 100 });
    } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) {
      await fulfillJson(route, { vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 });
    } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/settings`) {
      await fulfillJson(route, { settings, revision: 1, variables: [{ name: "score", value: 8, description: "Punktzahl" }] });
    } else if (pathname === `/api/channels/${channelId}/settings`) {
      await fulfillJson(route, { timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 });
    } else if (pathname === `/api/channels/${channelId}/template-variables`) {
      await fulfillJson(route, { variables: registeredTemplateVariables });
    } else if (pathname === `/api/channels/${channelId}/template-preview`) {
      await fulfillJson(route, { text: "" });
    } else if (pathname === `/api/channels/${channelId}/overlays`) {
      await fulfillJson(route, { overlays: [], maximum: 20, elementMaximum: 20 });
    } else if (pathname === `/api/channels/${channelId}/events`) {
      await fulfillJson(route, { entries: [], nextCursor: null });
    } else if (pathname === `/api/channels/${channelId}/revisions`) {
      await fulfillJson(route, { revisions: {} });
    } else if (pathname === "/api/csrf") {
      await fulfillJson(route, { token: "fixture-csrf" });
    } else {
      await fulfillJson(route, {});
    }
  });
};

for (const viewport of viewports) {
  test(`voting tabs and scroll columns fit at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize(viewport.width <= 935 ? { width: 1440, height: 900 } : viewport);
    await installVotingFixture(page);
    await page.goto(`/channels/${channelId}/modules/chat_voting`, { waitUntil: "domcontentloaded" });

    const pageHeader = page.locator(".module-detail--chat_voting > .page-header");
    const tabs = page.getByRole("tab", { name: "Abstimmungen", exact: true });
    const collection = page.locator(".collection-page");
    const inspector = page.locator(".chat-voting-template-inspector");
    const settingsEditor = page.locator(".chat-voting-settings-editor");
    await expect(tabs).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Einstellungen", exact: true })).toBeVisible();
    await expect(collection).toBeVisible();
    await expect(settingsEditor).toHaveCount(0);
    await expect(inspector.getByRole("textbox", { name: "Frage" })).toHaveValue(template.title);
    if (viewport.width <= 935) await page.setViewportSize(viewport);
    await expect(inspector.getByRole("textbox", { name: "Frage" })).toHaveValue(template.title);

    await waitForWebFonts(page);
    const collectionLayout = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".module-detail--chat_voting > .page-header");
      const tabList = document.querySelector<HTMLElement>(".chat-voting-page-tabs__list");
      const collectionPage = document.querySelector<HTMLElement>(".collection-page");
      const list = document.querySelector<HTMLElement>(".collection-page__list-content");
      const detail = document.querySelector<HTMLElement>(".collection-page__detail");
      const editorBody = document.querySelector<HTMLElement>(".chat-voting-editor__body");
      const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
      if (header === null || tabList === null || collectionPage === null || list === null || detail === null || editorBody === null || main === null) {
        throw new Error("The voting header, tabs, collection columns, or dashboard scroller are missing.");
      }
      const headerBox = header.getBoundingClientRect();
      const tabsBox = tabList.getBoundingClientRect();
      const collectionBox = collectionPage.getBoundingClientRect();
      const mainStyle = getComputedStyle(main);
      return {
        headerBottom: headerBox.bottom,
        tabsWithinHeader: tabsBox.top >= headerBox.top && tabsBox.bottom <= headerBox.bottom + 1,
        collectionTop: collectionBox.top,
        listOverflow: getComputedStyle(list).overflowY,
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
        detailOverflow: getComputedStyle(detail).overflowY,
        editorBodyOverflow: getComputedStyle(editorBody).overflowY,
        mainOverflow: mainStyle.overflowY,
        mainScrollHeight: main.scrollHeight,
        mainClientHeight: main.clientHeight,
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(collectionLayout.tabsWithinHeader).toBe(true);
    expect(collectionLayout.collectionTop).toBeGreaterThanOrEqual(collectionLayout.headerBottom - 1);
    expect(collectionLayout.listOverflow).toBe("auto");
    if (viewport.width > 935) expect(collectionLayout.listScrollHeight).toBeGreaterThan(collectionLayout.listClientHeight);
    expect(collectionLayout.detailOverflow).toBe("auto");
    expect(collectionLayout.editorBodyOverflow).toBe("auto");
    expect(collectionLayout.mainOverflow).toBe("auto");
    expect(collectionLayout.mainScrollHeight).toBeLessThanOrEqual(collectionLayout.mainClientHeight + 1);
    expect(collectionLayout.documentHeight).toBeLessThanOrEqual(collectionLayout.viewportHeight + 1);
    // The tabs and the chat commands button wrap instead of overflowing sideways on narrow phones.
    expect(collectionLayout.documentWidth).toBeLessThanOrEqual(viewport.width);
    if (viewport.width <= 768) {
      // Same spot as on every other module page: left aligned right after the description, above the tabs.
      const chatButtonBox = await page.getByRole("button", { name: /^Chatbefehle/u }).boundingBox();
      const headerBox = await pageHeader.boundingBox();
      const tabListBox = await page.locator(".chat-voting-page-tabs__list").boundingBox();
      if (chatButtonBox === null || headerBox === null || tabListBox === null) throw new Error("The chat commands button, header, or tabs are missing.");
      expect(chatButtonBox.x).toBeCloseTo(headerBox.x, 0);
      expect(tabListBox.y).toBeGreaterThanOrEqual(chatButtonBox.y + chatButtonBox.height);
    } else {
      // Same spot as on the clips page: rightmost in the header, with the tabs to its left.
      const chatButtonBox = await page.getByRole("button", { name: /^Chatbefehle/u }).boundingBox();
      const headerBox = await pageHeader.boundingBox();
      const tabListBox = await page.locator(".chat-voting-page-tabs__list").boundingBox();
      if (chatButtonBox === null || headerBox === null || tabListBox === null) throw new Error("The chat commands button, header, or tabs are missing.");
      expect(chatButtonBox.x + chatButtonBox.width).toBeCloseTo(headerBox.x + headerBox.width, 0);
      expect(tabListBox.x + tabListBox.width).toBeLessThanOrEqual(chatButtonBox.x);
    }

    const moduleHeaderBox = await pageHeader.boundingBox();
    const tabBox = await page.locator(".chat-voting-page-tabs__list").boundingBox();
    if (viewport.width > 935) {
      await collection.locator(".collection-page__list-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(async () => collection.locator(".collection-page__list-content").evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    } else {
      const inspectorHeader = inspector.locator(":scope > .page-header");
      const inspectorHeaderBox = await inspectorHeader.boundingBox();
      await inspector.locator(".chat-voting-editor__body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(async () => inspector.locator(".chat-voting-editor__body").evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(await inspectorHeader.boundingBox()).toEqual(inspectorHeaderBox);
    }
    expect(await pageHeader.boundingBox()).toEqual(moduleHeaderBox);
    expect(await page.locator(".chat-voting-page-tabs__list").boundingBox()).toEqual(tabBox);

    const answerRows = inspector.locator(".chat-voting-editor__answer");
    const answerLayouts = await answerRows.evaluateAll((rows) => rows.map((row) => {
      const input = row.querySelector(".ui-field__input");
      const remove = row.querySelector("button");
      if (!(input instanceof HTMLElement) || !(remove instanceof HTMLElement)) throw new Error("An answer input or remove button is missing.");
      const inputBox = input.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();
      return { inputTop: inputBox.top, inputBottom: inputBox.bottom, inputCenter: (inputBox.top + inputBox.bottom) / 2, removeCenter: (removeBox.top + removeBox.bottom) / 2 };
    }));
    for (const layout of answerLayouts) expect(Math.abs(layout.removeCenter - layout.inputCenter)).toBeLessThanOrEqual(2);
    for (let index = 0; index < answerLayouts.length - 1; index += 1) {
      const current = answerLayouts[index];
      const next = answerLayouts[index + 1];
      if (current === undefined || next === undefined) throw new Error("An answer row is missing.");
      expect(next.inputTop - current.inputBottom).toBeLessThanOrEqual(28);
    }

    const duration = inspector.locator(".chat-voting-editor__duration-control");
    const durationSlot = duration.locator(".chat-voting-editor__duration-slot");
    await expect(durationSlot.locator(".unit-input")).toHaveCount(0);
    const reservedDurationHeight = await durationSlot.evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole("button", { name: "Eigene", exact: true }).click();
    await expect(durationSlot.locator(".unit-input")).toBeVisible();
    const durationGap = await duration.evaluate((element) => {
      const segment = element.querySelector(".segment-choice");
      const input = element.querySelector(".unit-input");
      if (!(segment instanceof HTMLElement) || !(input instanceof HTMLElement)) throw new Error("The custom duration controls are missing.");
      return input.getBoundingClientRect().top - segment.getBoundingClientRect().bottom;
    });
    expect(durationGap).toBeLessThanOrEqual(12);
    expect(await durationSlot.evaluate((element) => element.getBoundingClientRect().height)).toBe(reservedDurationHeight);

    const duplicateRow = answerRows.nth(1);
    const duplicateInput = duplicateRow.getByRole("textbox", { name: "Antwort 2" });
    const beforeDuplicate = await duplicateRow.boundingBox();
    if (beforeDuplicate === null) throw new Error("The second answer row is not measurable.");
    await duplicateInput.fill("Pizza");
    await expect(duplicateRow.locator(".ui-field__error[role=alert]")).toBeVisible();
    const afterDuplicate = await duplicateRow.evaluate((row) => {
      const input = row.querySelector(".ui-field__input");
      const remove = row.querySelector("button");
      if (!(input instanceof HTMLElement) || !(remove instanceof HTMLElement)) throw new Error("The answer input or remove button is missing.");
      const inputBox = input.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();
      return { height: row.getBoundingClientRect().height, inputCenter: (inputBox.top + inputBox.bottom) / 2, removeCenter: (removeBox.top + removeBox.bottom) / 2 };
    });
    expect(Math.abs(afterDuplicate.height - beforeDuplicate.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterDuplicate.removeCenter - afterDuplicate.inputCenter)).toBeLessThanOrEqual(2);

    await page.locator(".module-detail-heading .page-header__module-switch [role=switch]").click();
    await expect(page.getByRole("heading", { name: "Änderungen verwerfen?" })).toBeVisible();
    await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
    await page.getByRole("tab", { name: "Einstellungen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Änderungen verwerfen?" })).toBeVisible();
    await page.getByRole("button", { name: "Änderungen verwerfen", exact: true }).click();
    await expect(settingsEditor).toBeVisible();
    await expect(collection).toHaveCount(0);

    const settingsLayout = await settingsEditor.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const contentElement = element.closest<HTMLElement>(".module-detail__content");
      const style = getComputedStyle(element);
      const body = element.querySelector<HTMLElement>(".ui-editor-shell__body");
      const label = element.querySelector<HTMLElement>(".ui-field__label");
      const input = element.querySelector<HTMLElement>("input");
      if (contentElement === null || body === null || label === null || input === null) throw new Error("The full-width voting settings editor is missing its form or scroll body.");
      const content = contentElement.getBoundingClientRect();
      return {
        width: box.width,
        contentWidth: content.width,
        display: style.display,
        bodyOverflow: getComputedStyle(body).overflowY,
        labelBottom: label.getBoundingClientRect().bottom,
        inputTop: input.getBoundingClientRect().top,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
      };
    });
    expect(settingsLayout.width).toBeGreaterThanOrEqual(settingsLayout.contentWidth - 2);
    expect(settingsLayout.display).toBe("flex");
    expect(settingsLayout.bodyOverflow).toBe("auto");
    expect(settingsLayout.labelBottom).toBeLessThanOrEqual(settingsLayout.inputTop + 1);
    await settingsEditor.getByRole("tab", { name: "Nachrichten" }).click();
    const saveBar = settingsEditor.locator(".ui-editor-shell__header-save .ui-save-bar");
    await expect(saveBar).toBeVisible();
    const saveBox = await saveBar.boundingBox();
    const settingsBody = settingsEditor.locator(".ui-editor-shell__body");
    await settingsBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    if (settingsLayout.bodyScrollHeight > settingsLayout.bodyClientHeight) {
      await expect.poll(async () => settingsBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }
    expect(await saveBar.boundingBox()).toEqual(saveBox);
    const globalResultText = settingsEditor.getByRole("textbox", { name: "Ergebnistext" });
    const globalWarnings = settingsEditor.locator("#settings-resultText-warnings");
    await expect(globalResultText).toHaveValue(settings.resultText);
    await expect(globalWarnings).not.toContainText("Unbekannte Variable");
    await globalResultText.fill("{api.");
    await expect(page.getByRole("option", { name: /\{api\.score\}/u })).toBeVisible();
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  });
}

test("an operator sees one permission reason on the voting page and its settings tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVotingFixture(page, "operator");
  await page.goto(`/channels/${channelId}/modules/chat_voting`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".page-header__lock")).toHaveCount(1);
  await expect(page.locator(".list-toolbar__reason")).toHaveCount(0);
  await expect(page.locator(".ui-editor-shell__readonly-reason")).toHaveCount(0);
  await expect(page.getByText("Nur Broadcaster und Verwalter dürfen Abstimmungen bearbeiten.", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Einstellungen", exact: true }).click();
  await expect(page.locator(".chat-voting-settings-editor")).toBeVisible();
  await expect(page.locator(".page-header__lock")).toHaveCount(1);
  await expect(page.locator(".ui-editor-shell__readonly-reason")).toHaveCount(0);
});
