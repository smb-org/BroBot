import { expect, test, type Page, type Route } from "@playwright/test";

import type { PollsEntry, PollsRun } from "../../src/modules/polls/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "fictional_polls_cockpit";
const basePath = `/api/channels/${channelId}/modules/polls`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const startedAt = "2030-01-01T12:00:00.000Z";
const requiredScopes = ["channel:manage:polls", "channel:manage:predictions"];

const entry: PollsEntry = {
  id: "prepared-cockpit-poll",
  kind: "poll",
  title: "Welche Karte spielen wir?",
  choices: ["Höhle", "Wald"],
  durationSeconds: 60,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: null,
  revision: 1,
  createdAt: startedAt,
  updatedAt: startedAt,
  lastStartedAt: null,
};

const prediction: PollsRun = {
  id: "seeded-cockpit-prediction",
  kind: "prediction",
  twitchId: "twitch-cockpit-prediction",
  entryId: null,
  source: "twitch",
  title: "Fällt der Boss?",
  choices: [
    { id: "boss-falls", title: "Boss fällt", votes: null, users: 3, channelPoints: 240 },
    { id: "boss-lives", title: "Boss bleibt", votes: null, users: 1, channelPoints: 80 },
  ],
  status: "active",
  startedAt,
  endsAt: "2030-01-01T12:03:00.000Z",
  lockedAt: null,
  endedAt: null,
  winningChoiceId: null,
  refundDeadline: null,
  lastEventAt: startedAt,
  dismissedAt: null,
};

const installPollsApi = async (page: Page, initial: { entries?: PollsEntry[]; prediction?: PollsRun | null }) => {
  const entries = [...(initial.entries ?? [])];
  let activePrediction = initial.prediction ?? null;
  let startedEntryId: string | null = null;
  let resolvedChoiceId: string | null = null;

  await page.route(`**/api/channels/${channelId}/modules`, async (route: Route) => route.fulfill(json({ modules: [{
    id: "polls",
    enabled: true,
    settings: "{}",
    requiredBroadcasterScopes: requiredScopes,
    missingBroadcasterScopes: [],
  }] })));
  await page.route(`**${basePath}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relativePath = url.pathname.slice(basePath.length);
    if (relativePath === "/state" && request.method() === "GET") {
      return route.fulfill(json({ active: { poll: null, prediction: activePrediction }, open: [], entries }));
    }
    if (relativePath === `/entries/${entry.id}/start` && request.method() === "POST") {
      startedEntryId = entry.id;
      const run: PollsRun = {
        id: "started-cockpit-poll",
        kind: "poll",
        twitchId: "twitch-started-poll",
        entryId: entry.id,
        source: "brobot",
        title: entry.title,
        choices: entry.choices.map((title, index) => ({
          id: `choice-${String(index)}`,
          title,
          votes: 0,
          users: null,
          channelPoints: null,
        })),
        status: "active",
        startedAt,
        endsAt: "2030-01-01T12:01:00.000Z",
        lockedAt: null,
        endedAt: null,
        winningChoiceId: null,
        refundDeadline: null,
        lastEventAt: startedAt,
        dismissedAt: null,
      };
      return route.fulfill(json({ run }));
    }
    if (relativePath === `/runs/${prediction.id}/fresh` && request.method() === "GET") {
      return route.fulfill(activePrediction === null ? json({ error: "polls_run_not_found" }, 404) : json({ run: activePrediction }));
    }
    if (relativePath === `/runs/${prediction.id}/resolve` && request.method() === "POST") {
      const body = request.postDataJSON() as { winningChoiceId: string };
      resolvedChoiceId = body.winningChoiceId;
      const resolved = { ...prediction, status: "resolved" as const, winningChoiceId: body.winningChoiceId, endedAt: "2030-01-01T12:04:00.000Z" };
      activePrediction = null;
      return route.fulfill(json({ run: resolved }));
    }
    return route.fallback();
  });

  return {
    startedEntryId: () => startedEntryId,
    resolvedChoiceId: () => resolvedChoiceId,
  };
};

test("starts a prepared poll from the live cockpit dialog", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "polls", enabled: true, settings: "{}" }],
    role: "operator",
  });
  const api = await installPollsApi(page, { entries: [entry] });

  await page.goto(`/channels/${channelId}?lang=de`);
  const startAction = page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "Umfrage/Prediction starten" });
  await expect(startAction).toBeEnabled();
  await startAction.click();

  const dialog = page.getByRole("dialog", { name: "Umfrage/Prediction starten" });
  await dialog.getByRole("button", { name: "Starten", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.startedEntryId()).toBe(entry.id);
  await expect(page.locator(".live-cockpit-actions__grid")).toContainText("Lauf wurde auf Twitch gestartet.");
});

test("resolves a seeded open prediction from the live cockpit", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "polls", enabled: true, settings: "{}" }],
    role: "operator",
  });
  const api = await installPollsApi(page, { prediction });

  await page.goto(`/channels/${channelId}?lang=de`);
  const resolveAction = page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "Prediction auflösen" });
  await expect(resolveAction).toBeEnabled();
  await resolveAction.click();

  const outcome = page.getByRole("radio", { name: "Boss fällt" });
  await outcome.click();
  await page.getByRole("button", { name: "„Boss fällt“ auszahlen" }).click();
  await expect(page.getByRole("dialog", { name: "Prediction auflösen" })).toBeHidden();
  expect(api.resolvedChoiceId()).toBe("boss-falls");
  await expect(page.locator(".live-cockpit-actions__grid")).toContainText("Prediction wurde aufgelöst.");
});
