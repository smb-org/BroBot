import { expect, test, type Page } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-537-layout";
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
const cockpitModules = ["ads", "timers", "belabox", "clips"].map((id) => ({ id, enabled: true, settings: "{}" }));

const rect = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`No box for ${selector}`);
  return box;
};

test.describe("live cockpit", () => {
  test("the header keeps its height while the BELABOX status changes at 1440px", async ({ page }) => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await installLiveCockpitMocks(page, { channelId, role: "manager", modules: cockpitModules });
    await page.route(`**/api/channels/${channelId}/modules/belabox/status`, async (route) => {
      await gate;
      await route.fallback();
    });
    await page.goto(`/channels/${channelId}`);
    const indicators = page.locator(".live-cockpit-header__indicators");
    await expect(indicators.locator(".status-led").filter({ hasText: "BELABOX" })).toBeVisible();
    await waitForWebFonts(page);
    const pending = { header: await rect(page, ".live-cockpit-header"), wall: await rect(page, ".live-cockpit__wall"), row: await rect(page, ".live-cockpit-header__indicators") };
    release();
    await expect(indicators.getByLabel(/BELABOX · .*kbit/u)).toBeVisible();
    await waitForWebFonts(page);
    const settled = { header: await rect(page, ".live-cockpit-header"), wall: await rect(page, ".live-cockpit__wall"), row: await rect(page, ".live-cockpit-header__indicators") };
    expect(settled.header.height).toBe(pending.header.height);
    expect(settled.wall.y).toBe(pending.wall.y);
    expect(settled.row.height).toBeLessThanOrEqual(24);
    // Text that gets shortened still has its full text as the title.
    for (const led of await indicators.locator(".status-led").all()) {
      await expect(led).toHaveAttribute("title", /\S/u);
    }
  });

  for (const [width, height] of [[1440, 900], [1920, 1080]] as const) {
    test(`the cockpit ends at the bottom edge without an empty band at ${String(width)}x${String(height)}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await installLiveCockpitMocks(page, { channelId, role: "manager", modules: cockpitModules });
      await page.goto(`/channels/${channelId}`);
      await expect(page.locator(".live-cockpit__status")).toBeVisible();
      await waitForWebFonts(page);
      const status = await rect(page, ".live-cockpit__status");
      expect(height - (status.y + status.height)).toBeLessThanOrEqual(20);
    });
  }

  test("a single Next up entry sits at the top of its area and tall screens get taller action tracks", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await installLiveCockpitMocks(page, {
      channelId,
      role: "manager",
      modules: cockpitModules,
      upcomingTimers: [{ id: "timer-1", name: "Zeitplan 1", enabled: true, nextRunAt: new Date(Date.now() + 120_000).toISOString() }],
    });
    await page.goto(`/channels/${channelId}`);
    const item = page.locator(".live-cockpit-next-item").first();
    await expect(item).toBeVisible();
    await waitForWebFonts(page);
    const [textBox, listBox] = await Promise.all([
      item.locator(".live-cockpit-next-item__copy strong").boundingBox(),
      page.locator(".live-cockpit-next-list").last().boundingBox(),
    ]);
    if (textBox === null || listBox === null) throw new Error("Expected boxes.");
    expect(textBox.y - listBox.y).toBeLessThanOrEqual(8);
    expect((await rect(page, ".live-action")).height).toBeGreaterThan(103);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await rect(page, ".live-action")).height).toBe(103);
  });
});

test("the vote colour popover has no empty block under the hex field", async ({ page }) => {
  const template = {
    id: "t537", channelId: "channel-a", shortcut: "dinner", title: "Dinner choice", resultText: "{vote.result}", labels: ["Pizza", "Burger", "Pasta"],
    answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null,
    lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z",
  };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/modules/chat_voting/templates")) return route.fulfill(json({ templates: [template], count: 1, maximum: 100 }));
    if (pathname.endsWith("/template-variables")) return route.fulfill(json({ variables: [] }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "x" }));
    return route.fulfill(json({}));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=chat_voting&lang=de");
  await expect(page.getByRole("button", { name: /Farbe für Antwort 1/u })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const answer of [1, 3]) {
    await page.getByRole("button", { name: `Farbe für Antwort ${String(answer)}` }).click();
    const popover = page.getByRole("dialog", { name: `Farbe für Antwort ${String(answer)}` });
    await expect(popover).toBeVisible();
    await waitForWebFonts(page);
    const [popoverBox, fieldBox, saveBox] = await Promise.all([
      popover.boundingBox(),
      popover.locator(".chat-voting-editor__color-field").boundingBox(),
      page.locator(".ui-save-bar").first().boundingBox(),
    ]);
    if (popoverBox === null || fieldBox === null || saveBox === null) throw new Error("Expected boxes.");
    expect(fieldBox.height).toBeLessThanOrEqual(64);
    expect(popoverBox.height).toBeLessThanOrEqual(210);
    const overlapsSaveBar = popoverBox.y < saveBox.y + saveBox.height && saveBox.y < popoverBox.y + popoverBox.height
      && popoverBox.x < saveBox.x + saveBox.width && saveBox.x < popoverBox.x + popoverBox.width;
    expect(overlapsSaveBar, "colour popover covers the save bar").toBe(false);
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  }
});

test.describe("test area", () => {
  const testChannel = "kanal-537-test-area";
  const response = (controls: { muted: boolean; paused: boolean }) => ({
    evaluatedAt: "2030-01-01T12:01:00.000Z",
    controls,
    sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
    modules: [{
      moduleId: "text_commands",
      status: "reacts",
      entries: [{
        moduleId: "text_commands",
        entry: { kind: "text_command", id: "discord", label: "!discord" },
        outcome: "fires",
        match: { kind: "alias", token: "dc" },
        blocks: [],
        effects: [{ kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only", postsTo: "this_chat", reply: true, suppressedBy: null, automated: true }],
        templateNotes: [],
      }],
    }],
  });

  for (const [width, height] of [[821, 800], [1280, 800], [1920, 1080]] as const) {
    test(`the result header keeps its counter and badges and does not move the rows at ${String(width)}px`, async ({ page }) => {
      let controls = { muted: false, paused: false };
      await installLiveCockpitMocks(page, { channelId: testChannel, role: "manager", streamState: "online", modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
      await page.route(`**/api/channels/${testChannel}/dry-run`, (route) => route.fulfill(json(response(controls))));
      await page.setViewportSize({ width, height });
      await page.goto(`/channels/${testChannel}/test-area`);
      await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
      const run = async (): Promise<void> => {
        await page.locator(".test-area__context-form input[type=text]").first().fill("!discord");
        await page.locator(".test-area__context-form .test-area__run-button").click();
        await expect(page.locator(".test-area__result-row")).toHaveCount(1);
        await waitForWebFonts(page);
      };
      await run();
      const plain = await rect(page, ".test-area__result-row");
      const head = await rect(page, ".test-area__results-head");
      expect(plain.y - (head.y + head.height)).toBeLessThanOrEqual(16);
      controls = { muted: true, paused: true };
      await page.locator(".test-area__context-form input[type=text]").first().fill("!discord ");
      await page.locator(".test-area__context-form .test-area__run-button").click();
      await expect(page.locator(".test-area__results-title-copy").getByText("Pausiert")).toBeVisible();
      await waitForWebFonts(page);
      expect((await rect(page, ".test-area__result-row")).y).toBe(plain.y);
      const clipped = await page.locator(".test-area__results-title-copy").evaluate((copy) => {
        const copyBox = copy.getBoundingClientRect();
        return [...copy.children].filter((child) => {
          const box = child.getBoundingClientRect();
          return box.width > 0 && (box.right > copyBox.right + 0.5 || (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth + 0.5);
        }).map((child) => child.textContent);
      });
      expect(clipped).toEqual([]);
    });
  }
});

for (const [locale, label] of [["de-DE", "German"], ["en-US", "English"]] as const) {
  test.describe(`test area mixed outcomes (${label})`, () => {
    test.use({ locale });
    const mixedChannel = "kanal-537-test-area-mixed";
    const entry = (id: string, outcome: "fires" | "blocked" | "indeterminate") => ({
      moduleId: "text_commands",
      entry: { kind: "text_command", id, label: `!${id}` },
      outcome,
      match: { kind: "alias", token: id },
      blocks: outcome === "blocked" ? [{ code: "text_commands.person_cooldown", detail: { remainingSeconds: 42 } }] : [],
      effects: outcome === "fires" ? [{ kind: "chat", text: "Hallo", target: "source_only", postsTo: "this_chat", reply: true, suppressedBy: null, automated: true }] : [],
      templateNotes: [],
    });
    const mixed = (controls: { muted: boolean; paused: boolean }) => ({
      evaluatedAt: "2030-01-01T12:01:00.000Z",
      controls,
      sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
      modules: [{ moduleId: "text_commands", status: "reacts", entries: [entry("eins", "fires"), entry("zwei", "blocked"), entry("drei", "indeterminate")] }],
    });

    for (const [width, height] of [[821, 800], [1280, 800], [1920, 1080]] as const) {
      test(`the header and rows stay put when Muted and Paused appear at ${String(width)}px`, async ({ page }) => {
        let controls = { muted: false, paused: false };
        await installLiveCockpitMocks(page, { channelId: mixedChannel, role: "manager", streamState: "online", modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
        await page.route(`**/api/channels/${mixedChannel}/dry-run`, (route) => route.fulfill(json(mixed(controls))));
        await page.setViewportSize({ width, height });
        await page.goto(`/channels/${mixedChannel}/test-area`);
        const input = page.locator(".test-area__context-form input[type=text]").first();
        await expect(input).toBeVisible();
        const run = async (text: string): Promise<void> => {
          await input.fill(text);
          await page.locator(".test-area__context-form .test-area__run-button").click();
          await expect(page.locator(".test-area__result-row")).toHaveCount(3);
          await waitForWebFonts(page);
        };
        await run("!eins");
        const before = { head: await rect(page, ".test-area__results-head"), row: await rect(page, ".test-area__result-row") };
        controls = { muted: true, paused: true };
        await run("!eins ");
        await expect(page.locator(".test-area__results-title-copy .ui-badge")).toHaveCount(2);
        await waitForWebFonts(page);
        const after = { head: await rect(page, ".test-area__results-head"), row: await rect(page, ".test-area__result-row") };
        expect(Math.abs(after.head.height - before.head.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.row.y - before.row.y)).toBeLessThanOrEqual(1);
        const clipped = await page.locator(".test-area__results-title-copy").evaluate((copy) => {
          const copyBox = copy.getBoundingClientRect();
          return [...copy.children].filter((child) => {
            const box = child.getBoundingClientRect();
            return box.width > 0 && (box.right > copyBox.right + 0.5 || box.bottom > copyBox.bottom + 0.5 || (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth + 0.5);
          }).map((child) => child.textContent);
        });
        expect(clipped).toEqual([]);
      });
    }
  });
}

test("shell and protokoll: nothing covers the selected nav row, the header spans the rows", async ({ page }) => {
  const auditChannel = "kanal-537-audit";
  const entries = Array.from({ length: 4 }, (_, index) => ({
    auditId: `a${String(index)}`, actorUserId: "m1", actorLogin: null, actorDisplayName: "Mira Fox", actorKind: "member",
    createdAt: new Date(Date.now() - (5 + index * 700) * 60_000).toISOString(), moduleId: null, action: "member.role_changed",
    before: JSON.stringify({ role: "manager" }), after: JSON.stringify({ role: "operator" }), subjectUserId: `s${String(index)}`, subjectLogin: `p${String(index)}`, subjectDisplayName: `Person ${String(index)}`,
  }));
  await installLiveCockpitMocks(page, { channelId: auditChannel, role: "manager", modules: [] });
  await page.route(`**/api/channels/${auditChannel}/audit-log`, (route) => route.fulfill(json({ entries, nextCursor: null })));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${auditChannel}/audit`);
  await expect(page.locator(".audit-sentence-list tbody tr").nth(1)).toBeVisible();
  await waitForWebFonts(page);
  const selected = await rect(page, ".sidebar-nav-link[aria-current=page]");
  const footer = await rect(page, ".sidebar__footer");
  expect(selected.y + selected.height).toBeLessThanOrEqual(footer.y);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".audit-sentence-list thead")).toBeVisible();
  const [headBox, rowBox] = await Promise.all([rect(page, ".audit-sentence-list thead tr"), rect(page, ".audit-sentence-list tbody tr:not(.data-table__day-row)")]);
  expect(headBox.width).toBeCloseTo(rowBox.width, 0);
  expect(headBox.x).toBeCloseTo(rowBox.x, 0);
});
