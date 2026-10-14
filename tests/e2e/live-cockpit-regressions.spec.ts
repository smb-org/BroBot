import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("End vote is available to operators while start vote keeps its running countdown lock", async ({ page }) => {
  const channelId = "kanal-vote-end";
  let closeRequests = 0;
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    vote: {
      id: "vote-regression", channelId, kind: "yes_no", optionCount: 2, labels: ["Ja", "Nein"], title: "Weiter?",
      status: "open", openedAt: new Date().toISOString(), closesAt: new Date(Date.now() + 90_000).toISOString(),
      requestedDurationSeconds: 120, closedAt: null, closeReason: "manual", counts: [3, 1], voterCount: 4,
    },
    onVoteClose: () => { closeRequests += 1; },
  });

  await page.goto(`/channels/${channelId}`);
  const startVote = page.getByRole("button", { name: "Abstimmung starten" });
  const endVote = page.getByRole("button", { name: "Abstimmung beenden" });
  await expect(page.getByText(/Abstimmung läuft noch/u)).toBeVisible();
  await expect(startVote).toBeDisabled();
  await expect(endVote).toBeEnabled();
  await endVote.click();
  await expect.poll(() => closeRequests).toBe(1);
  await expect(page.locator(".live-action__feedback").filter({ hasText: "Abstimmung beendet." })).toBeVisible();
});

test("slow availability checks are not aborted by the four-second poll", async ({ page }) => {
  const channelId = "kanal-slow-check";
  let releaseCurrentState: (() => void) | undefined;
  const currentStateGate = new Promise<void>((resolve) => { releaseCurrentState = resolve; });
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    waitForCurrentState: () => currentStateGate,
  });

  await page.goto(`/channels/${channelId}`);
  await expect.poll(mocks.currentStateRequestCount).toBe(2);
  await page.waitForTimeout(5_100);
  expect(mocks.currentStateRequestCount()).toBe(2);
  releaseCurrentState?.();
  await expect(page.getByRole("button", { name: "Abstimmung starten" })).toBeEnabled();
});

test("a failed availability check leaves the action usable and exposes retry", async ({ page }) => {
  const channelId = "kanal-stale-check";
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
  });

  await page.goto(`/channels/${channelId}`);
  const startVote = page.getByRole("button", { name: "Abstimmung starten" });
  await expect(startVote).toBeEnabled();
  await expect(page.getByText("Prüfung veraltet; Aktion bleibt verfügbar.").first()).toBeVisible();
  const priorRequestCount = mocks.currentStateRequestCount();
  await page.getByRole("button", { name: "Erneut versuchen" }).first().click();
  await expect.poll(mocks.currentStateRequestCount).toBeGreaterThan(priorRequestCount);
});

test("the location warning opens Ort & Wetter and both channel defaults save from System", async ({ page }) => {
  const channelId = "kanal-settings-moved";
  const mocks = await installLiveCockpitMocks(page, { channelId });

  await page.goto(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Standort festlegen" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/location-weather`);
  await expect(page.getByRole("heading", { name: "Ort & Wetter" })).toBeVisible();
  await page.getByRole("button", { name: "Standort ändern" }).click();
  await page.getByRole("textbox", { name: "Ort suchen" }).fill("Berlin");
  await page.getByRole("button", { name: "Suchen" }).click();
  const locationSaved = page.waitForResponse((response) => response.url().endsWith(`/api/channels/${channelId}/settings/location`) && response.request().method() === "PATCH");
  await page.getByRole("option", { name: /Berlin/u }).click();
  await locationSaved;
  await expect(page.locator(".channel-location-field__current")).toContainText("Berlin, Berlin, Deutschland");
  expect(mocks.settingsState().location).toMatchObject({ name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405 });

  await page.getByRole("link", { name: "System" }).click();
  await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
  const timeZone = page.getByRole("combobox", { name: "Kanalzeitzone" });
  await expect(timeZone).toBeVisible();
  await expect(page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true })).toBeVisible();
  await timeZone.fill("UTC");
  await page.getByRole("option", { name: "UTC" }).click();
  await page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true }).click();
  await page.getByRole("radio", { name: /Alle Chats/u }).click();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".channel-defaults-editor .ui-save-bar__status")).toHaveText("Gespeichert.");
  expect(mocks.settingsState()).toMatchObject({ timeZone: "UTC", defaultChatTarget: "all_chats" });
});

test("clip creation keeps its returned edit URL in the action result", async ({ page }) => {
  const channelId = "kanal-clip-result";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "clips", enabled: true, settings: "{}" }],
  });

  await page.goto(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Clip erstellen" }).click();
  const result = page.locator(".live-action__feedback");
  await expect(result).toContainText("Clip erstellt.");
  await expect(result.getByRole("link", { name: "Öffnen" })).toHaveAttribute("href", "https://clips.twitch.tv/edit/clip-regression");
});

test("a disconnected BELABOX test result replaces the older connected header sample", async ({ page }) => {
  const channelId = "kanal-belabox-result";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "belabox", enabled: true, settings: "{}" }],
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.getByText("BELABOX · 4.000 kbit/s verbunden")).toBeVisible();
  await page.getByRole("button", { name: "BELABOX prüfen" }).click();
  await expect(page.getByText("BELABOX · getrennt")).toBeVisible();
  await expect(page.locator(".live-action__feedback")).toContainText("Getrennt · 0 kbit/s");
});

test("viewer count refreshes while the live cockpit is open", async ({ page }) => {
  const channelId = "kanal-viewer-refresh";
  await page.clock.install({ time: new Date() });
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    viewerCount: 42,
    nextViewerCount: 17,
  });

  await page.goto(`/channels/${channelId}`);
  const viewerMetric = page.locator(".live-cockpit-header__metric").filter({ hasText: "Zuschauer" });
  await expect(viewerMetric).toContainText("42");
  expect(mocks.overviewRequestCount()).toBeLessThan(3);
  await page.clock.fastForward(31_000);
  await expect(viewerMetric).toContainText("17");
});
