import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks, type LiveCockpitMockOptions } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("End vote is available to operators while start vote keeps its running countdown lock", async ({ page }) => {
  const channelId = "kanal-vote-end";
  const closeRequests: string[] = [];
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    vote: {
      id: "vote-regression", channelId, kind: "yes_no", optionCount: 2, labels: ["Ja", "Nein"], answerColors: ["#5b8cff", "#ff9f43"], title: "Weiter?",
      status: "open", openedAt: new Date().toISOString(), closesAt: new Date(Date.now() + 90_000).toISOString(),
      requestedDurationSeconds: 120, closedAt: null, closeReason: "manual", counts: [3, 1], voterCount: 4,
    },
    onVoteClose: (pollId) => { closeRequests.push(pollId); },
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
  await expect.poll(() => closeRequests).toEqual(["vote-regression"]);
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Abstimmung beendet.");
});

test("live system footer shows unavailable data instead of healthy while chat voting is offline", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId: "kanal-live-footer-unavailable",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
  });
  await page.goto("/channels/kanal-live-footer-unavailable");
  const footer = page.locator(".live-cockpit__status");
  await expect(footer.locator(".status-led")).toHaveAttribute("data-status", "warn");
  await expect(footer).toContainText("Live-Daten sind gerade nicht verfügbar.");
  await expect(footer).not.toContainText("Alles bereit");
});

test("live system footer gives a known query failure precedence over another pending query", async ({ page }) => {
  let releaseOverlays: () => void = () => {};
  const overlaysPending = new Promise<void>((resolve) => { releaseOverlays = resolve; });
  await installLiveCockpitMocks(page, {
    channelId: "kanal-live-footer-mixed-query-state",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
    waitForOverlays: () => overlaysPending,
  });
  await page.goto("/channels/kanal-live-footer-mixed-query-state");
  const footer = page.locator(".live-cockpit__status");
  try {
    await expect(footer.locator(".status-led")).toHaveAttribute("data-status", "warn");
    await expect(footer).toContainText("Live-Daten sind gerade nicht verfügbar.");
    await expect(footer).not.toContainText("Live-Daten werden geladen.");
  } finally {
    releaseOverlays();
  }
});

test("live system footer shows a disconnected bot as a warning", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId: "kanal-bot-disconnected-footer",
    channelBotStatus: "disconnected",
  });
  await page.goto("/channels/kanal-bot-disconnected-footer");
  const footer = page.locator(".live-cockpit__status");
  await expect(footer.locator(".status-led")).toHaveAttribute("data-status", "warn");
  await expect(footer).toContainText("Nicht verbunden");
  await expect(footer).not.toContainText("Alles bereit");
});

test("owner consent actions keep the shared right edge and plain status labels", async ({ page }) => {
  const channelId = "kanal-owner-consent-layout";
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installLiveCockpitMocks(page, {
    channelId,
    role: "broadcaster",
    viewerUserId: channelId,
    channelBotConsent: "missing",
    broadcasterMissingScopes: ["channel:manage:broadcast"],
  });
  await page.goto(`/channels/${channelId}`);
  await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
  await page.getByRole("link", { name: "System" }).click();

  const chatConsent = page.locator('.state-list .state-row[aria-label="Chat-Zustimmung"]');
  await expect(chatConsent.locator(".state-row__label")).toHaveText("Chat-Zustimmung");
  await expect(chatConsent).toContainText("Broadcaster-Zustimmung fehlt");
  await expect(chatConsent).toContainText("Der Bot darf noch nicht im Chat schreiben.");
  const fullConsent = page.locator('.state-list .state-row[aria-label="Vollzustimmung"]');
  await expect(fullConsent.locator(".state-row__label")).toHaveText("Vollzustimmung");
  await expect(fullConsent).toContainText("Vollzustimmung fehlt");
  await expect(page.getByText(/channel:bot/u)).toHaveCount(0);

  const alignment = await page.locator(".state-list .state-row:has(.state-row__action)").evaluateAll((rows) => {
    const boxes = rows.map((row) => {
      const rowBox = row.getBoundingClientRect();
      const button = row.querySelector<HTMLElement>(".state-row__action > .button, .state-row__action > .ui-button, .state-row__action .header-action > .button, .state-row__action .header-action > .ui-button");
      if (button === null) return null;
      const buttonBox = button.getBoundingClientRect();
      return { right: buttonBox.right, centerDelta: Math.abs((rowBox.top + rowBox.height / 2) - (buttonBox.top + buttonBox.height / 2)) };
    });
    const valid = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
    return valid.length < 2 ? null : {
      rightEdgeSpread: Math.max(...valid.map((box) => box.right)) - Math.min(...valid.map((box) => box.right)),
      maxCenterDelta: Math.max(...valid.map((box) => box.centerDelta)),
    };
  });
  expect(alignment).not.toBeNull();
  if (alignment === null) throw new Error("Owner status action rows need visible controls.");
  expect(alignment.rightEdgeSpread).toBeLessThanOrEqual(1);
  expect(alignment.maxCenterDelta).toBeLessThanOrEqual(1);
});

for (const viewport of [{ width: 800, height: 900 }, { width: 1024, height: 768 }]) {
  const widthLabel = String(viewport.width);
  test(`system status rows keep actions inside the row at ${widthLabel}px`, async ({ page }, testInfo) => {
    const channelId = `kanal-system-rows-${widthLabel}`;
    await page.setViewportSize(viewport);
    await installLiveCockpitMocks(page, {
      channelId,
      role: "broadcaster",
      viewerUserId: channelId,
      channelBotConsent: "missing",
      broadcasterMissingScopes: ["channel:manage:broadcast"],
    });
    await page.goto(`/channels/${channelId}`);
    await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
    await page.getByRole("link", { name: "System" }).click();
    await expect(page.locator(".state-list .state-row:has(.state-row__action)").first()).toBeVisible();

    const result = await page.locator(".state-list .state-row:has(.state-row__action)").evaluateAll((rows) => rows.map((row) => {
      const rowBox = row.getBoundingClientRect();
      const inside = [...row.querySelectorAll<HTMLElement>(".state-row__action button, .state-row__action .lock-reason")].map((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= rowBox.left - 1 && box.right <= rowBox.right + 1 && box.top >= rowBox.top - 1 && box.bottom <= rowBox.bottom + 1;
      });
      return { controls: inside.length, allInside: inside.every(Boolean), rowOverflow: row.scrollWidth > row.clientWidth };
    }));
    const withControls = result.filter((row) => row.controls > 0);
    expect(withControls.length).toBeGreaterThan(0);
    for (const row of withControls) {
      expect(row).toMatchObject({ allInside: true, rowOverflow: false });
    }
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(pageOverflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`system-rows-${widthLabel}.png`) });
  });
}

test("an open votekick confirmation keeps the id it was rendered for", async ({ page }) => {
  const channelId = "kanal-stale-votekick-confirmation";
  const options: LiveCockpitMockOptions = {
    channelId,
    modules: [{ id: "votekick", enabled: true, settings: "{}" }],
    votekick: {
      id: "kick-a", targetLogin: "alice", targetUserId: "user-a", endsAt: new Date(Date.now() + 60_000).toISOString(),
      yesVotes: 3, noVotes: 1, threshold: 5,
    },
  };
  const canceledIds: string[] = [];
  options.onVotekickCancel = (id) => { canceledIds.push(id); };
  await installLiveCockpitMocks(page, options);
  await page.goto(`/channels/${channelId}`);
  const tile = page.locator(".live-votekick-tile");
  await expect(tile.locator("h3")).toHaveText("alice");
  await tile.getByRole("button", { name: "Votekick abbrechen" }).click();
  await expect(page.getByRole("dialog", { name: "Votekick abbrechen?" })).toContainText("alice");

  options.votekick = {
    id: "kick-b", targetLogin: "bob", targetUserId: "user-b", endsAt: new Date(Date.now() + 60_000).toISOString(),
    yesVotes: 2, noVotes: 1, threshold: 5,
  };
  await expect(tile.locator("h3")).toHaveText("bob", { timeout: 7_000 });
  await page.getByRole("dialog", { name: "Votekick abbrechen?" }).getByRole("button", { name: "Votekick abbrechen" }).click();

  await expect.poll(() => canceledIds).toEqual(["kick-a"]);
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Der Votekick wurde inzwischen ersetzt.");
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
  const labelTops = await buttons.evaluateAll((elements) => elements.map((element) => {
    const label = element.querySelector(".live-action__name");
    return label === null ? null : { rowTop: Math.round(element.getBoundingClientRect().top), labelTop: label.getBoundingClientRect().top };
  }));
  const firstRowTop = await buttons.first().evaluate((element) => Math.round(element.getBoundingClientRect().top));
  const firstRowLabels = labelTops.filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.rowTop === firstRowTop);
  expect(firstRowLabels.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...firstRowLabels.map((entry) => entry.labelTop)) - Math.min(...firstRowLabels.map((entry) => entry.labelTop))).toBeLessThanOrEqual(1);

  const warning = page.locator(".live-cockpit__warning-summary");
  const locationButton = warning.getByRole("button", { name: "Einrichten" });
  await expect(locationButton).toBeVisible();
  await expect(locationButton.locator("svg")).toHaveCount(1);
  const warningButtonBackground = await locationButton.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(warningButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  const centerDiff = await warning.evaluate((element) => {
    const button = element.querySelector(".live-cockpit__location-action");
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

test("a failed refresh clears an obsolete running-vote lock", async ({ page }) => {
  const channelId = "kanal-expired-vote-lock";
  const options: LiveCockpitMockOptions = {
    channelId,
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    vote: {
      id: "vote-expired", channelId, kind: "yes_no", optionCount: 2, labels: ["Ja", "Nein"], answerColors: ["#5b8cff", "#ff9f43"], title: "Weiter?",
      status: "open", openedAt: new Date().toISOString(), closesAt: new Date(Date.now() + 90_000).toISOString(),
      requestedDurationSeconds: 120, closedAt: null, closeReason: "timer", counts: [3, 1], voterCount: 4,
    },
  };
  const mocks = await installLiveCockpitMocks(page, options);

  await page.goto(`/channels/${channelId}`);
  const startVote = page.getByRole("button", { name: "Abstimmung starten" });
  await expect(startVote).toBeDisabled();
  await expect(startVote.locator(".live-action__reason")).toContainText("Abstimmung läuft noch");
  const requestCountBeforeRefresh = mocks.currentStateRequestCount();
  options.vote = null;
  options.currentStateError = true;
  await expect.poll(mocks.currentStateRequestCount, { timeout: 6_000 }).toBeGreaterThan(requestCountBeforeRefresh);
  await expect(startVote).toBeEnabled({ timeout: 6_000 });
  await expect(page.getByText("Prüfung veraltet; Aktion bleibt verfügbar.").first()).toBeVisible();
  expect(mocks.currentStateRequestCount()).toBeGreaterThan(2);
});

test("the location warning opens Ort & Wetter and both time zone and chat defaults save explicitly", async ({ page }) => {
  const channelId = "kanal-settings-moved";
  const mocks = await installLiveCockpitMocks(page, { channelId });

  await page.goto(`/channels/${channelId}`);
  await page.locator(".live-cockpit__warning-slot").getByRole("button", { name: "Einrichten" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/location-weather`);
  await expect(page.getByRole("heading", { name: "Ort & Wetter" })).toBeVisible();
  await page.getByRole("button", { name: "Standort ändern" }).click();
  await page.getByRole("textbox", { name: "Ort suchen" }).fill("Berlin");
  await page.getByRole("button", { name: "Suchen" }).click();
  await page.getByRole("option", { name: /Berlin/u }).click();
  await expect(page.locator(".channel-location-field__status")).toContainText("Berlin, Berlin, Deutschland");
  expect(mocks.settingsState().location).toBeNull();
  const locationSaved = page.waitForResponse((response) => response.url().endsWith(`/api/channels/${channelId}/settings/location`) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await locationSaved;
  expect(mocks.settingsState().location).toMatchObject({ name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405 });

  const timeZone = page.getByRole("combobox", { name: "Kanalzeitzone" });
  await timeZone.fill("UTC");
  await page.getByRole("option", { name: "UTC" }).click();
  const timeZoneSaved = page.waitForResponse((response) => response.url().endsWith(`/api/channels/${channelId}/settings`) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Speichern" }).click();
  await timeZoneSaved;
  await expect(page.locator(".ui-save-bar__status")).toContainText("Gespeichert.");
  expect(mocks.settingsState()).toMatchObject({ timeZone: "UTC" });

  await page.getByRole("link", { name: "System" }).click();
  await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Kanalzeitzone" })).toHaveCount(0);
  const chatTarget = page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true });
  await expect(chatTarget).toBeVisible();
  const save = page.getByRole("button", { name: "Speichern" });
  await expect(save).toBeVisible();
  await expect(save).toBeDisabled();
  const settingsColumns = page.locator(".settings-page__columns");
  const defaultsColumn = settingsColumns.locator(":scope > .settings-page__column").nth(0);
  const defaultsEditor = page.locator(".channel-defaults-editor");
  const statusArea = page.locator(".system-page__status");
  await expect(defaultsEditor).toBeVisible();
  await expect(statusArea).toBeVisible();
  const defaultsEditorBox = await defaultsEditor.boundingBox();
  const statusAreaBox = await statusArea.boundingBox();
  expect(await settingsColumns.locator(":scope > .settings-page__column").count()).toBe(1);
  await expect(defaultsColumn).toBeVisible();
  expect(defaultsEditorBox).not.toBeNull();
  expect(statusAreaBox).not.toBeNull();
  expect((defaultsEditorBox?.y ?? 0) + (defaultsEditorBox?.height ?? 0)).toBeLessThanOrEqual(statusAreaBox?.y ?? 0);
  await chatTarget.click();
  await page.getByRole("radio", { name: /Alle Chats/u }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".page-header__save .ui-save-bar__status")).toHaveText("Gespeichert.");
  expect(mocks.settingsState()).toMatchObject({ timeZone: "UTC", defaultChatTarget: "all_chats" });
});

test("event shoutouts respect raid-module and live-stream availability", async ({ page }) => {
  const event = {
    eventId: "raid-event-availability",
    createdAt: new Date().toISOString(),
    moduleId: "channel_events",
    triggerId: "raid-trigger",
    code: "channel.raid.incoming",
    detail: JSON.stringify({ source: "raider" }),
    actorUserId: "raider-id",
    actorLogin: "raider",
    actorDisplayName: "Raider",
  };

  await installLiveCockpitMocks(page, {
    channelId: "kanal-raid-module-disabled",
    modules: [{ id: "raid", enabled: false, settings: "{}" }],
    events: [event],
  });
  await page.goto("/channels/kanal-raid-module-disabled");
  const disabledModuleAction = page.getByRole("button", { name: "Shoutout senden" }).last();
  await expect(disabledModuleAction).toBeDisabled();
  const moduleReason = await disabledModuleAction.getAttribute("aria-describedby");
  if (moduleReason === null) throw new Error("The disabled raid action must describe its module requirement.");
  await expect(page.locator(`#${moduleReason}`)).toContainText("Modul ist in diesem Kanal nicht aktiv");

  await installLiveCockpitMocks(page, {
    channelId: "kanal-raid-stream-offline",
    modules: [{ id: "raid", enabled: true, settings: "{}" }],
    streamState: "offline",
    events: [event],
  });
  await page.goto("/channels/kanal-raid-stream-offline");
  const offlineAction = page.getByRole("button", { name: "Shoutout senden" }).last();
  await expect(offlineAction).toBeDisabled();
  const streamReason = await offlineAction.getAttribute("aria-describedby");
  if (streamReason === null) throw new Error("The offline raid action must describe its stream requirement.");
  await expect(page.locator(`#${streamReason}`)).toContainText("Stream ist offline");
});

test("event shoutout failures retain the specific Twitch reason", async ({ page }) => {
  const event = {
    eventId: "raid-event-shoutout-reason",
    createdAt: new Date().toISOString(),
    moduleId: "channel_events",
    triggerId: "raid-trigger",
    code: "channel.raid.incoming",
    detail: JSON.stringify({ source: "raider" }),
    actorUserId: "raider-id",
    actorLogin: "raider",
    actorDisplayName: "Raider",
  };
  await installLiveCockpitMocks(page, {
    channelId: "kanal-raid-shoutout-reason",
    modules: [{ id: "raid", enabled: true, settings: "{}" }],
    events: [event],
    shoutoutFailureReason: "scope_missing",
  });
  await page.goto("/channels/kanal-raid-shoutout-reason");
  const eventRow = page.getByRole("row").filter({ hasText: "Raider" });
  const shoutoutResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/shoutout") && response.request().method() === "POST";
  });
  await eventRow.getByRole("button", { name: "Shoutout senden" }).click();
  expect((await shoutoutResponse).status()).toBe(502);
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Berechtigung zum Senden des Shoutouts fehlt");
});

test("operator sees why the upcoming ad snooze action is disabled", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId: "kanal-operator-ad-snooze",
    role: "operator",
    modules: [{ id: "ads", enabled: true, settings: "{}" }],
    upcomingAd: true,
  });

  await page.goto("/channels/kanal-operator-ad-snooze");
  const snooze = page.getByRole("button", { name: "Verschieben" });
  await expect(snooze).toBeDisabled();
  const describedBy = await snooze.getAttribute("aria-describedby");
  if (describedBy === null) throw new Error("The disabled snooze action must describe its role requirement.");
  await expect(page.locator(`#${describedBy}`)).toContainText("Nur Verwalter und Broadcaster dürfen diese Aktion ausführen");
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

test("the live title and category open one editor while the channel target has one affordance", async ({ page }) => {
  const channelId = "kanal-live-header-placeholder";
  await installLiveCockpitMocks(page, { channelId });

  await page.goto(`/channels/${channelId}`);
  const titleSlot = page.locator('[data-slot="stream-title-category"]');
  await expect(titleSlot).toContainText("Demo stream title");
  await expect(titleSlot).toContainText("Just Chatting");
  await expect(titleSlot).toHaveCSS("border-top-width", "0px");
  await titleSlot.getByRole("button", { name: "Titel und Kategorie bearbeiten" }).click();
  const editor = page.getByRole("dialog", { name: "Titel und Kategorie bearbeiten" });
  await expect(editor.getByRole("textbox", { name: "Streamtitel" })).toHaveValue("Demo stream title");
  await expect(editor.getByRole("searchbox", { name: "Kategorie" })).toBeVisible();
  await editor.getByRole("button", { name: "Abbrechen" }).click();

  await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
  const chatTarget = page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true });
  await expect(chatTarget.locator(".ui-chat-target-field__change")).toHaveCount(0);
  await expect(chatTarget.locator(".ui-chat-target-field__chevron")).toBeVisible();
});

test("broadcast editing waits for channel:manage:broadcast and offers reconnect to the broadcaster", async ({ page }) => {
  const channelId = "kanal-broadcast-scope-missing";
  await installLiveCockpitMocks(page, {
    channelId,
    role: "broadcaster",
    broadcasterMissingScopes: ["channel:manage:broadcast"],
  });

  await page.goto(`/channels/${channelId}`);
  const titleSlot = page.locator('[data-slot="stream-title-category"]');
  await expect(titleSlot).toContainText("channel:manage:broadcast");
  await expect(titleSlot.getByRole("button", { name: "Titel und Kategorie bearbeiten" })).toBeDisabled();
  await expect(titleSlot.getByRole("button", { name: "Twitch-Zugang erneuern" })).toBeVisible();
});

test("action tiles center reasonless content and keep vote labels within two lines", async ({ page }) => {
  const channelId = "kanal-live-action-centering";
  await page.setViewportSize({ width: 1280, height: 800 });
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    vote: {
      id: "vote-geometry", channelId, kind: "yes_no", optionCount: 2, labels: ["Ja", "Nein"], answerColors: ["#5b8cff", "#ff9f43"], title: "Weiter?",
      status: "open", openedAt: new Date().toISOString(), closesAt: new Date(Date.now() + 90_000).toISOString(),
      requestedDurationSeconds: 120, closedAt: null, closeReason: "manual", counts: [3, 1], voterCount: 4,
    },
  });

  await page.goto(`/channels/${channelId}`);
  const startAction = page.getByRole("button", { name: "Abstimmung starten" });
  const endAction = page.getByRole("button", { name: "Abstimmung beenden" });
  await expect(startAction).toBeVisible();
  await expect(endAction).toBeVisible();
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
    const geometry = await Promise.all([startAction, endAction].map((action) => action.evaluate((element) => {
      const name = element.querySelector<HTMLElement>(".live-action__name");
      if (name === null) throw new Error("The action label should be present for layout checks.");
      const nameBox = name.getBoundingClientRect();
      return {
        labelTop: nameBox.top,
        nameScrollHeight: name.scrollHeight,
        nameClientHeight: name.clientHeight,
        nameScrollWidth: name.scrollWidth,
        nameClientWidth: name.clientWidth,
        whiteSpace: getComputedStyle(name).whiteSpace,
      };
    })));
    const [startGeometry, endGeometry] = geometry;
    expect(startGeometry).toBeDefined();
    expect(endGeometry).toBeDefined();
    if (startGeometry === undefined || endGeometry === undefined) continue;
    expect(Math.abs(startGeometry.labelTop - endGeometry.labelTop)).toBeLessThanOrEqual(1);
    for (const item of geometry) {
      expect(item.nameScrollHeight).toBeLessThanOrEqual(item.nameClientHeight + 1);
      expect(item.nameScrollWidth).toBeLessThanOrEqual(item.nameClientWidth + 1);
      expect(item.whiteSpace).toBe("normal");
    }
  }
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
  const adPopover = page.getByRole("dialog", { name: "Werbung starten" });
  await expect(adPopover).toBeVisible();
  const duration = adPopover.getByRole("group", { name: "Werbedauer" });
  for (const seconds of ["30", "60", "90", "120", "150", "180"]) {
    await expect(duration.getByRole("button", { name: `${seconds} s` })).toBeVisible();
  }
  await expect(adPopover.getByText("Startet sofort.", { exact: true })).toBeVisible();
  const helperToFooterGap = await adPopover.evaluate((dialog) => {
    const helper = dialog.querySelector(".segment-choice-field__hint");
    const footer = dialog.querySelector(".live-action-frame__footer");
    if (helper === null || footer === null) return Number.POSITIVE_INFINITY;
    return footer.getBoundingClientRect().top - helper.getBoundingClientRect().bottom;
  });
  expect(helperToFooterGap).toBeLessThanOrEqual(32);
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
