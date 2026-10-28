import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_quiz_session_channel";
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("starts a quiz, accepts a mocked chat answer, and shows the settled result phase", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "points", enabled: true, settings: "{}" },
      { id: "quiz", enabled: true, settings: JSON.stringify({ pot: 100, answerSeconds: 30, revealSeconds: 8, chatQuestions: true }) },
    ],
  });

  let session: Record<string, unknown> | null = null;
  let lastAnswer: { messageId: string; choice: number } | null = null;
  const sessionPath = `/api/channels/${channelId}/modules/quiz/session`;
  await page.route(`**${sessionPath}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === `${sessionPath}/availability`) return route.fulfill(json({ reason: null, running: session !== null }));
    if (pathname === `${sessionPath}/sets`) return route.fulfill(json({ sets: [{ id: "space-set", name: "Space", enabledQuestionCount: 1 }] }));
    if (pathname === `${sessionPath}/state`) return route.fulfill(json({ session }));
    if (pathname === `${sessionPath}/start` && route.request().method() === "POST") {
      session = {
        sessionId: "quiz-session-one",
        setName: "Space",
        phase: "open",
        questionIndex: 0,
        questionCount: 1,
        paused: false,
        phaseEndsAt: new Date(Date.now() + 30_000).toISOString(),
      };
      return route.fulfill(json({ sessionId: "quiz-session-one" }, 201));
    }
    if (pathname === `${sessionPath}/action` && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action?: unknown };
      if (body.action === "end" && session !== null) session = { ...session, phase: "results", phaseEndsAt: null };
      return route.fulfill(json({ ok: true }));
    }
    return route.fallback();
  });
  await page.route("**/api/__test/quiz-chat", async (route) => {
    const body = route.request().postDataJSON() as { messageId: string; text: string };
    lastAnswer = { messageId: body.messageId, choice: Number(body.text) - 1 };
    if (session !== null) session = { ...session, phase: "results", phaseEndsAt: null };
    await route.fulfill(json({ accepted: true }));
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}?lang=en`);
  await page.getByRole("button", { name: "Start quiz" }).click();
  const dialog = page.getByRole("dialog", { name: "Start quiz" });
  await expect(dialog.getByRole("combobox", { name: "Question set" })).toBeVisible();
  await dialog.getByRole("button", { name: "Run" }).click();
  const tile = page.getByTestId("live-quiz-tile");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("Question 1 of 1");

  const answerResponse = await page.evaluate(async () => fetch("/api/__test/quiz-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: "fictional-chat-message", text: "2" }),
  }).then((response) => response.json()));
  expect(answerResponse).toEqual({ accepted: true });
  expect(lastAnswer).toEqual({ messageId: "fictional-chat-message", choice: 1 });

  await page.reload();
  await expect(page.getByTestId("live-quiz-tile")).toContainText("Results");
  await expect(page.getByTestId("live-quiz-tile")).toContainText("Question 1 of 1");
});
