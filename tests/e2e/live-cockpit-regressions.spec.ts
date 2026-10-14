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
  const countdown = page.locator(".live-vote-tile__countdown");
  const countdownStyle = await countdown.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, background: style.backgroundColor, family: style.fontFamily };
  });
  expect(countdownStyle.border).toBe("1px");
  expect(countdownStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(countdownStyle.family).toContain("IBM Plex Mono");
  const bars = await page.locator(".live-vote-tile__options").boundingBox();
  const footer = await page.locator(".live-vote-tile__footer").boundingBox();
  if (bars === null || footer === null) throw new Error("The running vote bars and footer need layout boxes.");
  expect(footer.y - (bars.y + bars.height)).toBeLessThanOrEqual(12);
  await endVote.click();
  await expect.poll(() => closeRequests).toBe(1);
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Abstimmung beendet.");
});

test("action rows and warning controls share their grid gaps and center line", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installLiveCockpitMocks(page, {
    channelId: "kanal-cockpit-geometry",
    modules: ["ads", "belabox", "chat_voting", "clips", "raid"].map((id) => ({ id, enabled: true, settings: "{}" })),
  });
  await page.goto("/channels/kanal-cockpit-geometry");
  const buttons = page.locator(".live-cockpit-actions__grid .live-action__button");
  await expect(buttons.first()).toBeVisible();
  const geometry = await buttons.evaluateAll((elements) => {
    const boxes = elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    });
    const firstRow = boxes.filter((box) => Math.abs(box.y - (boxes[0]?.y ?? box.y)) < 1);
    const nextRowFirst = boxes.find((box) => box.y > (boxes[0]?.y ?? Number.POSITIVE_INFINITY));
    const first = firstRow[0];
    const second = firstRow[1];
    return first === undefined || second === undefined || nextRowFirst === undefined
      ? null
      : { rowGap: nextRowFirst.y - first.bottom, columnGap: second.x - first.right };
  });
  expect(geometry).not.toBeNull();
  if (geometry === null) return;
  expect(Math.abs(geometry.rowGap - geometry.columnGap)).toBeLessThanOrEqual(1);

  const warning = page.locator(".live-cockpit__location-warning");
  const locationButton = warning.getByRole("button", { name: "Einrichten" });
  await expect(locationButton).toBeVisible();
  await expect(locationButton.locator("svg")).toHaveCount(1);
  const warningButtonBackground = await locationButton.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(warningButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  const centerDiff = await warning.evaluate((element) => {
    const button = element.querySelector("button");
    if (button === null) return Number.POSITIVE_INFINITY;
    const warningBox = element.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return Math.abs((warningBox.top + warningBox.height / 2) - (buttonBox.top + buttonBox.height / 2));
  });
  expect(centerDiff).toBeLessThanOrEqual(1);

  const table = page.locator(".live-cockpit-event-feed .data-table__table");
  const emptyRow = table.locator(".data-table__empty-row");
  await expect(emptyRow).toContainText("Noch keine Ereignisse.");
  const emptyGeometry = await table.evaluate((element) => {
    const row = element.querySelector(".data-table__empty-row");
    const cell = row?.querySelector(".data-table__empty");
    if (row === null || cell === null || cell === undefined) return null;
    const tableBox = element.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    return {
      tableWidth: tableBox.width,
      rowWidth: rowBox.width,
      cellWidth: cellBox.width,
      cellDisplay: getComputedStyle(cell).display,
      cellHeight: cellBox.height,
      cellScrollHeight: cell.scrollHeight,
    };
  });
  expect(emptyGeometry).not.toBeNull();
  if (emptyGeometry === null) return;
  expect(Math.abs(emptyGeometry.tableWidth - emptyGeometry.rowWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(emptyGeometry.tableWidth - emptyGeometry.cellWidth)).toBeLessThanOrEqual(1);
  expect(emptyGeometry.cellDisplay).toBe("block");
  expect(emptyGeometry.cellScrollHeight).toBeLessThanOrEqual(emptyGeometry.cellHeight);
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
  await expect.poll(mocks.currentStateRequestCount).toBe(3);
  await page.waitForTimeout(5_100);
  expect(mocks.currentStateRequestCount()).toBe(3);
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
  await page.locator(".live-cockpit__warning-slot").getByRole("button", { name: "Einrichten" }).click();
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
  const chatTarget = page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true });
  await expect(chatTarget).toBeVisible();
  const save = page.getByRole("button", { name: "Speichern" });
  await expect(save).toBeVisible();
  await expect(save).toBeDisabled();
  const controlHeights = await Promise.all([timeZone, chatTarget].map(async (control) => (await control.boundingBox())?.height ?? 0));
  expect(Math.abs((controlHeights[0] ?? 0) - (controlHeights[1] ?? 0))).toBeLessThanOrEqual(1);
  const hintPositions = await Promise.all([
    page.locator(".channel-defaults-editor .ui-select__description").first(),
    page.locator(".channel-defaults-editor__hint"),
  ].map(async (hint) => (await hint.boundingBox())?.y ?? Number.NaN));
  expect(Math.abs((hintPositions[0] ?? 0) - (hintPositions[1] ?? 0))).toBeLessThanOrEqual(1);
  const sectionBox = await page.locator(".channel-defaults-editor").boundingBox();
  const sectionBottom = sectionBox === null ? 0 : sectionBox.y + sectionBox.height;
  const statusTop = (await page.locator(".state-list").first().boundingBox())?.y ?? 0;
  expect(statusTop - sectionBottom).toBeLessThanOrEqual(48);
  expect(statusTop - sectionBottom).toBeGreaterThanOrEqual(0);
  await timeZone.fill("UTC");
  await page.getByRole("option", { name: "UTC" }).click();
  await chatTarget.click();
  await page.getByRole("radio", { name: /Alle Chats/u }).click();
  await expect(save).toBeEnabled();
  await save.click();
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
  const result = page.locator(".live-cockpit__status-message");
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
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Getrennt · 0 kbit/s");
});

for (const scenario of [
  { name: "fetch failure notice", status: { fetchFailureNotice: true } },
  { name: "error code", status: { errorCode: "relay_fetch_failed" } },
] as const) {
  test(`BELABOX leaves the healthy state on a retained sample after a ${scenario.name}`, async ({ page }) => {
    const channelId = `kanal-belabox-${scenario.name.replaceAll(" ", "-")}`;
    await installLiveCockpitMocks(page, {
      channelId,
      modules: [{ id: "belabox", enabled: true, settings: "{}" }],
      belaboxStatus: scenario.status,
    });

    await page.goto(`/channels/${channelId}`);
    await expect(page.getByLabel("BELABOX · nicht erreichbar")).toHaveAttribute("data-status", "warn");
  });
}

test("the live title placeholder is read-only and the channel target has one affordance", async ({ page }) => {
  const channelId = "kanal-live-header-placeholder";
  await installLiveCockpitMocks(page, { channelId });

  await page.goto(`/channels/${channelId}`);
  const titleSlot = page.locator('[data-slot="stream-title-category"]');
  await expect(titleSlot).toContainText("Streamtitel und Kategorie");
  await expect(titleSlot).toHaveCSS("border-top-width", "0px");
  await expect(titleSlot.locator("input, button")).toHaveCount(0);

  await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
  const chatTarget = page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true });
  await expect(chatTarget.locator(".ui-chat-target-field__change")).toHaveCount(0);
  await expect(chatTarget.locator(".ui-chat-target-field__chevron")).toBeVisible();
});

test("action tile content stays centered with its reserved reason line", async ({ page }) => {
  const channelId = "kanal-live-action-centering";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "ads", enabled: true, settings: "{}" }],
  });

  await page.goto(`/channels/${channelId}`);
  const action = page.getByRole("button", { name: "Werbung starten" });
  const [tileBox, iconBox, reasonBox] = await Promise.all([
    action.boundingBox(),
    action.locator(".live-action__icon").boundingBox(),
    action.locator(".live-action__reason").boundingBox(),
  ]);
  expect(tileBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(reasonBox).not.toBeNull();
  const contentCenter = ((iconBox?.y ?? 0) + (reasonBox?.y ?? 0) + (reasonBox?.height ?? 0)) / 2;
  const tileCenter = (tileBox?.y ?? 0) + (tileBox?.height ?? 0) / 2;
  expect(Math.abs(contentCenter - tileCenter)).toBeLessThanOrEqual(4);
  await expect(action.locator(".live-action__reason")).toHaveCSS("align-self", "center");
});

test("ad and shoutout popovers are named by their linked headings", async ({ page }) => {
  const channelId = "kanal-live-popover-names";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "ads", enabled: true, settings: "{}" },
      { id: "raid", enabled: true, settings: "{}" },
    ],
  });

  await page.goto(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Werbung starten" }).click();
  await expect(page.getByRole("dialog", { name: "Werbung starten" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Shoutout senden" }).click();
  await expect(page.getByRole("dialog", { name: "Shoutout senden" })).toBeVisible();
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
