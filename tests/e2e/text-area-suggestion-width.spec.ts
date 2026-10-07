import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE" });

// Regression for the suggestion dropdown that rendered ~30px wide on
// staging: Mantine's Combobox defaults to width="target" and copies the
// width of its target element -- here a 1px caret-position anchor, not the
// textarea -- which overrides the `.ui-textarea__suggestions-dropdown` CSS
// width. See `src/dashboard/ui/TextArea.tsx`.

const channel = {
  channelId: "kanal-suggestion-width",
  login: "brotkrumen-kanal",
  displayName: "Brotkrumen-Kanal",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-suggestion-width", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

const routeApi = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/overview`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...channel, activeModules: [{ moduleId: "text_commands", settings: "{}" }] }),
      });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/modules`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] }),
      });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/modules/text_commands/commands`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [{
          channelId: channel.channelId,
          name: "hallo",
          text: "Hallo {user}",
          kind: "text",
          enabled: true,
          minimumTier: "everyone",
          cooldownSeconds: 5,
          aliases: [],
          userCooldownSeconds: 0,
          streamCondition: "any",
          responseType: "say",
          variableAction: null,
          useCount: 0,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }], variables: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

test("the template variable suggestion dropdown is wide enough on desktop and fits the viewport on phones", async ({ page }) => {
  await routeApi(page);
  const dropdown = page.locator(".ui-textarea__suggestions-dropdown");

  const openSuggestions = async (): Promise<void> => {
    await page.goto(`/channels/${channel.channelId}/modules/text_commands`);
    const commandRow = page.getByRole("row", { name: /!hallo/ });
    await expect(commandRow).toBeVisible();
    await commandRow.click();
    const responseField = page.getByRole("textbox", { name: "Antwort" });
    await expect(responseField).toBeVisible();
    await responseField.click();
    await page.keyboard.press("End");
    await page.keyboard.type("{");
    await expect(dropdown).toBeVisible();
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await openSuggestions();
  // `toBeVisible()` above can observe the dropdown between a spurious
  // close-and-reopen (a TextArea suggestion-query recompute racing the
  // dropdown's own open); poll the measurement itself instead of taking a
  // single snapshot, so a still-closing dropdown gets a retry instead of a
  // null/undersized bounding box.
  await expect.poll(async () => (await dropdown.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);

  // Fresh navigation resets the command's text, so the phone check starts
  // from the same pristine "Hallo {user}" instead of layering onto whatever
  // the desktop check typed.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSuggestions();
  await expect.poll(async () => {
    const box = await dropdown.boundingBox();
    if (box === null) return null;
    return box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
});

test("variable picker rows show readable sample values and align info icons", async ({ page }) => {
  await routeApi(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/channels/${channel.channelId}/modules/text_commands`);
    await page.getByRole("row", { name: /!hallo/ }).click();
    await page.getByRole("button", { name: "Variable einfügen" }).click();
    const samples = page.getByTestId("variable-sample");
    await expect(samples.first()).toBeVisible();
    const widths = await samples.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(Math.min(...widths)).toBeGreaterThan(24);
    const infoX = await page.locator(".ui-variable-picker__info").evaluateAll((nodes) => [...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().x)))]);
    expect(infoX).toHaveLength(1);
    const box = await page.locator(".ui-grouped-picker").boundingBox();
    if (width === 1280) expect(box?.width).toBeGreaterThanOrEqual(400);
    expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
    if (width === 1280) expect(Math.round((await page.locator(".ui-grouped-picker__popover").boundingBox())?.width ?? 0)).toBe(440);
  }
});
