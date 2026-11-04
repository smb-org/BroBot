import { expect, test, type Page, type Route } from "@playwright/test";

import type { PollsEntry, PollsEntryInput, PollsRun } from "../../src/modules/polls/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "fictional_polls_channel";
const basePath = `/api/channels/${channelId}/modules/polls`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const startedAt = "2030-01-01T12:00:00.000Z";

const seededPrediction: PollsRun = {
  id: "seeded-prediction-run",
  kind: "prediction",
  twitchId: "twitch-prediction-id",
  entryId: null,
  source: "twitch",
  title: "Fällt der Boss?",
  choices: [
    { id: "boss-falls", title: "Boss fällt", votes: null, users: 4, channelPoints: 350 },
    { id: "boss-lives", title: "Boss bleibt", votes: null, users: 2, channelPoints: 100 },
  ],
  status: "active",
  startedAt,
  endsAt: "2030-01-01T12:03:00.000Z",
  lockedAt: null,
  endedAt: null,
  winningChoiceId: null,
  refundDeadline: "2030-01-02T12:00:00.000Z",
  lastEventAt: startedAt,
  dismissedAt: null,
};

const installPollsApi = async (page: Page): Promise<{
  getEntries: () => readonly PollsEntry[];
  getHistory: () => readonly PollsRun[];
  getReconcileCount: () => number;
}> => {
  let entries: PollsEntry[] = [];
  let activePrediction: PollsRun | null = structuredClone(seededPrediction);
  let history: PollsRun[] = [];
  let reconcileCount = 0;

  await page.route(`**${basePath}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relativePath = url.pathname.slice(basePath.length);
    if (relativePath === "/state" && request.method() === "GET") {
      return route.fulfill(json({ active: { poll: null, prediction: activePrediction }, open: [], entries }));
    }
    if (relativePath === "/history" && request.method() === "GET") {
      return route.fulfill(json({ runs: history, nextCursor: null }));
    }
    if (relativePath === "/reconcile" && request.method() === "POST") {
      reconcileCount += 1;
      return route.fulfill(json({ ok: true }));
    }
    if (relativePath === "/entries" && request.method() === "POST") {
      const input = request.postDataJSON() as PollsEntryInput;
      const created: PollsEntry = {
        ...input,
        id: "prepared-entry-1",
        revision: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
        lastStartedAt: null,
      };
      entries = [created];
      return route.fulfill(json({ entry: created }, 201));
    }
    if (relativePath === `/runs/${seededPrediction.id}/fresh` && request.method() === "GET") {
      return route.fulfill(activePrediction === null ? json({ error: "polls_run_not_found" }, 404) : json({ run: activePrediction }));
    }
    if (relativePath === `/runs/${seededPrediction.id}/resolve` && request.method() === "POST") {
      const body = request.postDataJSON() as { winningChoiceId: string };
      if (activePrediction === null) return route.fulfill(json({ error: "polls_not_open" }, 409));
      const resolved: PollsRun = {
        ...activePrediction,
        status: "resolved",
        winningChoiceId: body.winningChoiceId,
        endedAt: "2030-01-01T12:04:00.000Z",
      };
      activePrediction = null;
      history = [resolved];
      return route.fulfill(json({ run: resolved }));
    }
    return route.fallback();
  });

  return {
    getEntries: () => entries,
    getHistory: () => history,
    getReconcileCount: () => reconcileCount,
  };
};

test("creates a prepared entry and resolves a seeded Twitch prediction", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "polls", enabled: true, settings: "{}" }],
  });
  const api = await installPollsApi(page);

  await page.goto(`/channels/${channelId}/modules/polls?lang=de`);
  await expect(page.getByRole("heading", { name: "Läuft gerade" })).toBeVisible();
  await expect(page.getByText("Fällt der Boss?", { exact: true })).toBeVisible();
  await expect.poll(api.getReconcileCount).toBe(1);

  await page.getByRole("button", { name: "Neu", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Neuer Eintrag" });
  await editor.getByLabel("Titel").fill("Beste Snackpause?");
  await editor.getByLabel("Antwort 1").fill("Kuchen");
  await editor.getByLabel("Antwort 2").fill("Obst");
  await editor.getByRole("button", { name: "Speichern", exact: true }).click();

  await expect.poll(() => api.getEntries().length).toBe(1);
  await expect(page.getByRole("article", { name: "Beste Snackpause?" })).toBeVisible();

  const runningPrediction = page.getByRole("article", { name: "Prediction" });
  await runningPrediction.getByRole("button", { name: "Auflösen …" }).click();
  const resolveDialog = page.getByRole("dialog", { name: "Prediction auflösen" });
  await resolveDialog.getByRole("radio", { name: "Boss fällt" }).click();
  await resolveDialog.getByRole("button", { name: "„Boss fällt“ auszahlen" }).click();

  await expect.poll(() => api.getHistory().length).toBe(1);
  await expect(page.getByText("Gewonnen: Boss fällt")).toBeVisible();
  await expect(page.getByText("Quelle: Twitch", { exact: true })).toBeVisible();
});
