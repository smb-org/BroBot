import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("End vote keeps its last known poll id after availability refresh fails", async ({ page }) => {
  const channelId = "kanal-vote-stale-availability";
  const closeRequests: string[] = [];
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    vote: {
      id: "vote-stale-availability", channelId, kind: "yes_no", optionCount: 2, labels: ["Ja", "Nein"], title: "Weiter?",
      status: "open", openedAt: new Date().toISOString(), closesAt: new Date(Date.now() + 90_000).toISOString(),
      requestedDurationSeconds: 120, closedAt: null, closeReason: "timer", counts: [3, 1], voterCount: 4,
    },
    onVoteClose: (pollId) => { closeRequests.push(pollId); },
  });

  await page.goto(`/channels/${channelId}`);
  const endVote = page.getByRole("button", { name: "Abstimmung beenden" });
  await expect(endVote).toBeEnabled();
  mocks.failCurrentState();
  await expect(endVote.locator(".live-action__reason")).toContainText("Prüfung veraltet; Aktion bleibt verfügbar.", { timeout: 10_000 });
  await expect(endVote).toBeEnabled();

  await endVote.click();

  await expect.poll(() => closeRequests).toEqual(["vote-stale-availability"]);
});

test("End vote without a known poll id is disabled with a visible availability reason", async ({ page }) => {
  const channelId = "kanal-vote-missing-availability";
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
  });

  await page.goto(`/channels/${channelId}`);
  const endVote = page.getByRole("button", { name: "Abstimmung beenden" });
  await expect(endVote).toBeDisabled();
  await expect(endVote.locator(".live-action__reason")).toContainText("Die Verfügbarkeit konnte nicht geprüft werden.");
  await expect(page.getByRole("button", { name: "Erneut versuchen" }).first()).toBeVisible();
});

test("live system footer includes an event-feed query failure", async ({ page }) => {
  const channelId = "kanal-live-footer-events-unavailable";
  await installLiveCockpitMocks(page, { channelId, eventsError: true });

  await page.goto(`/channels/${channelId}`);

  const footer = page.locator(".live-cockpit__status");
  await expect(footer.locator(".status-led")).toHaveAttribute("data-status", "warn");
  await expect(footer).toContainText("Live-Daten sind gerade nicht verfügbar.");
  await expect(footer).not.toContainText("Alles bereit");
});

test("successful action feedback never masks a live-data failure and clears when health recovers", async ({ page }) => {
  const channelId = "kanal-live-footer-feedback-health";
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "clips", enabled: true, settings: "{}" }],
    eventsError: true,
  });

  await page.goto(`/channels/${channelId}`);
  const footer = page.locator(".live-cockpit__status");
  await expect(page.locator(".live-cockpit-event-feed__error")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Clip erstellen" }).click();
  await expect(footer).toContainText("Live-Daten sind gerade nicht verfügbar.");
  await expect(footer).not.toContainText("Clip erstellt.");
  await expect(footer).toHaveAttribute("aria-label", "Systemstatus: Live-Daten sind gerade nicht verfügbar.");

  const requestsBeforeRetry = mocks.eventRequestCount();
  mocks.setEventsError(false);
  await page.locator(".live-cockpit-event-feed__error").getByRole("button", { name: "Erneut versuchen" }).click();
  await expect.poll(mocks.eventRequestCount).toBeGreaterThan(requestsBeforeRetry);
  await expect(footer).toContainText("Alles bereit · Live-Daten aktuell");
  await expect(footer).not.toContainText("Clip erstellt.");
});

test.describe("English health status", () => {
  test.use({ locale: "en-US" });

  test("names the live-data failure accessibly in the English catalog", async ({ page }) => {
    const channelId = "channel-live-footer-english-health";
    await installLiveCockpitMocks(page, { channelId, eventsError: true });

    await page.goto(`/channels/${channelId}`);
    await expect(page.locator(".live-cockpit-event-feed__error")).toBeVisible({ timeout: 10_000 });
    const footer = page.locator(".live-cockpit__status");
    await expect(footer).toHaveAttribute("aria-label", "System status: Live data is unavailable right now.");
    await expect(footer).toContainText("Live data is unavailable right now.");
    await expect(page.locator(".live-cockpit-event-feed__error").getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test("owner status rows share status and reason columns", async ({ page }) => {
  const channelId = "kanal-owner-consent-grid";
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installLiveCockpitMocks(page, {
    channelId,
    role: "manager",
    viewerUserId: "kanal-manager",
    channelBotConsent: "missing",
    broadcasterMissingScopes: ["channel:manage:broadcast"],
  });

  await page.goto(`/channels/${channelId}`);
  await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
  await page.getByRole("link", { name: "System" }).click();

  const chatConsent = page.locator('.state-list .state-row[aria-label="Chat-Zustimmung"]');
  const reason = chatConsent.locator(".state-row__action .lock-reason");
  await expect(reason).toContainText("Nur der Twitch-Kanalinhaber kann diese Zustimmung erteilen.");

  const statusColumns = await page.locator(".state-list .state-row").evaluateAll((rows) => rows.flatMap((row) => {
    const status = row.querySelector<HTMLElement>(".status-led");
    return status === null ? [] : [status.getBoundingClientRect().left];
  }));
  expect(statusColumns.length).toBeGreaterThan(3);
  expect(Math.max(...statusColumns) - Math.min(...statusColumns)).toBeLessThanOrEqual(1);

  const reasonLayout = await reason.evaluate((element) => {
    const action = element.closest<HTMLElement>(".state-row__action");
    if (action === null) return null;
    const reasonBox = element.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    return {
      widthDelta: actionBox.width - reasonBox.width,
      leftDelta: Math.abs(actionBox.left - reasonBox.left),
      textAlign: getComputedStyle(element).textAlign,
    };
  });
  if (reasonLayout === null) throw new Error("The owner-only explanation must stay inside the consent action column.");
  expect(reasonLayout.widthDelta).toBeLessThanOrEqual(1);
  expect(reasonLayout.leftDelta).toBeLessThanOrEqual(1);
  expect(reasonLayout.textAlign).toBe("left");
});
