import { expect, test, type Route } from "@playwright/test";

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
  { width: 2560, height: 1440 },
] as const;

const fulfillJson = async (route: Route, value: unknown): Promise<void> => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
};

for (const viewport of viewports) {
  test(`voting collection and settings do not overlap and answer controls align at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize(viewport.width <= 935 ? { width: 1440, height: 900 } : viewport);
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const activeModules = [{ moduleId: "chat_voting", settings: JSON.stringify(settings) }];
      if (pathname === "/api/channels") {
        await fulfillJson(route, { channels: [channel], viewerUserId: "fixture-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false });
      } else if (pathname === `/api/channels/${channelId}/overview`) {
        await fulfillJson(route, { ...channel, activeModules, streamState: "online", streamStartedAt: timestamp, viewerCount: 18, location: null });
      } else if (pathname === `/api/channels/${channelId}/modules`) {
        await fulfillJson(route, { modules: channel.modules });
      } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
        await fulfillJson(route, { templates: [template], count: 1, maximum: 100 });
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
    await page.goto(`/channels/${channelId}/modules/chat_voting`, { waitUntil: "domcontentloaded" });

    const collection = page.locator(".collection-page");
    const settingsEditor = page.locator(".ui-editor-shell");
    const inspector = page.locator(".chat-voting-template-inspector");
    await expect(inspector.getByRole("textbox", { name: "Frage" })).toHaveValue(template.title);
    if (viewport.width <= 935) {
      await page.setViewportSize(viewport);
      await expect(inspector).toBeVisible();
    }
    await expect(collection).toBeVisible();
    await expect(settingsEditor).toBeVisible();
    await expect(inspector).toBeVisible();
    const editorBody = inspector.locator(".chat-voting-editor__body");
    const editorBodyLayout = await editorBody.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      inspectorBottom: (element.parentElement?.getBoundingClientRect().bottom ?? 0) + window.scrollY,
    }));
    expect(editorBodyLayout.scrollHeight).toBeLessThanOrEqual(editorBodyLayout.clientHeight + 1);
    const collectionBottom = await collection.evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
    const settingsTop = await settingsEditor.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    expect(settingsTop).toBeGreaterThanOrEqual(collectionBottom - 1);
    expect(settingsTop).toBeGreaterThanOrEqual(editorBodyLayout.inspectorBottom - 1);
    const editorOverlap = await page.evaluate(() => {
      const settings = document.querySelector(".ui-editor-shell")?.getBoundingClientRect();
      const inspector = document.querySelector(".chat-voting-template-inspector")?.getBoundingClientRect();
      if (settings === undefined || inspector === undefined) throw new Error("The settings editor or vote editor is missing.");
      return settings.left < inspector.right && settings.right > inspector.left && settings.top < inspector.bottom && settings.bottom > inspector.top;
    });
    expect(editorOverlap).toBe(false);

    const answerLayouts = await inspector.locator(".chat-voting-editor__answer").evaluateAll((rows) => rows.map((row) => {
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
    const customDuration = durationSlot.locator(".unit-input");
    await expect(customDuration).toBeVisible();
    const durationGap = await duration.evaluate((element) => {
      const segment = element.querySelector(".segment-choice");
      const input = element.querySelector(".unit-input");
      if (!(segment instanceof HTMLElement) || !(input instanceof HTMLElement)) throw new Error("The custom duration controls are missing.");
      return input.getBoundingClientRect().top - segment.getBoundingClientRect().bottom;
    });
    expect(durationGap).toBeLessThanOrEqual(12);
    expect(await durationSlot.evaluate((element) => element.getBoundingClientRect().height)).toBe(reservedDurationHeight);

    const answerRows = inspector.locator(".chat-voting-editor__answer");
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
      return {
        height: row.getBoundingClientRect().height,
        inputCenter: (inputBox.top + inputBox.bottom) / 2,
        removeCenter: (removeBox.top + removeBox.bottom) / 2,
      };
    });
    expect(Math.abs(afterDuplicate.height - beforeDuplicate.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterDuplicate.removeCenter - afterDuplicate.inputCenter)).toBeLessThanOrEqual(2);

    const votingSettings = page.locator(".chat-voting-settings-editor");
    await expect(votingSettings).toBeVisible();
    await expect(votingSettings.getByRole("button", { name: "Speichern", exact: true })).toHaveCount(1);
    const settingsGeometry = await votingSettings.evaluate((element) => {
      const style = getComputedStyle(element);
      const row = element.querySelector(".inspector-field-row");
      const label = row?.querySelector<HTMLElement>(".inspector-field-row__label");
      const input = row?.querySelector<HTMLElement>("input");
      const title = element.querySelector<HTMLElement>(".inspector-section__heading");
      const actions = element.querySelector<HTMLElement>(".ui-editor-shell__header-save .ui-save-bar__actions");
      if (row === null || label === null || label === undefined || input === null || input === undefined || title === null || actions === null) {
        throw new Error("The voting settings header or duration field is missing.");
      }
      const titleBox = title.getBoundingClientRect();
      const actionBox = actions.getBoundingClientRect();
      return {
        width: element.getBoundingClientRect().width,
        contentWidth: element.closest(".module-detail__content")?.getBoundingClientRect().width ?? 0,
        borderTopWidth: style.borderTopWidth,
        backgroundColor: style.backgroundColor,
        labelBottom: label.getBoundingClientRect().bottom,
        inputTop: input.getBoundingClientRect().top,
        headerCenterDifference: Math.abs((titleBox.top + titleBox.bottom) / 2 - (actionBox.top + actionBox.bottom) / 2),
        headerOverlap: titleBox.left < actionBox.right && titleBox.right > actionBox.left && titleBox.top < actionBox.bottom && titleBox.bottom > actionBox.top,
        titleBottom: titleBox.bottom,
        actionsTop: actionBox.top,
        saveBars: element.querySelectorAll(".ui-save-bar").length,
      };
    });
    expect(settingsGeometry.width).toBeGreaterThanOrEqual(settingsGeometry.contentWidth - 2);
    expect(settingsGeometry.borderTopWidth).toBe("0px");
    expect(settingsGeometry.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(settingsGeometry.labelBottom).toBeLessThanOrEqual(settingsGeometry.inputTop + 1);
    expect(settingsGeometry.headerOverlap).toBe(false);
    if (viewport.width <= 600) {
      expect(settingsGeometry.titleBottom).toBeLessThanOrEqual(settingsGeometry.actionsTop + 1);
    } else {
      expect(settingsGeometry.headerCenterDifference).toBeLessThanOrEqual(12);
    }
    expect(settingsGeometry.saveBars).toBe(1);

    await votingSettings.getByRole("tab", { name: "Nachrichten" }).click();
    const globalResultText = votingSettings.getByRole("textbox", { name: "Ergebnistext" });
    const globalWarnings = votingSettings.locator("#settings-resultText-warnings");
    await expect(globalResultText).toHaveValue(settings.resultText);
    await expect(globalWarnings).not.toContainText("Unbekannte Variable");
    await globalResultText.fill("{api.");
    await expect(page.getByRole("option", { name: /\{api\.score\}/u })).toBeVisible();

    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  });
}
