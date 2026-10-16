import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

const installManagerCockpit = async (
  page: Page,
  channelId: string,
  readBroadcast: () => { title: string; game: { id: string; name: string } | null },
  recordPatch: (body: Record<string, unknown>) => void,
): Promise<void> => {
  await installLiveCockpitMocks(page, { channelId, role: "manager" });
  await page.route(`**/api/channels/${channelId}/broadcast`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(json({ ...readBroadcast(), manageScopeAvailable: true }));
    }
    if (route.request().method() === "PATCH") {
      recordPatch(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.route(`**/api/channels/${channelId}/games**`, (route) => route.fulfill(json({ games: [
    { id: "12345", name: "Stardew Valley", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/12345-{width}x{height}.jpg" },
  ] })));
};

for (const width of [1920, 1280, 390]) {
  test(`broadcast edit control fits its reserved title row at ${String(width)}px`, async ({ page }) => {
    await installLiveCockpitMocks(page, { channelId: `round2-layout-${String(width)}`, role: "manager" });
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1920 ? 1080 : 800 });
    await page.goto(`/channels/round2-layout-${String(width)}`);

    const geometry = await page.locator(".live-cockpit-broadcast__title-row").evaluate((row) => {
      const button = row.querySelector(".live-cockpit-broadcast__edit");
      const category = row.parentElement?.querySelector(":scope > span");
      if (!(button instanceof HTMLElement) || !(category instanceof HTMLElement)) {
        throw new Error("Broadcast title row geometry is incomplete.");
      }
      const rowBox = row.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const categoryBox = category.getBoundingClientRect();
      return {
        rowHeight: rowBox.height,
        buttonHeight: buttonBox.height,
        buttonTop: buttonBox.top,
        rowTop: rowBox.top,
        buttonBottom: buttonBox.bottom,
        rowBottom: rowBox.bottom,
        categoryTop: categoryBox.top,
      };
    });

    expect(geometry.rowHeight).toBeGreaterThanOrEqual(geometry.buttonHeight);
    expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.rowTop);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.rowBottom);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.categoryTop);
  });
}

test("managers see the disabled broadcaster-only reconnect action when scope is missing", async ({ page }) => {
  const channelId = "round2-manager-scope";
  await installLiveCockpitMocks(page, {
    channelId,
    role: "manager",
    broadcasterMissingScopes: ["channel:manage:broadcast"],
  });
  await page.goto(`/channels/${channelId}`);

  const reconnect = page.locator(".live-cockpit-broadcast__actions button");
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toBeDisabled();
  await expect(reconnect).toHaveText(/Twitch-Zugang erneuern|Reconnect Twitch access/u);
  await expect(page.locator(".live-cockpit-broadcast__reason-slot")).toContainText(
    /Nur der Broadcaster kann diese Twitch-Berechtigung erneuern\.|Only the broadcaster can renew this Twitch permission\./u,
  );
});

test("broadcast errors wrap without clipping their message at mobile width", async ({ page }) => {
  const channelId = "round2-broadcast-error";
  await installLiveCockpitMocks(page, { channelId, role: "manager" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/channels/${channelId}/broadcast`, (route) =>
    route.fulfill(json({ error: "Broadcast data could not be loaded. Please retry." }, 503)),
  );
  await page.goto(`/channels/${channelId}`);

  const alert = page.locator(".live-cockpit-broadcast__title-row > strong[role=alert]");
  await expect(alert).toBeVisible();
  const layout = await alert.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(layout.whiteSpace).toBe("normal");
  expect(layout.textOverflow).toBe("clip");
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
});

test("all active Votekick timeouts remain reachable in a fixed-height list", async ({ page }) => {
  const channelId = "round2-all-votekick-timeouts";
  const now = new Date().toISOString();
  const endedAt = new Date(Date.now() - 30_000).toISOString();
  await installLiveCockpitMocks(page, {
    channelId,
    role: "manager",
    modules: [{ id: "votekick", enabled: true, settings: "{}" }],
  });
  await page.route(`**/api/channels/${channelId}/modules/votekick/votekicks`, (route) => route.fulfill(json({
    running: null,
    now,
    votekicks: Array.from({ length: 6 }, (_, index) => ({
      id: `passed-${String(index + 1)}`,
      targetUserId: `viewer-${String(index + 1)}`,
      targetLogin: `viewer_${String(index + 1)}`,
      initiatorUserId: "manager-1",
      status: "passed",
      threshold: 5,
      yesVotes: 7,
      noVotes: 1,
      ballotRevision: 1,
      durationSeconds: 3600,
      startedAt: endedAt,
      endsAt: endedAt,
      endedAt,
      liftedAt: null,
      liftClaimedAt: null,
    })),
  })));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}`);

  const list = page.locator(".live-cockpit-next-list--recent");
  await expect(list.locator(".live-cockpit-next-item")).toHaveCount(6);
  await expect(list.getByRole("button", { name: /Timeout aufheben|Lift timeout/u })).toHaveCount(6);
  const initialGeometry = await list.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    scrollbarColor: getComputedStyle(element).scrollbarColor,
    nextHeadingTop: element.parentElement?.querySelector(":scope > h2:last-of-type")?.getBoundingClientRect().top,
  }));
  expect(initialGeometry.height).toBe(224);
  expect(initialGeometry.scrollHeight).toBeGreaterThan(initialGeometry.clientHeight);
  expect(initialGeometry.paddingBottom).toBeGreaterThanOrEqual(8);
  expect(initialGeometry.scrollbarWidth).toBe("thin");
  expect(initialGeometry.scrollbarColor).not.toBe("auto");
  const liftButton = list.getByRole("button", { name: /Timeout aufheben|Lift timeout/u }).first();
  const liftButtonStyle = await liftButton.evaluate((button) => {
    const style = getComputedStyle(button);
    return { height: button.getBoundingClientRect().height, borderWidth: style.borderTopWidth, borderColor: style.borderTopColor };
  });
  expect(liftButtonStyle.height).toBeGreaterThanOrEqual(28);
  expect(liftButtonStyle.borderWidth).not.toBe("0px");
  expect(liftButtonStyle.borderColor).not.toBe("rgba(0, 0, 0, 0)");

  const finalItem = await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const button = element.querySelector(".live-cockpit-next-item:last-child button");
    const nextHeading = element.parentElement?.querySelector(":scope > h2:last-of-type");
    if (!(button instanceof HTMLElement) || !(nextHeading instanceof HTMLElement)) {
      throw new Error("The final timeout or following heading is missing.");
    }
    return {
      itemName: button.getAttribute("aria-label") ?? button.innerText.trim(),
      buttonBottom: button.getBoundingClientRect().bottom,
      listBottom: element.getBoundingClientRect().bottom,
      itemBottom: element.querySelector(".live-cockpit-next-item:last-child")?.getBoundingClientRect().bottom,
      nextHeadingTop: nextHeading.getBoundingClientRect().top,
    };
  });
  expect(finalItem.itemName).toMatch(/Lift timeout|Timeout aufheben/u);
  expect(finalItem.buttonBottom).toBeLessThanOrEqual(finalItem.listBottom + 0.5);
  expect(finalItem.listBottom - (finalItem.itemBottom ?? finalItem.listBottom)).toBeGreaterThanOrEqual(8);
  expect(finalItem.nextHeadingTop).toBeCloseTo(initialGeometry.nextHeadingTop ?? 0, 0);
});

test("two managers can save title and category without restoring the stale field", async ({ page }) => {
  const channelId = "round2-two-managers";
  let broadcast: { title: string; game: { id: string; name: string } | null } = {
    title: "Demo stream title",
    game: { id: "509658", name: "Just Chatting" },
  };
  const patches: Record<string, unknown>[] = [];
  const recordPatch = (body: Record<string, unknown>): void => {
    patches.push(body);
    broadcast = {
      title: typeof body.title === "string" ? body.title : broadcast.title,
      game: typeof body.gameId === "string"
        ? body.gameId === "" ? null : { id: body.gameId, name: "Stardew Valley" }
        : broadcast.game,
    };
  };
  const managerOne = page;
  const managerTwo = await page.context().newPage();
  await installManagerCockpit(managerOne, channelId, () => broadcast, recordPatch);
  await installManagerCockpit(managerTwo, channelId, () => broadcast, recordPatch);
  await Promise.all([
    managerOne.goto(`/channels/${channelId}`),
    managerTwo.goto(`/channels/${channelId}`),
  ]);
  await Promise.all([
    managerOne.locator(".live-cockpit-broadcast__edit").click(),
    managerTwo.locator(".live-cockpit-broadcast__edit").click(),
  ]);

  await managerOne.getByLabel(/Stream title|Streamtitel/u).fill("Updated by manager one");
  await managerOne.getByRole("button", { name: /Save changes|Änderungen speichern/u }).click();
  await expect(managerOne.getByRole("dialog")).toHaveCount(0);

  const categorySearch = managerTwo.getByRole("dialog").getByRole("searchbox", { name: /Category|Kategorie/u });
  await categorySearch.fill("Stardew Valley");
  await managerTwo.getByRole("option", { name: "Stardew Valley" }).click();
  await managerTwo.getByRole("button", { name: /Save changes|Änderungen speichern/u }).click();
  await expect(managerTwo.getByRole("dialog")).toHaveCount(0);

  expect(patches).toEqual([
    { title: "Updated by manager one" },
    { gameId: "12345" },
  ]);
  await expect(managerTwo.locator('[data-slot="stream-title-category"]'))
    .toContainText("Updated by manager one");
  await managerTwo.close();
});
