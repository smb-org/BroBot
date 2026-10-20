import { expect, test, type Page, type Route } from "@playwright/test";
import { blitzRoundDefaultsForLanguage, blitzTexts } from "../../src/modules/blitz_round/locale";
import { BLITZ_STARTER_WORDS } from "../../src/modules/blitz_round/seed-words";
import { dashboardTexts } from "../../src/dashboard/locale";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { blitzCaptureCatalog } from "./blitz-round.locale";
import type { BlitzQuestion } from "../../src/modules/blitz_round/contracts";

const question = (id: string, prompt: string, enabled = true): BlitzQuestion => ({
  id,
  revision: 1,
  kind: "quiz",
  prompt,
  answers: ["Saturn"],
  enabled,
  lastUsedAt: null,
  createdAt: "2030-01-01T12:00:00.000Z",
  updatedAt: "2030-01-01T12:00:00.000Z",
});

const routeJson = async (page: Page, path: string, value: unknown, method = "GET"): Promise<void> => {
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
};

const setupPanelRoutes = async (page: Page, initial: BlitzQuestion[], language: "de" | "en" = "en") => {
  const settings = blitzRoundDefaultsForLanguage(language);
  let questions = [...initial];
  let sequence = 0;
  await routeJson(page, "/api/csrf", { token: "fictional-csrf-token" });
  await routeJson(page, "/api/channels/fictional_channel/modules/blitz_round/settings", { settings, revision: 1 });
  await page.route("**/api/channels/fictional_channel/modules/blitz_round/questions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const search = (url.searchParams.get("q") ?? "").toLowerCase();
      const filtered = questions.filter((entry) => `${entry.prompt} ${entry.answers.join(" ")}`.toLowerCase().includes(search));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ questions: filtered, total: filtered.length, page: 1 }) });
      return;
    }
    if (request.method() === "POST") {
      const input = request.postDataJSON() as Omit<BlitzQuestion, "id" | "revision" | "lastUsedAt" | "createdAt" | "updatedAt">;
      const created = { ...input, id: `fictional-question-${String(++sequence)}`, revision: 1, lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z" };
      questions = [created, ...questions];
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ question: created }) });
      return;
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (request.method() === "PATCH") {
      const input = request.postDataJSON() as Omit<BlitzQuestion, "id" | "lastUsedAt" | "createdAt" | "updatedAt">;
      const existing = questions.find((entry) => entry.id === id);
      if (existing === undefined) throw new Error("question_missing");
      const updated = { ...existing, ...input, revision: existing.revision + 1, updatedAt: "2030-01-01T12:01:00.000Z" };
      questions = questions.map((entry) => entry.id === id ? updated : entry);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ question: updated }) });
      return;
    }
    if (request.method() === "DELETE") {
      questions = questions.filter((entry) => entry.id !== id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: true }) });
      return;
    }
    await route.fallback();
  });
  return { getQuestions: () => questions, setQuestions: (value: BlitzQuestion[]) => { questions = [...value]; } };
};

const gotoPanel = async (page: Page): Promise<void> => {
  await page.goto("/tests/e2e/blitz-round-fixture.html?lang=en");
  await expect(page.locator(".collection-page")).toBeVisible();
};

test("pool CRUD keeps collection geometry steady [protects=question creation, editing, disable and delete preserve the collection layout; fails_when=a mutation is lost or detail controls move with added feedback; no_claim=does not verify production authentication or external chat delivery]", async ({ page }) => {
  const pool = await setupPanelRoutes(page, [
    question("fictional-question-cloud", "Which planet has rings?"),
    question("fictional-question-lantern", "Which planet has the most visible rings?"),
  ]);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await gotoPanel(page);
    await expect(page.getByRole("button", { name: /Which planet has rings/ })).toBeVisible();
    const collection = page.locator(".collection-page__body");
    const geometryBefore = await collection.boundingBox();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText("Round settings", { exact: true })).toBeVisible();
    const startMessage = page.getByRole("textbox", { name: "Start message", exact: true });
    await expect(startMessage).toBeVisible();

    pool.setQuestions([]);
    await gotoPanel(page);
    await expect(page.getByText("Add a word scramble or quiz question so chat can join in.")).toBeVisible();
    pool.setQuestions([question("fictional-question-cloud", "Which planet has rings?")]);
    await page.reload();
    await expect(page.getByRole("button", { name: /Which planet has rings/ })).toBeVisible();

    await page.getByRole("button", { name: "New question", exact: true }).click();
    await page.getByRole("button", { name: "Quiz", exact: true }).click();
    const questionInput = page.getByRole("textbox", { name: "Question", exact: true });
    await questionInput.fill("Which star is closest?");
    const answers = page.getByRole("textbox", { name: "Accepted answers" });
    await answers.fill("Sun");
    await answers.press("Enter");
    const promptBounds = await questionInput.boundingBox();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /Which star is closest/ })).toBeVisible();
    const promptAfterSave = await questionInput.boundingBox();
    expect(promptAfterSave).toEqual(promptBounds);

    await questionInput.fill("Which nearby star is closest?");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /Which nearby star is closest/ })).toBeVisible();

    await page.getByRole("switch", { name: "Question enabled" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => pool.getQuestions().find((entry) => entry.prompt === "Which nearby star is closest?")?.enabled).toBe(false);

    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete this question?" }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("button", { name: /Which nearby star is closest/ })).toHaveCount(0);
    const geometryAfter = await collection.boundingBox();
    expect(geometryAfter?.x).toBe(geometryBefore?.x);
    expect(geometryAfter?.width).toBe(geometryBefore?.width);
  }
});

test("desktop question detail keeps title, save cluster, and actions in one header row [protects=Blitz detail header follows the FAQ and Punkte title-save-actions row at 1440 and 1920 pixels; fails_when=the save cluster or actions wrap below the title at desktop widths; no_claim=does not assess narrower layouts or keyboard navigation]", async ({ page }) => {
  await setupPanelRoutes(page, [question("fictional-header-question", "Which planet has rings?")]);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await gotoPanel(page);
    const header = page.locator(".blitz-panel__detail > .page-header");
    const title = header.getByRole("heading");
    const save = header.locator(".page-header__save");
    const actions = header.locator(".page-header__page-actions");
    const titleBounds = await title.boundingBox();
    const saveBounds = await save.boundingBox();
    const actionsBounds = await actions.boundingBox();
    expect(titleBounds).not.toBeNull();
    expect(saveBounds).not.toBeNull();
    expect(actionsBounds).not.toBeNull();
    expect(Math.abs((titleBounds?.y ?? 0) - (saveBounds?.y ?? 0))).toBeLessThan(20);
    expect(Math.abs((saveBounds?.y ?? 0) - (actionsBounds?.y ?? 0))).toBeLessThan(8);
    expect((titleBounds?.x ?? 0) + (titleBounds?.width ?? 0)).toBeLessThan(saveBounds?.x ?? 0);
    expect((saveBounds?.x ?? 0) + (saveBounds?.width ?? 0)).toBeLessThan(actionsBounds?.x ?? 0);
  }
});

test("cockpit action is hidden when disabled and locks enabled modules for running rounds or empty pools [protects=only enabled Blitz modules contribute an action and enabled actions display the required lock reason; fails_when=a disabled module contributes a tile or enabled modules lack their running-round or empty-pool lock; no_claim=does not prove the atomic DO open rejects a simultaneous start]", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/channels/fictional_channel/modules/blitz_round/availability", async (route: Route) => {
    const mode = new URL(page.url()).searchParams.get("reason");
    const reason = mode === "running" ? "round_running" : mode === "empty" ? "question_pool_empty" : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reason }) });
  });

  await page.goto("/tests/e2e/blitz-round-fixture.html?cockpit=1&enabled=0");
  const action = page.getByRole("button", { name: /Start Blitz Round/ });
  await expect(action).toHaveCount(0);
  await expect(page.locator(".live-cockpit-actions__count")).toHaveText("0 actions");

  await page.goto("/tests/e2e/blitz-round-fixture.html?cockpit=1&reason=running");
  const running = page.getByRole("button", { name: /Start Blitz Round/ });
  await expect(running).toBeDisabled();
  await expect(running).toContainText("Round is running");

  await page.goto("/tests/e2e/blitz-round-fixture.html?cockpit=1&reason=empty");
  const empty = page.getByRole("button", { name: /Start Blitz Round/ });
  await expect(empty).toBeDisabled();
  await expect(empty).toContainText("No questions in the pool");
});

test("cockpit reserves its scrollbar in the scroll owner [protects=compact cockpit header width and indicator rows stay stable when main content gains or loses vertical overflow; fails_when=the gutter is reserved on the document instead of the actual scroll container or overflow moves the header; no_claim=does not verify every OS scrollbar preference or production API]", async ({ page }) => {
  const channelId = "fictional-gutter-channel";
  await installLiveCockpitMocks(page, {
    channelId,
    channelBotStatus: "disconnected",
    location: null,
    modules: [{ id: "belabox", enabled: true, settings: "{}" }],
    belaboxStatus: { bitrateKbps: 500 },
  });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/channels/${channelId}?lang=en`);
  const main = page.locator(".dashboard-shell__main");
  const header = page.locator(".live-cockpit-header");
  const indicators = page.locator(".live-cockpit-header__indicators");
  await expect(indicators).toContainText("BELABOX · connected · 500 kbps");
  await expect(main).toHaveCSS("scrollbar-gutter", "stable");
  await expect(page.locator("html")).toHaveCSS("scrollbar-gutter", "auto");
  const headerPosition = await header.boundingBox();
  const indicatorPosition = await indicators.boundingBox();
  expect(await main.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await page.setViewportSize({ width: 768, height: 2000 });
  expect(await main.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(false);
  expect(await header.boundingBox()).toEqual(headerPosition);
  expect(await indicators.boundingBox()).toEqual(indicatorPosition);

  await page.setViewportSize({ width: 768, height: 900 });
  expect(await main.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await header.boundingBox()).toEqual(headerPosition);
  expect(await indicators.boundingBox()).toEqual(indicatorPosition);
});


test.describe("German dashboard captures", () => {
  test.use({ locale: "de-DE" });

  test("renders compact fields and stable type switching in the real dashboard shell [protects=German shell with Games navigation, one empty-state create action, Word-only scramble editing and FAQ field spacing at both desktop sizes; fails_when=shell or German labels are absent, create is duplicated, hidden answers shift the form, or reserved helper rows produce oversized gaps; no_claim=HTTP is mocked and these captures do not verify production authentication]", async ({ page }) => {
    const labels = blitzTexts("de");
    const content = blitzCaptureCatalog.de;
    const quiz = { ...question("fictional-capture-quiz", content.question), answers: [content.answer] };
    const scramble: BlitzQuestion = { ...question("fictional-capture-scramble", BLITZ_STARTER_WORDS[0]), kind: "scramble", answers: [BLITZ_STARTER_WORDS[0]] };
    await installLiveCockpitMocks(page, { channelId: "fictional_channel", modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "blitz_round", enabled: true, settings: JSON.stringify(blitzRoundDefaultsForLanguage("de")) },
    ] });
    const pool = await setupPanelRoutes(page, [quiz, scramble], "de");
    const path = "/channels/fictional_channel/modules/blitz_round";
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      pool.setQuestions([quiz, scramble]);
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.locator(".dashboard-shell__header")).toBeVisible();
      const games = page.locator('.sidebar__group[data-category="games"]');
      await expect(games.getByRole("heading", { name: dashboardTexts("de").navigation.moduleCategories.games, exact: true })).toBeVisible();
      await expect(games.locator('[aria-current="page"]')).toContainText(labels.title);
      const panel = page.locator(".blitz-panel");
      const prompt = panel.getByRole("textbox", { name: labels.prompt, exact: true });
      await expect(prompt).toHaveValue(content.question);
      await expect(panel.getByRole("textbox", { name: labels.acceptedAnswers, exact: true })).toBeVisible();
      const editor = panel.locator(".blitz-panel__editor");
      await expect(editor).toHaveCSS("row-gap", "12px");
      const typeField = editor.locator(":scope > .segment-choice-field");
      await expect(typeField.locator(".segment-choice-field__hint")).toBeHidden();
      await expect(typeField.locator(".segment-choice-field__warning")).toBeHidden();
      await expect(typeField.locator(".segment-choice-field__error")).toHaveCSS("height", "18px");
      const typeBounds = await typeField.boundingBox();
      const fieldBounds = await editor.locator(":scope > .ui-field").boundingBox();
      expect(typeBounds).not.toBeNull();
      expect(fieldBounds?.y).toBe((typeBounds?.y ?? 0) + (typeBounds?.height ?? 0) + 12);
      await page.screenshot({ path: `test-results/issue-503-ui/${String(viewport.width)}-list-detail.png` });

      const wordPosition = await prompt.boundingBox();
      const enabled = panel.getByRole("switch", { name: labels.enabled, exact: true });
      const enabledPosition = await enabled.boundingBox();
      const answerPosition = await panel.locator(".blitz-panel__answers").boundingBox();
      await panel.getByRole("button", { name: labels.scramble, exact: true }).click();
      await expect(panel.getByRole("textbox", { name: labels.word, exact: true })).toBeVisible();
      await expect(panel.getByRole("textbox", { name: labels.acceptedAnswers, exact: true })).toHaveCount(0);
      expect(await panel.getByRole("textbox", { name: labels.word, exact: true }).boundingBox()).toEqual(wordPosition);
      expect(await enabled.boundingBox()).toEqual(enabledPosition);
      expect(await panel.locator(".blitz-panel__answers").boundingBox()).toEqual(answerPosition);
      await panel.getByRole("button", { name: labels.discard, exact: true }).click();
      await panel.getByRole("button", { name: new RegExp(scramble.prompt) }).click();
      await expect(panel.getByRole("textbox", { name: labels.word, exact: true })).toHaveValue(scramble.prompt);
      await page.screenshot({ path: `test-results/issue-503-ui/${String(viewport.width)}-list-detail-scramble.png` });

      await panel.getByRole("button", { name: labels.settings, exact: true }).click();
      await expect(panel.getByRole("textbox", { name: labels.startText, exact: true })).toHaveValue(blitzRoundDefaultsForLanguage("de").startText);
      await expect(panel.locator(".blitz-panel__settings-form")).toHaveCSS("row-gap", "12px");
      await page.screenshot({ path: `test-results/issue-503-ui/${String(viewport.width)}-settings.png` });
      pool.setQuestions([]);
      await page.reload();
      await expect(panel.getByText(labels.emptyHint, { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: labels.addQuestion, exact: true })).toHaveCount(1);
      await expect(panel.locator(".blitz-panel__empty").getByRole("button")).toHaveCount(0);
      await expect(page.locator(".dashboard-shell__header")).toBeVisible();
      await expect(games).toBeVisible();
      await page.screenshot({ path: `test-results/issue-503-ui/${String(viewport.width)}-empty.png` });
    }
  });
});

test.describe("Touch answer controls", () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test("reserves room for touch answer controls across question types [protects=touch-sized quiz chips and feedback fit the reserved slot and switching to scramble preserves field positions; fails_when=the answer slot clips the default quiz controls or changes height by type; no_claim=does not cover every answer count, mobile keyboard or device]", async ({ page }) => {
    await setupPanelRoutes(page, [question("fictional-touch-question", "Which planet has rings?")]);
    await gotoPanel(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const slot = page.locator(".blitz-panel__answers");
    await expect(slot.getByRole("textbox", { name: "Accepted answers" })).toBeVisible();
    const slotPosition = await slot.boundingBox();
    const contentPosition = await slot.locator(".chips-input").boundingBox();
    expect(slotPosition).not.toBeNull();
    expect(contentPosition).not.toBeNull();
    expect(contentPosition?.height).toBeLessThanOrEqual(slotPosition?.height ?? 0);
    const enabled = page.getByRole("switch", { name: "Question enabled" });
    const enabledPosition = await enabled.boundingBox();
    await page.getByRole("button", { name: "Word scramble", exact: true }).click();
    await expect(slot.getByRole("textbox")).toHaveCount(0);
    expect(await slot.boundingBox()).toEqual(slotPosition);
    expect(await enabled.boundingBox()).toEqual(enabledPosition);
  });
});
