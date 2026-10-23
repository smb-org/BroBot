import { expect, test, type Page, type Route } from "@playwright/test";
import { waitForWebFonts } from "./web-fonts";

import { DEFAULT_CHAT_VOTING_SETTINGS, type ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-432-voting-layout";
const timestamp = "2030-01-01T12:00:00.000Z";
const baseTemplate: ChatVoteTemplate = {
  id: "vote-layout-a",
  channelId,
  shortcut: "idee",
  title: "Welche Idee gewinnt?",
  resultText: "{vote.result}",
  labels: ["Pizza", "Burger"],
  answerColors: ["#5b8cff", "#ff9f43"],
  offerInCockpit: true,
  freeTextMode: null,
  durationSeconds: 120,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const channel = {
  channelId,
  login: "voting-layout",
  displayName: "Abstimmungs Layout",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "voting-layout-sub", reason: null, updatedAt: timestamp },
  chatSubscriptionNeeded: false,
  modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};

const fulfillJson = (route: Route, value: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

const installVotingFixture = async (page: Page, templateCount = 2): Promise<void> => {
  const templates = Array.from({ length: templateCount }, (_, index) => ({
    ...baseTemplate,
    id: index === 0 ? baseTemplate.id : `vote-layout-${String(index + 1)}`,
    title: index === 0 ? baseTemplate.title : `Weitere Abstimmung ${String(index + 1)}`,
  }));
  const settings = { ...DEFAULT_CHAT_VOTING_SETTINGS, autoCloseSeconds: 120 };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") return fulfillJson(route, { channels: [channel], viewerUserId: "viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false });
    if (pathname === `/api/channels/${channelId}/overview`) return fulfillJson(route, { ...channel, activeModules: [{ moduleId: "chat_voting", settings: JSON.stringify(settings) }] });
    if (pathname === `/api/channels/${channelId}/modules`) return fulfillJson(route, { modules: channel.modules });
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) return fulfillJson(route, { templates, count: templates.length, maximum: 100 });
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) return fulfillJson(route, { vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 });
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/settings`) return fulfillJson(route, { settings, revision: 1, variables: [] });
    if (pathname === `/api/channels/${channelId}/settings`) return fulfillJson(route, { timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 });
    if (pathname === `/api/channels/${channelId}/template-variables`) return fulfillJson(route, { variables: [] });
    if (pathname === `/api/channels/${channelId}/template-preview`) return fulfillJson(route, { text: "" });
    if (pathname === `/api/channels/${channelId}/overlays`) return fulfillJson(route, { overlays: [], maximum: 20, elementMaximum: 20 });
    if (pathname === "/api/csrf") return fulfillJson(route, { token: "csrf" });
    return fulfillJson(route, {});
  });
};

const roundedBox = async (locator: ReturnType<Page["locator"]>) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The compared layout element is not visible.");
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
};

test("both voting tabs keep the same page header geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installVotingFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const header = page.locator(".module-detail--chat_voting > .page-header");
  const title = header.getByRole("heading", { name: "Abstimmung" });
  const icon = header.locator(".page-header__icon");
  const tabs = header.locator(".chat-voting-page-tabs__list");
  await waitForWebFonts(page);
  const before = { header: await roundedBox(header), title: await roundedBox(title), icon: await roundedBox(icon), tabs: await roundedBox(tabs) };

  await page.getByRole("tab", { name: "Einstellungen", exact: true }).click();
  await expect(page.locator(".chat-voting-settings-editor")).toBeVisible();
  const after = { header: await roundedBox(header), title: await roundedBox(title), icon: await roundedBox(icon), tabs: await roundedBox(tabs) };
  expect(after).toEqual(before);
  await expect(header.locator(".ui-save-bar")).toHaveCount(0);
  await expect(page.locator(".chat-voting-settings-editor .ui-editor-shell__header-save .ui-save-bar")).toBeVisible();
});

test("voting settings use a compact duration input and transparent sub-tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installVotingFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  await page.getByRole("tab", { name: "Einstellungen", exact: true }).click();
  const duration = page.getByRole("spinbutton", { name: "Standarddauer" });
  const unitInput = duration.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' unit-input ')][1]");
  const durationBox = await unitInput.boundingBox();
  expect(durationBox).not.toBeNull();
  expect(durationBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(224);
  const subTabs = page.locator(".chat-voting-settings-editor .ui-editor-shell__tabs");
  await expect(subTabs).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(subTabs).toHaveCSS("border-bottom-width", "1px");
});

test("preset durations reserve only the compact custom field row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVotingFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const control = page.locator(".chat-voting-editor__duration-control");
  const slot = control.locator(".chat-voting-editor__duration-slot");
  const presetGeometry = await control.evaluate((element) => {
    const segment = element.querySelector<HTMLElement>(".segment-choice");
    const slotElement = element.querySelector<HTMLElement>(".chat-voting-editor__duration-slot");
    if (segment === null || slotElement === null) throw new Error("The duration preset and custom slot must render.");
    return {
      reservedBelowSegment: slotElement.getBoundingClientRect().bottom - segment.getBoundingClientRect().bottom,
      slotHeight: slotElement.getBoundingClientRect().height,
    };
  });
  expect(presetGeometry.reservedBelowSegment).toBeLessThanOrEqual(40);
  expect(presetGeometry.slotHeight).toBeLessThanOrEqual(32);
  await page.getByRole("button", { name: "Eigene", exact: true }).click();
  await expect(slot.locator(".unit-input")).toBeVisible();
  const customHeight = await slot.evaluate((element) => element.getBoundingClientRect().height);
  expect(customHeight).toBe(presetGeometry.slotHeight);
});

test("the selected saved vote surface spans the same width as every list row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVotingFixture(page, 2);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const selected = page.locator(".chat-voting-template-list .list-row--selected");
  const unselected = page.locator(".chat-voting-template-list .list-row:not(.list-row--selected)").first();
  await expect(selected).toBeVisible();
  const geometry = await Promise.all([selected.boundingBox(), unselected.boundingBox()]);
  if (geometry[0] === null || geometry[1] === null) throw new Error("Both voting rows must be measurable.");
  expect(Math.abs(geometry[0].width - geometry[1].width)).toBeLessThanOrEqual(1);
  await expect(selected).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(selected.locator(".list-row__link")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("one saved vote cannot scroll out into reserved blank space", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVotingFixture(page, 1);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const list = page.locator(".collection-page__list-content");
  const geometry = await list.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator(".chat-voting-template-list .list-row")).toBeInViewport();
});
