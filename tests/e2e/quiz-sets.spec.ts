import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_quiz_channel";
const collectionPath = `/api/channels/${channelId}/modules/quiz/sets`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const installQuizApi = async (page: Page) => {
  let savedSet: {
    id: string;
    name: string;
    revision: number;
    questions: Array<{ text: string; options: string[]; correctIndex: number; enabled: boolean; position: number }>;
    createdAt: string;
    updatedAt: string;
  } | null = null;

  let settings = { pot: 500, answerSeconds: 30, revealSeconds: 8, chatQuestions: true };
  let settingsRevision = 1;
  await page.route(`**/api/channels/${channelId}/modules/quiz/settings`, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { settings: typeof settings };
      settings = body.settings;
      settingsRevision += 1;
      return route.fulfill(json({ settings, revision: settingsRevision, warnings: [] }));
    }
    return route.fulfill(json({ settings, revision: settingsRevision, variables: [] }));
  });
  await page.route(`**${collectionPath}**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === collectionPath) {
      return route.fulfill(json({
        sets: savedSet === null ? [] : [{
          id: savedSet.id, name: savedSet.name, revision: savedSet.revision,
          questionCount: savedSet.questions.length, createdAt: savedSet.createdAt, updatedAt: savedSet.updatedAt,
        }],
        total: savedSet === null ? 0 : 1,
        page: 1,
      }));
    }
    if (request.method() === "POST" && url.pathname === collectionPath) {
      const body = request.postDataJSON() as { name: string };
      const now = "2030-01-01T00:00:00.000Z";
      savedSet = { id: "fictional-quiz-set", name: body.name, revision: 1, questions: [], createdAt: now, updatedAt: now };
      return route.fulfill(json({ set: savedSet }, 201));
    }
    if (url.pathname === `${collectionPath}/fictional-quiz-set` && request.method() === "GET") {
      return route.fulfill(savedSet === null ? json({ error: "quiz_set_not_found" }, 404) : json({ set: savedSet }));
    }
    if (url.pathname === `${collectionPath}/fictional-quiz-set` && request.method() === "PUT") {
      const body = request.postDataJSON() as Omit<NonNullable<typeof savedSet>, "id" | "createdAt" | "updatedAt" | "revision"> & { revision: number };
      if (savedSet === null) return route.fulfill(json({ error: "quiz_set_not_found" }, 404));
      savedSet = { ...savedSet, name: body.name, questions: body.questions, revision: savedSet.revision + 1, updatedAt: "2030-01-01T00:00:01.000Z" };
      return route.fulfill(json({ set: savedSet }));
    }
    return route.fallback();
  });

  return { getSavedSet: () => savedSet, getSettings: () => settings };
};

test("create a question set, save a question, and reload the saved editor", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "quiz", enabled: true, settings: "{}" },
    ],
  });
  const api = await installQuizApi(page);

  await page.goto(`/channels/${channelId}/modules/quiz?lang=en`);
  await page.getByRole("button", { name: "New set" }).click();
  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByLabel("Question text").fill("What is frozen water called?");
  await page.getByRole("textbox", { name: "Option 1" }).fill("Ice");
  await page.getByRole("textbox", { name: "Option 2" }).fill("Steam");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => api.getSavedSet()?.revision).toBe(2);
  expect(api.getSavedSet()).toMatchObject({
    name: "New set",
    questions: [{ text: "What is frozen water called?", options: ["Ice", "Steam"], correctIndex: 0 }],
  });

  await page.reload();
  await page.locator(".quiz-set-row").filter({ hasText: "New set" }).click();
  await expect(page.getByLabel("Set name")).toHaveValue("New set");
  await expect(page.getByLabel("Question text")).toHaveValue("What is frozen water called?");
  await expect(page.getByRole("textbox", { name: "Option 1" })).toHaveValue("Ice");
  await expect(page.getByRole("textbox", { name: "Option 2" })).toHaveValue("Steam");
});

test("opens the quiz settings from the sets page and saves them explicitly", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "quiz", enabled: true, settings: "{}" },
    ],
  });
  const api = await installQuizApi(page);

  await page.goto(`/channels/${channelId}/modules/quiz?lang=en`);
  await expect(page.getByRole("button", { name: "New set" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const pot = page.getByLabel("Points pot");
  await expect(pot).toHaveValue("500");
  await pot.fill("250");
  expect(api.getSettings().pot).toBe(500);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => api.getSettings().pot).toBe(250);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Points pot")).toHaveValue("250");
});
