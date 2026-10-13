import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-460";
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
  chatSubscription: { status: "enabled", subscriptionId: "subscription-460", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};
const modules = [
  { id: "faq", enabled: true, settings: "{}" },
  { id: "ads", enabled: true, settings: "{}" },
];
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

const mockDashboard = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-460" }));
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({ ...channel, activeModules: modules.map(({ id, settings }) => ({ moduleId: id, settings })) }));
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (pathname === `/api/channels/${channelId}/modules` && route.request().method() === "GET") {
      return route.fulfill(json({ modules }));
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/settings`) {
      return route.fulfill(json({
        settings: {
          automatic: "Werbung startet bald.",
          manual: "Werbung läuft.",
          automaticTarget: "source_only",
          manualTarget: "source_only",
          prewarning: true,
          leadSeconds: 60,
          prewarningText: "Werbung in {ads.seconds} Sekunden.",
          prewarningTarget: "source_only",
        },
        revision: 1,
        variables: [],
      }));
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/schedule`) {
      return route.fulfill(json({ schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 0, snoozeRefreshAt: null }, snoozeScopeAvailable: true, recentAdBreaks: [] }));
    }
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    return route.fulfill(json({}));
  });
};

const box = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("The expected control is not visible.");
  return bounds;
};

const expectSameHeightAndCenter = async (control: Locator, action: Locator): Promise<void> => {
  const controlBounds = await box(control);
  const actionBounds = await box(action);
  expect(Math.abs(controlBounds.height - actionBounds.height)).toBeLessThanOrEqual(1);
  expect(actionBounds.width).toBeLessThan(controlBounds.width);
  expect(Math.abs(controlBounds.y - actionBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((controlBounds.y + controlBounds.height / 2) - (actionBounds.y + actionBounds.height / 2))).toBeLessThanOrEqual(1);
};

test("overview save actions match the control height and center line", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockDashboard(page);
  await page.goto(`/channels/${channelId}`);

  const timezoneRow = page.locator(".channel-overview-settings__row--timezone");
  const timezoneControl = timezoneRow.locator(".ui-select__search-input");
  const timezoneSave = timezoneRow.getByRole("button", { name: "Zeitzone speichern", exact: true });
  await expect(timezoneControl).toBeVisible();
  await expectSameHeightAndCenter(timezoneControl, timezoneSave);

  const chatTargetRow = page.locator(".channel-overview-settings__row").last();
  const chatTargetControl = chatTargetRow.locator(".ui-chat-target-field__trigger");
  const chatTargetSave = chatTargetRow.getByRole("button", { name: "Standard-Chat-Ziel speichern", exact: true });
  await expect(chatTargetControl).toBeVisible();
  await expectSameHeightAndCenter(chatTargetControl, chatTargetSave);

  const chatTargetLabel = chatTargetRow.locator(".inspector-field-row__label");
  const chatTargetLabelText = chatTargetLabel.locator(":scope > span").first();
  const chatTargetHelpIcon = chatTargetLabel.locator(".inspector-field-row__info");
  const labelBounds = await box(chatTargetLabelText);
  const helpBounds = await box(chatTargetHelpIcon);
  expect(Math.abs((labelBounds.y + labelBounds.height / 2) - (helpBounds.y + helpBounds.height / 2))).toBeLessThanOrEqual(1);
});

test("chat vote answer inputs retain visible control borders and surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-460" }));
    if (pathname === "/api/channels/channel-a/settings") {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (pathname === "/api/channels/channel-a/template-variables") return route.fulfill(json({ variables: [] }));
    if (pathname.endsWith("/modules/chat_voting/current")) {
      return route.fulfill(json({ vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60 }));
    }
    if (pathname.endsWith("/modules/chat_voting/templates")) return route.fulfill(json({ templates: [], count: 0, maximum: 100 }));
    return route.fulfill(json({}));
  });
  await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=chat_voting&lang=de");
  await page.locator(".chat-voting-list .segment-choice").waitFor();
  await page.locator(".chat-voting-list .list-toolbar__create button").click();
  await page.getByRole("textbox", { name: "Frage", exact: true }).waitFor();

  const ghostAnswers = page.locator(".chat-voting-editor__ghost-answers > span:nth-child(even)");
  await expect(ghostAnswers).toHaveCount(2);
  for (const answer of await ghostAnswers.all()) {
    const appearance = await answer.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return { borderWidth: style.borderTopWidth, background: style.backgroundColor, width: bounds.width, height: bounds.height };
    });
    expect(appearance.borderWidth).toBe("1px");
    expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(appearance.width).toBeGreaterThan(0);
    expect(appearance.height).toBeGreaterThanOrEqual(40);
  }

  await page.getByRole("button", { name: "Ja/Nein", exact: true }).click();
  const answers = page.locator(".chat-voting-editor__answer-list .ui-field__input");
  await expect(answers).toHaveCount(2);
  for (const answer of await answers.all()) {
    const appearance = await answer.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        borderColor: style.borderTopColor,
        background: style.backgroundColor,
        width: bounds.width,
        height: bounds.height,
      };
    });
    expect(appearance.borderWidth).toBe("1px");
    expect(appearance.borderStyle).toBe("solid");
    expect(appearance.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(appearance.width).toBeGreaterThan(0);
    expect(appearance.height).toBeGreaterThanOrEqual(32);
  }
});

test("mobile settings editor aligns help icons and top-aligns textarea text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDashboard(page);
  await page.goto(`/channels/${channelId}/modules/ads`);
  const editor = page.locator(".ui-settings-editor");
  await expect(editor).toBeVisible();

  const fieldLabel = editor.locator(".inspector-field-row__label").filter({ hasText: "Automatische Werbepause" }).first();
  const labelText = fieldLabel.locator(":scope > span").first();
  const helpIcon = fieldLabel.locator(".inspector-field-row__info");
  const labelBounds = await box(labelText);
  const helpBounds = await box(helpIcon);
  expect(Math.abs((labelBounds.y + labelBounds.height / 2) - (helpBounds.y + helpBounds.height / 2))).toBeLessThanOrEqual(1);

  const textarea = editor.locator(".template-text-field__input").first();
  const textareaPaddingTop = await textarea.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
  expect(textareaPaddingTop).toBeLessThanOrEqual(16);
});

test("sidebar FAQ label stays single-line with a title and consistent row height", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockDashboard(page);
  await page.goto(`/channels/${channelId}/modules`);

  const links = page.locator(".sidebar .sidebar-nav-link");
  await expect(links.first()).toBeVisible();
  const rowHeights = await links.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(new Set(rowHeights).size).toBe(1);

  const faqLink = page.locator(".sidebar-nav-link--module-child").filter({ hasText: "FAQ & Auto-Antworten" });
  const faqLabel = faqLink.locator(".mantine-NavLink-label");
  await expect(faqLink).toBeVisible();
  await expect(faqLink).toHaveAttribute("title", "FAQ & Auto-Antworten");
  const labelGeometry = await faqLabel.evaluate((element) => ({
    whiteSpace: getComputedStyle(element).whiteSpace,
    textOverflow: getComputedStyle(element).textOverflow,
    overflow: getComputedStyle(element).overflow,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(labelGeometry.whiteSpace).toBe("nowrap");
  expect(labelGeometry.textOverflow).toBe("ellipsis");
  expect(labelGeometry.overflow).toBe("hidden");
  expect(labelGeometry.scrollWidth).toBeGreaterThan(labelGeometry.clientWidth);
});
