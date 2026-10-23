import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-509-clarity";
const viewports = [{ width: 1920, height: 1080 }, { width: 390, height: 844 }] as const;
const longVoteTitle = "Welches Spiel spielen wir am kommenden Wochenende zusammen im Community-Stream?";
const modules = ["ads", "chat_voting", "raid", "timers", "votekick"].map((id) => ({ id, enabled: true, settings: "{}" }));
const members = [
  { userId: "viewer-509", login: "mira_fox", displayName: "Mira Fox", profileImageUrl: null, role: "manager", joinedAt: "2025-08-13T10:00:00.000Z" },
  { userId: "operator-509", login: "otto_owl", displayName: "Otto Owl", profileImageUrl: null, role: "operator", joinedAt: "2026-03-04T09:30:00.000Z" },
  { userId: "owner-509", login: "demo-kanal", displayName: "Demo Kanal", profileImageUrl: null, role: "broadcaster", joinedAt: "2024-01-10T14:15:00.000Z" },
] as const;
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

interface Controls {
  setRaidState: (state: "ready" | "empty" | "error") => void;
  holdRaidState: () => void;
  releaseRaidState: () => void;
  setLock: (lock: "idle" | "chat_vote" | "long_chat_vote" | "votekick") => void;
  setAds: (ads: "none" | "upcoming" | "running") => void;
  setDuels: (duels: readonly Record<string, unknown>[]) => void;
  addActions: () => number;
  holdSnooze: () => void;
  releaseSnooze: () => void;
}

const installMocks = async (page: Page, role: "manager" | "operator", duels: readonly Record<string, unknown>[] = [], enableDuel = false): Promise<Controls> => {
  let raidState: "ready" | "empty" | "error" = "ready";
  let raidGate: Promise<void> = Promise.resolve();
  let releaseRaid = (): void => undefined;
  let lock: "idle" | "chat_vote" | "long_chat_vote" | "votekick" = "idle";
  let ads: "none" | "upcoming" | "running" = "none";
  const activeModules = duels.length === 0 && !enableDuel ? [...modules] : [...modules, { id: "duel", enabled: true, settings: "{}" }, { id: "belabox", enabled: true, settings: "{}" }];
  let activeDuels = [...duels];
  let snoozeGate: Promise<void> = Promise.resolve();
  let releaseSnooze = (): void => undefined;

  await installLiveCockpitMocks(page, {
    channelId,
    role,
    modules: activeModules,
    duels,
  });
  await page.route(`**/api/channels/${channelId}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice(`/api/channels/${channelId}`.length);
    const method = route.request().method();
    const now = Date.now();
    if (path === "/modules/duel/rounds" && method === "GET") return route.fulfill(json(activeDuels));
    if (path === "/members" && method === "GET") return route.fulfill(json({ members, nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer-509" }));
    if (path === "/modules/text_commands/commands" && method === "GET") return route.fulfill(json({ commands: [], warnings: [] }));
    if (path === "/template-variables" || path === "/variables") return route.fulfill(json({ variables: [] }));
    if (path === "/modules/votekick/settings" && method === "GET") return route.fulfill(json({ settings: DEFAULT_VOTEKICK_SETTINGS, revision: 1, variables: [] }));
    if (/^\/modules\/[^/]+\/settings$/u.test(path) && method === "GET") return route.fulfill(json({ settings: {}, revision: 1, variables: [] }));
    if (path === "/modules/raid/state") {
      await raidGate;
      if (raidState === "error") return route.fulfill(json({ error: "raid_state_unavailable" }, 500));
      return route.fulfill(json(raidState === "ready"
        ? {
          ready: true,
          shoutoutThreshold: 3,
          lastRaid: { channel: "fuchsbau_tv", viewers: 12, at: new Date(now - 3 * 3_600_000).toISOString() },
          lastShoutout: { channel: "fuchsbau_tv", at: new Date(now - 3 * 3_600_000).toISOString() },
        }
        : { ready: false, shoutoutThreshold: null, lastRaid: null, lastShoutout: null }));
    }
    if (path === "/modules/votekick/votekicks" && method === "GET") {
      const running = lock === "votekick"
        ? { id: "votekick-509", status: "running", targetUserId: "target-509", targetLogin: "troll_tim", endsAt: new Date(now + 75_000).toISOString() }
        : null;
      return route.fulfill(json({ running, votekicks: running === null ? [] : [running], now: new Date(now).toISOString() }));
    }
    if (path === "/modules/chat_voting/current") {
      const vote = lock === "chat_vote" || lock === "long_chat_vote"
        ? {
          id: "vote-509",
          channelId,
          kind: "options",
          optionCount: 3,
          labels: ["Abenteuer", "Strategie", "Rollenspiel"],
          answerColors: [],
          status: "open",
          title: lock === "long_chat_vote" ? longVoteTitle : "Was spielen wir als Nächstes?",
          openedAt: new Date(now - 60_000).toISOString(),
          closesAt: new Date(now + 90_000).toISOString(),
          requestedDurationSeconds: 120,
          closedAt: null,
          closeReason: "timer",
          counts: [3, 1, 0],
          voterCount: 4,
        }
        : null;
      return route.fulfill(json({ vote, counts: vote === null ? null : [3, 1, 0], revision: 1, terms: null, moreTerms: null, hasOpenBallot: vote !== null, defaultDurationSeconds: 120 }));
    }
    // A fixed header status: the module is enabled from the start, so the BELABOX indicator never changes text.
    if (path === "/modules/belabox/status" && method === "GET") {
      return route.fulfill(json({ configured: false, updatedAt: null, mode: null, sample: null, errorCode: null, polling: false, pollingDesired: false, streamId: null, belaboxStreamId: null, alertNotice: null, fetchFailureNotice: false, intervalSeconds: 5 }));
    }
    if (path === "/modules/ads/schedule") {
      return route.fulfill(json({
        schedule: {
          nextAdAt: ads === "none" ? null : new Date(now + (ads === "running" ? 40 * 60_000 : 10 * 60_000)).toISOString(),
          duration: ads === "none" ? null : 60,
          lastAdAt: null,
          prerollFreeTime: null,
          snoozeCount: ads === "none" ? 0 : 2,
          snoozeRefreshAt: null,
        },
        recentAdBreaks: ads === "running" ? [{ timestamp: new Date(now - 20_000).toISOString(), durationSeconds: 90 }] : [],
        snoozeScopeAvailable: true,
      }));
    }
    if (path === "/modules/ads/snooze" && method === "POST") {
      await snoozeGate;
      return route.fulfill(json({
        schedule: { nextAdAt: new Date(now + 15 * 60_000).toISOString(), duration: 60, lastAdAt: null, prerollFreeTime: null, snoozeCount: 1, snoozeRefreshAt: null },
        recentAdBreaks: [],
        snoozeScopeAvailable: true,
      }));
    }
    return route.fallback();
  });

  return {
    setRaidState: (state) => { raidState = state; },
    holdRaidState: () => { raidGate = new Promise<void>((resolve) => { releaseRaid = resolve; }); },
    releaseRaidState: () => { releaseRaid(); },
    setLock: (next) => { lock = next; },
    setAds: (next) => { ads = next; },
    setDuels: (next) => {
      activeDuels = [...next];
      if (activeDuels.length > 0 && !activeModules.some((module) => module.id === "duel")) {
        activeModules.push({ id: "duel", enabled: true, settings: "{}" });
      }
    },
    addActions: () => {
      const actionModuleIds = ["clips", "channel_events", "blitz_round"];
      activeModules.push(...actionModuleIds.map((id) => ({ id, enabled: true, settings: "{}" })));
      return actionModuleIds.length;
    },
    holdSnooze: () => { snoozeGate = new Promise<void>((resolve) => { releaseSnooze = resolve; }); },
    releaseSnooze: () => { releaseSnooze(); },
  };
};

const open = async (
  page: Page,
  viewport: { width: number; height: number },
  path: string,
  prepare?: (controls: Controls) => void,
  role: "manager" | "operator" = "manager",
  duels: readonly Record<string, unknown>[] = [],
  enableDuel = false,
): Promise<Controls> => {
  await page.unrouteAll({ behavior: "wait" });
  await page.setViewportSize(viewport);
  const controls = await installMocks(page, role, duels, enableDuel);
  prepare?.(controls);
  await page.goto(`/channels/${channelId}${path}`);
  return controls;
};

const box = async (locator: Locator) => {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("Expected a visible element with a bounding box.");
  return result;
};

const boxes = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}));

type BoxGeometry = Awaited<ReturnType<typeof box>>;
type CockpitGeometry = Record<"ads" | "running" | "next" | "actions" | "header", BoxGeometry>;

// Positions are relative to the wall: the page header may differ between page loads.
const cockpitGeometry = async (page: Page): Promise<CockpitGeometry> => {
  const wall = await box(page.locator(".live-cockpit__wall"));
  const relative = async (selector: string): Promise<BoxGeometry> => {
    const tile = await box(page.locator(selector));
    return { ...tile, x: tile.x - wall.x, y: tile.y - wall.y };
  };
  return {
    header: await box(page.locator(".live-cockpit-header")),
    ads: await relative(".live-cockpit-ads-tile"),
    running: await relative(".live-cockpit-running-tile"),
    next: await relative(".live-cockpit-next-tile"),
    actions: await relative(".live-cockpit-actions"),
  };
};

const expectCockpitGeometryStable = (before: CockpitGeometry, after: CockpitGeometry): void => {
  expect(Math.abs(before.header.height - after.header.height), "header height changed (pre-existing header wrap, not a tile shift)").toBeLessThanOrEqual(1);
  for (const tile of ["ads", "running", "next", "actions"] as const) {
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(before[tile][dimension] - after[tile][dimension]), `${tile} ${dimension} changed`).toBeLessThanOrEqual(1);
    }
  }
};

const expectNoHorizontalScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};

const expectCockpitContentReachable = async (page: Page): Promise<void> => {
  const violations = await page.locator(".live-cockpit__wall").evaluate((wall) => {
    const failures: string[] = [];
    const tileSelector = ".live-cockpit-actions, .live-cockpit-running-tile, .live-cockpit-ads-tile, .live-cockpit-next-tile, .live-cockpit-event-feed";
    const targetSelector = "button, h2, .live-vote-tile__option, .live-vote-tile__track, .live-vote-tile__track > span, .live-cockpit-duels__item, .live-cockpit-next-tile p";
    const isInside = (target: DOMRect, ancestor: HTMLElement, axis: "x" | "y"): boolean => {
      const rect = ancestor.getBoundingClientRect();
      const start = axis === "x" ? rect.left + ancestor.clientLeft : rect.top + ancestor.clientTop;
      const size = axis === "x" ? ancestor.clientWidth : ancestor.clientHeight;
      const targetStart = axis === "x" ? target.left : target.top;
      const targetEnd = axis === "x" ? target.right : target.bottom;
      return targetStart >= start - 0.5 && targetEnd <= start + size + 0.5;
    };
    const canScrollTo = (target: DOMRect, scroller: HTMLElement, axis: "x" | "y"): boolean => {
      const rect = scroller.getBoundingClientRect();
      const start = axis === "x" ? rect.left + scroller.clientLeft : rect.top + scroller.clientTop;
      const targetStart = axis === "x" ? target.left : target.top;
      const targetEnd = axis === "x" ? target.right : target.bottom;
      const scrollPosition = axis === "x" ? scroller.scrollLeft : scroller.scrollTop;
      const clientSize = axis === "x" ? scroller.clientWidth : scroller.clientHeight;
      const scrollSize = axis === "x" ? scroller.scrollWidth : scroller.scrollHeight;
      const contentStart = targetStart - start + scrollPosition;
      const contentEnd = targetEnd - start + scrollPosition;
      return targetEnd - targetStart <= clientSize + 0.5 && contentStart >= -0.5 && contentEnd <= scrollSize + 0.5;
    };
    const tiles = [...wall.querySelectorAll<HTMLElement>(tileSelector)];
    for (const [tileIndex, tile] of tiles.entries()) {
      const targets = [...tile.querySelectorAll<HTMLElement>(targetSelector)];
      for (const [targetIndex, target] of targets.entries()) {
        const targetRect = target.getBoundingClientRect();
        if (targetRect.width === 0 || targetRect.height === 0 || getComputedStyle(target).visibility === "hidden") continue;
        for (let ancestor = target.parentElement; ancestor !== null && tile.contains(ancestor); ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          for (const axis of ["x", "y"] as const) {
            const overflow = axis === "x" ? style.overflowX : style.overflowY;
            if (overflow === "visible" || isInside(targetRect, ancestor, axis)) continue;
            const stableScrollAncestors: HTMLElement[] = [];
            for (let candidate = target.parentElement; candidate !== null && candidate !== ancestor; candidate = candidate.parentElement) {
              const candidateStyle = getComputedStyle(candidate);
              const candidateOverflow = axis === "x" ? candidateStyle.overflowX : candidateStyle.overflowY;
              if ((candidateOverflow === "auto" || candidateOverflow === "scroll") && candidateStyle.scrollbarGutter.includes("stable") && canScrollTo(targetRect, candidate, axis)) {
                stableScrollAncestors.push(candidate);
              }
            }
            const ancestorCanScroll = (overflow === "auto" || overflow === "scroll") && style.scrollbarGutter.includes("stable") && canScrollTo(targetRect, ancestor, axis);
            const reachableInside = (scroller: HTMLElement): boolean => scroller === ancestor || isInside(scroller.getBoundingClientRect(), ancestor, axis);
            if (!ancestorCanScroll && !stableScrollAncestors.some(reachableInside)) {
              failures.push(`tile ${String(tileIndex)} target ${String(targetIndex)} clipped on ${axis} at .${ancestor.className.replaceAll(" ", ".")}`);
            }
          }
        }
      }
    }
    return failures;
  });
  expect(violations).toEqual([]);
};

const cockpitVoteOptionExposure = async (page: Page): Promise<{ visible: boolean[]; reachable: boolean[] }> => page.locator(".live-vote-tile__options").evaluate((element) => {
  const options = element as HTMLElement;
  const tile = options.closest<HTMLElement>(".live-cockpit-running-tile");
  const optionElements = [...options.querySelectorAll<HTMLElement>(".live-vote-tile__option")];
  const isInside = (target: DOMRect, ancestor: HTMLElement, axis: "x" | "y"): boolean => {
    const rect = ancestor.getBoundingClientRect();
    const start = axis === "x" ? rect.left + ancestor.clientLeft : rect.top + ancestor.clientTop;
    const size = axis === "x" ? ancestor.clientWidth : ancestor.clientHeight;
    const targetStart = axis === "x" ? target.left : target.top;
    const targetEnd = axis === "x" ? target.right : target.bottom;
    return targetStart >= start - 0.5 && targetEnd <= start + size + 0.5;
  };
  const canScrollTo = (target: DOMRect, scroller: HTMLElement, axis: "x" | "y"): boolean => {
    const rect = scroller.getBoundingClientRect();
    const start = axis === "x" ? rect.left + scroller.clientLeft : rect.top + scroller.clientTop;
    const targetStart = axis === "x" ? target.left : target.top;
    const targetEnd = axis === "x" ? target.right : target.bottom;
    const scrollPosition = axis === "x" ? scroller.scrollLeft : scroller.scrollTop;
    const clientSize = axis === "x" ? scroller.clientWidth : scroller.clientHeight;
    const scrollSize = axis === "x" ? scroller.scrollWidth : scroller.scrollHeight;
    const contentStart = targetStart - start + scrollPosition;
    const contentEnd = targetEnd - start + scrollPosition;
    return targetEnd - targetStart <= clientSize + 0.5 && contentStart >= -0.5 && contentEnd <= scrollSize + 0.5;
  };
  return {
    visible: optionElements.map((option) => {
      const rect = option.getBoundingClientRect();
      if (tile === null) return false;
      for (let ancestor = option.parentElement; ancestor !== null && tile.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" && !isInside(rect, ancestor, "x")) return false;
        if (style.overflowY !== "visible" && !isInside(rect, ancestor, "y")) return false;
      }
      return true;
    }),
    reachable: optionElements.map((option) => {
      const rect = option.getBoundingClientRect();
      if (tile === null) return false;
      for (let ancestor = option.parentElement; ancestor !== null && tile.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        for (const axis of ["x", "y"] as const) {
          const overflow = axis === "x" ? style.overflowX : style.overflowY;
          if (overflow === "visible" || isInside(rect, ancestor, axis)) continue;
          const ancestorStyleCanScroll = (overflow === "auto" || overflow === "scroll") && style.scrollbarGutter.includes("stable") && canScrollTo(rect, ancestor, axis);
          let nestedStableScrollerCanReach = false;
          for (let candidate = option.parentElement; candidate !== null && candidate !== ancestor; candidate = candidate.parentElement) {
            const candidateStyle = getComputedStyle(candidate);
            const candidateOverflow = axis === "x" ? candidateStyle.overflowX : candidateStyle.overflowY;
            if ((candidateOverflow === "auto" || candidateOverflow === "scroll") && candidateStyle.scrollbarGutter.includes("stable") && canScrollTo(rect, candidate, axis) && isInside(candidate.getBoundingClientRect(), ancestor, axis)) {
              nestedStableScrollerCanReach = true;
            }
          }
          if (!ancestorStyleCanScroll && !nestedStableScrollerCanReach) return false;
        }
      }
      return true;
    }),
  };
});

for (const viewport of viewports) {
  const size = `${String(viewport.width)}x${String(viewport.height)}`;

  test.describe(size, () => {
    test("members: the role matrix opens without moving anything outside it", async ({ page }) => {
      await open(page, viewport, "/members");
      await page.getByRole("link", { name: /Otto Owl/u }).click();
      await page.getByRole("tab", { name: "Berechtigungen" }).click();
      const matrix = page.locator(".role-matrix");
      await expect(matrix).toBeVisible();
      await expect(page.locator(".role-matrix__table")).toBeHidden();
      await expectNoHorizontalScroll(page);

      const summary = matrix.locator("summary");
      const before = {
        page: await box(page.locator(".collection-page__heading--page-header")),
        summary: await box(summary),
        rows: await boxes(page.locator(".members-collection__rows .list-row")),
      };
      await summary.click();
      await expect(page.locator(".role-matrix__table tbody tr")).toHaveCount(12);
      await expect(page.locator(".role-matrix__table thead th")).toHaveCount(4);
      const matrixMetrics = await page.locator(".role-matrix__scroll").evaluate((element) => {
        const firstHeader = element.querySelector("thead th:first-child");
        const roleHeader = element.querySelector("thead th:nth-child(2)");
        return {
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          stickyColumn: firstHeader === null ? "" : getComputedStyle(firstHeader).position,
          stickyLeft: firstHeader === null ? "" : getComputedStyle(firstHeader).left,
          roleHeaderWhiteSpace: roleHeader === null ? "" : getComputedStyle(roleHeader).whiteSpace,
        };
      });
      expect(matrixMetrics.stickyColumn).toBe("sticky");
      expect(matrixMetrics.stickyLeft).toBe("0px");
      expect(matrixMetrics.roleHeaderWhiteSpace).toBe("nowrap");
      if (viewport.width >= 1280) expect(matrixMetrics.scrollHeight).toBe(matrixMetrics.clientHeight);
      else expect(matrixMetrics.scrollWidth).toBeGreaterThan(matrixMetrics.clientWidth);
      expect(await box(page.locator(".collection-page__heading--page-header"))).toEqual(before.page);
      expect(await box(summary)).toEqual(before.summary);
      if (viewport.width >= 1280) expect(await boxes(page.locator(".members-collection__rows .list-row"))).toEqual(before.rows);
      await expectNoHorizontalScroll(page);
      // Each cell announces its role and the verdict for screen readers.
      await expect(page.locator(".role-matrix__table tbody tr").first().locator("td .sr-only").first()).toContainText(/Erlaubt|Nicht erlaubt/u);

      await summary.click();
      await expect(page.locator(".role-matrix__table")).toBeHidden();
      expect(await box(summary)).toEqual(before.summary);
    });

    test("members: the read-only view of an operator still offers the matrix", async ({ page }) => {
      await open(page, viewport, "/members", undefined, "operator");
      await page.getByRole("link", { name: /Otto Owl/u }).click();
      await expect(page.getByRole("tab", { name: "Berechtigungen" })).toHaveCount(0);
      await expect(page.locator(".role-matrix summary")).toBeVisible();
      await page.locator(".role-matrix summary").click();
      await expect(page.locator(".role-matrix__table tbody tr")).toHaveCount(12);
      await expectNoHorizontalScroll(page);
    });

    test("raid: the state card shows ready and empty data and loading does not move the settings", async ({ page }) => {
      const controls = await open(page, viewport, "/modules/raid", (next) => { next.holdRaidState(); });
      const card = page.getByRole("region", { name: "Zustand" });
      const column = page.locator(".settings-page__column-stack").first();
      const editors = page.locator(".ui-settings-editor");
      await expect(page.locator(".raid-state-card--loading")).toBeVisible();
      const loadingCard = await box(page.locator(".raid-state-card--loading"));
      const before = { column: await box(column), editors: await boxes(editors) };
      controls.releaseRaidState();
      await expect(card).toContainText("Raid-Erkennung bereit");
      await expect(card).toContainText("fuchsbau_tv");
      await expect(card).toContainText("Automatische Shoutouts starten ab 3 Raid-Zuschauern.");
      expect(await box(card)).toEqual(loadingCard);
      if (viewport.width >= 1280) {
        const rowsBox = await box(card.locator(".raid-state-card__rows"));
        const footnoteBox = await box(card.locator(".raid-state-card__footnote"));
        expect(footnoteBox.y - rowsBox.y - rowsBox.height).toBeLessThanOrEqual(40);
      }
      expect.soft(await box(column)).toEqual(before.column);
      expect.soft(await boxes(editors)).toEqual(before.editors);
      await expectNoHorizontalScroll(page);

      const readyCard = await box(card);
      await open(page, viewport, "/modules/raid", (next) => { next.setRaidState("empty"); });
      const emptyCard = page.getByRole("region", { name: "Zustand" });
      await expect(emptyCard).toContainText("Wartet auf Twitch-Ereignisse");
      await expect(emptyCard).toContainText("Noch kein Raid");
      await expect(emptyCard).toContainText("Noch kein Shoutout");
      expect(await box(emptyCard)).toEqual(readyCard);
      await open(page, viewport, "/modules/raid", (next) => { next.setRaidState("error"); });
      const errorCard = page.getByRole("region", { name: "Zustand" });
      await expect(errorCard).toContainText("Der Raid-Verlauf konnte nicht geladen werden.");
      expect(await box(errorCard)).toEqual(readyCard);
      await expectNoHorizontalScroll(page);
    });

    test("votekick: the lock card swaps idle and running without moving the form, and the example follows the inputs", async ({ page }) => {
      const controls = await open(page, viewport, "/modules/votekick");
      const lock = page.getByRole("region", { name: "Gegenseitige Sperre" });
      await expect(lock).toContainText("Gerade läuft keine Abstimmung.");
      await expect(lock).toContainText("Keine Abstimmung aktiv");
      const columns = page.locator(".ui-editor-shell__columns");
      const lockBefore = await box(lock);
      expect(lockBefore.height).toBe(96);
      const columnsBefore = await box(columns);
      const example = page.locator(".votekick-threshold-example");
      const bodyBefore = await boxes(page.locator(".ui-editor-shell__column"));

      controls.setLock("chat_vote");
      await expect(lock).toContainText("Was spielen wir als Nächstes? · endet in", { timeout: 12_000 });
      await expect(lock).toContainText("Abstimmung läuft");
      expect(await box(lock)).toEqual(lockBefore);
      expect(await box(columns)).toEqual(columnsBefore);
      expect(await boxes(page.locator(".ui-editor-shell__column"))).toEqual(bodyBefore);

      controls.setLock("long_chat_vote");
      const lockTitle = lock.locator(".votekick-lock-card__main-title");
      const countdown = lock.locator(".votekick-lock-card__main-countdown");
      await expect(lockTitle).toHaveAttribute("title", longVoteTitle, { timeout: 12_000 });
      await expect(countdown).toBeVisible();
      await expect(countdown).toContainText("endet in");
      const [cardBox, countdownBox] = await Promise.all([box(lock), box(countdown)]);
      expect(countdownBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(countdownBox.x + countdownBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

      controls.setLock("votekick");
      await expect(lock).toContainText("Votekick gegen troll_tim · endet in", { timeout: 12_000 });
      expect(await box(lock)).toEqual(lockBefore);
      expect(await box(columns)).toEqual(columnsBefore);
      await expectNoHorizontalScroll(page);

      // Defaults are 5 net votes and 20 percent; the example uses 34 active chatters.
      await expect(example).toContainText("7 Netto-Ja-Stimmen nötig");
      await expect(example).toContainText("Beispiel: 34 aktive Chatter");
      const minimum = page.getByLabel("Mindest-Netto-Ja-Stimmen");
      const percent = page.getByLabel("Aktive Chatter in Prozent");
      const exampleBefore = await box(example);
      expect(exampleBefore.height).toBe(32);
      expect(exampleBefore.y).toBeLessThan((await box(minimum)).y);
      const ruleNote = page.locator('.ui-settings-editor[data-section="settings"] .ui-rule-note');
      const exampleFollowsRule = await ruleNote.evaluate((element) => element.nextElementSibling?.classList.contains("votekick-threshold-example") ?? false);
      expect(exampleFollowsRule).toBe(true);
      await minimum.fill("9");
      await expect(example).toContainText("9 Netto-Ja-Stimmen nötig");
      await percent.fill("100");
      await expect(example).toContainText("34 Netto-Ja-Stimmen nötig");
      for (const value of ["1", "10", "100", "1000", "10000", "100000", "", "0", "7"]) {
        await minimum.fill(value);
        expect((await box(example)).height, `example height after typing "${value}"`).toBe(exampleBefore.height);
      }
      await percent.fill("");
      await expect(example).toContainText("Werte prüfen");
      expect((await box(example)).height).toBe(exampleBefore.height);
      await percent.fill("20");
      await minimum.fill("5");
      await expect(example).toContainText("7 Netto-Ja-Stimmen nötig");
      expect((await box(example)).height).toBe(exampleBefore.height);
      await expectNoHorizontalScroll(page);
    });

    test("cockpit: the ads tile keeps the tile wall fixed across upcoming, running and empty schedules", async ({ page }) => {
      const controls = await open(page, viewport, "", (next) => { next.setAds("none"); });
      const tile = page.locator(".live-cockpit-ads-tile");
      await expect(tile).toHaveAttribute("data-state", "no_schedule");
      await expect(tile).toContainText("Keine Werbepause geplant");
      await expect(tile.locator("h2 > span")).toHaveText("Werbepause");
      expect(await tile.locator("h2 > span").evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
      expect(await tile.locator(".live-cockpit-ads-tile__status").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await tile.locator(".live-cockpit-ads-tile__duration").evaluate((element) => element.textContent.trim())).toBe("");
      await expect(tile.getByRole("button", { name: /verschieben/iu })).toBeDisabled();
      const wall = page.locator(".live-cockpit__wall");
      const children = page.locator(".live-cockpit__wall > *, .live-cockpit__running > *");
      const reference = { wall: await box(wall), children: await boxes(children), tile: await box(tile) };

      controls.setAds("upcoming");
      await expect(tile).toHaveAttribute("data-state", "upcoming", { timeout: 15_000 });
      await expect(tile).toContainText("Verschieben: 2 Joker");
      await expect(tile.getByRole("button", { name: /verschieben/iu })).toBeEnabled();
      expect(await box(wall)).toEqual(reference.wall);
      expect(await boxes(children)).toEqual(reference.children);
      expect(await box(tile)).toEqual(reference.tile);
      await expectNoHorizontalScroll(page);

      controls.setAds("running");
      await expect(tile).toHaveAttribute("data-state", "running", { timeout: 15_000 });
      await expect(tile).toContainText("Werbepause läuft");
      await expect(tile).toContainText("Restzeit");
      await expect(tile.locator(".live-cockpit-ads-tile__status").getByText("Werbepause läuft", { exact: true })).toHaveCount(1);
      expect(await tile.locator(".live-cockpit-ads-tile__duration").evaluate((element) => element.textContent.trim())).toBe("");
      await expect(tile.getByRole("button", { name: /verschieben/iu })).toBeDisabled();
      expect(await box(wall)).toEqual(reference.wall);
      expect(await boxes(children)).toEqual(reference.children);
      expect(await box(tile)).toEqual(reference.tile);
      await expectNoHorizontalScroll(page);

      controls.setAds("none");
      await expect(tile).toHaveAttribute("data-state", "no_schedule", { timeout: 15_000 });
      expect(await boxes(children)).toEqual(reference.children);
    });

    test("cockpit: snooze stays disabled until its request finishes", async ({ page }) => {
      const controls = await open(page, viewport, "", (next) => { next.setAds("upcoming"); });
      controls.holdSnooze();
      const tile = page.locator(".live-cockpit-ads-tile");
      const snooze = tile.getByRole("button", { name: /verschieben/iu });
      await expect(snooze).toBeEnabled();
      await snooze.click();
      await expect(snooze).toBeDisabled();
      controls.releaseSnooze();
      await expect(snooze).toBeEnabled();
    });

    test("cockpit: the removed ad entry no longer shows up under Next up", async ({ page }) => {
      await open(page, viewport, "", (next) => { next.setAds("upcoming"); });
      await expect(page.locator(".live-cockpit-ads-tile")).toHaveAttribute("data-state", "upcoming");
      await expect(page.locator(".live-cockpit-next-tile .live-cockpit-next-item")).toHaveCount(0);
    });
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 800 },
  { width: 1024, height: 800 },
  { width: 1100, height: 800 },
  { width: 1101, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`cockpit: geometry stays stable and content is reachable at ${String(viewport.width)}x${String(viewport.height)}`, async ({ page }) => {
    const voteNow = Date.now();
    const duel = {
      id: "duel-509-stable-geometry",
      kind: "duel",
      challenger: "spielende_katze",
      target: "rasender_fuchs",
      stake: 1_250,
      closesAt: new Date(voteNow + 75_000).toISOString(),
    };
    const controls = await open(page, viewport, "", (next) => { next.setAds("running"); }, "manager", [], true);
    const actions = page.locator(".live-cockpit-actions__grid .live-action");
    await expect(actions.first()).toBeVisible();
    await expect(page.locator(".live-cockpit-ads-tile")).toHaveAttribute("data-state", "running");
    const initialActionCount = await actions.count();
    const initial = await cockpitGeometry(page);
    expect(initial.ads.height).toBe(188);

    controls.setLock("chat_vote");
    await expect(page.locator(".live-cockpit-running-tile").getByTestId("live-vote-tile")).toBeVisible({ timeout: 12_000 });
    expectCockpitGeometryStable(initial, await cockpitGeometry(page));

    // The enabled duel module picks this round up through the cockpit's live-data poll.
    controls.setDuels([duel]);
    await expect(page.locator(".live-cockpit-running-tile").getByTestId("live-duel-tile")).toBeVisible({ timeout: 15_000 });
    expectCockpitGeometryStable(initial, await cockpitGeometry(page));

    const addedActionCount = controls.addActions();
    const shortcut = await page.evaluate(() => /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent) ? "Meta+k" : "Control+k");
    await page.keyboard.press(shortcut);
    const palette = page.locator(".command-palette");
    await expect(palette).toBeVisible();
    // A channel-control command uses the dashboard's normal channel refresh, which reloads the module list.
    const channelRefresh = page.waitForResponse((response) => response.url().endsWith("/api/channels") && response.request().method() === "GET");
    await palette.locator('[data-command-palette-item-id="action:channel-mute"]').click();
    await channelRefresh;
    await expect(actions).toHaveCount(initialActionCount + addedActionCount);
    expectCockpitGeometryStable(initial, await cockpitGeometry(page));

    const tile = page.locator(".live-cockpit-running-tile");
    await expect(tile.getByTestId("live-vote-tile")).toBeVisible();
    await expect(tile.getByTestId("live-duel-tile")).toBeVisible();
    const adsTile = page.locator(".live-cockpit-ads-tile");
    await expect(adsTile).toHaveAttribute("data-state", "running");
    const optionLabels = ["Abenteuer", "Strategie", "Rollenspiel"];
    const voteOptions = tile.locator(".live-vote-tile__options");
    await expect(voteOptions.locator(".live-vote-tile__option-label strong")).toHaveText(optionLabels);
    const geometry = await cockpitGeometry(page);
    expect(geometry.ads.height).toBe(188);
    if (viewport.width >= 768) {
      const actions = page.locator(".live-cockpit-actions");
      const actionsGrid = actions.locator(".live-cockpit-actions__grid");
      const [actionsBox, actionsGridBox, adsBox, wallBox] = await Promise.all([
        box(actions),
        box(actionsGrid),
        box(adsTile),
        box(page.locator(".live-cockpit__wall")),
      ]);
      expect(adsBox.height).toBe(188);
      expect(adsBox.x).toBeCloseTo(actionsBox.x, 0);
      expect(adsBox.width).toBeCloseTo(actionsBox.width, 0);
      expect(adsBox.y).toBeGreaterThanOrEqual(actionsBox.y + actionsBox.height);
      expect(adsBox.y).toBeGreaterThanOrEqual(actionsGridBox.y + actionsGridBox.height);

      const [runningBox, nextBox] = await Promise.all([
        box(page.locator(".live-cockpit-running-tile")),
        box(page.locator(".live-cockpit-next-tile")),
      ]);
      expect(runningBox.y).toBeCloseTo(wallBox.y, 0);
      expect(runningBox.x).toBeCloseTo(nextBox.x, 0);
      expect(runningBox.width).toBeCloseTo(nextBox.width, 0);
      if (viewport.width <= 1280) expect(runningBox.height).toBe(352);
      else expect(runningBox.height).toBeGreaterThanOrEqual(280);
      expect(nextBox.y).toBeGreaterThanOrEqual(runningBox.y + runningBox.height);
      if (viewport.width <= 1399) expect(nextBox.height).toBe(188);
      if (viewport.width <= 1100) {
        expect(wallBox.height).toBe(844);
        expect(geometry.actions.height).toBe(352);
        expect(geometry.running.height).toBe(352);
        expect(geometry.next.height).toBe(188);
        expect(geometry.ads.y).toBe(geometry.actions.y + geometry.actions.height + 12);
        expect(geometry.next.y).toBe(geometry.running.y + geometry.running.height + 12);
        expect(geometry.running.x).toBe(geometry.actions.x + geometry.actions.width + 12);
        expect(geometry.next.x).toBe(geometry.running.x);
        const eventsBox = await box(page.locator(".live-cockpit-event-feed"));
        expect(eventsBox.x).toBeCloseTo(wallBox.x, 0);
        expect(eventsBox.width).toBeCloseTo(wallBox.width, 0);
        expect(eventsBox.height).toBe(280);
        expect(eventsBox.y).toBeCloseTo(nextBox.y + nextBox.height + 12, 0);
      } else if (viewport.width <= 1399) {
        expect(wallBox.height).toBe(552);
        expect(geometry.running.height).toBe(352);
        expect(geometry.next.height).toBe(188);
        expect(geometry.ads.y).toBeGreaterThanOrEqual(geometry.actions.y + geometry.actions.height);
        expect(nextBox.y + nextBox.height).toBeCloseTo(wallBox.y + wallBox.height, 0);
      }

      const votekickEmptyText = page.locator(".live-cockpit-next-list--recent p");
      await expect(votekickEmptyText).toBeVisible();
      await expect(votekickEmptyText).toHaveText("Keine offenen Timeouts aus Votekicks.");
      if (viewport.width >= 1024) {
        const votekickEmptyTextVisibility = await votekickEmptyText.evaluate((element) => {
          const list = element.parentElement;
          if (list === null) return { scrollTop: -1, fullyVisible: false };
          const listRect = list.getBoundingClientRect();
          const textRect = element.getBoundingClientRect();
          const contentTop = listRect.top + list.clientTop;
          const contentLeft = listRect.left + list.clientLeft;
          return {
            scrollTop: list.scrollTop,
            fullyVisible: textRect.top >= contentTop - 0.5 && textRect.bottom <= contentTop + list.clientHeight + 0.5 &&
              textRect.left >= contentLeft - 0.5 && textRect.right <= contentLeft + list.clientWidth + 0.5,
          };
        });
        expect(votekickEmptyTextVisibility.scrollTop).toBe(0);
        expect(votekickEmptyTextVisibility.fullyVisible).toBe(true);
        await expect(page.getByRole("heading", { name: "Als Nächstes", exact: true })).toBeVisible();
      }
      if (viewport.width >= 1920) {
        expect(runningBox.width).toBeGreaterThanOrEqual(400);
        const title = tile.getByText("Was spielen wir als Nächstes?").first();
        const fit = await title.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
        expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
      }
    } else {
      const stackedSlots = await page.locator(".live-cockpit__running > .live-cockpit-reserve, .live-cockpit__running > .live-cockpit-ads-tile").evaluateAll((elements) => elements.map((element) => ({
        slot: element.classList.contains("live-cockpit-running-tile") ? "running"
          : element.classList.contains("live-cockpit-ads-tile") ? "ads" : "next",
        y: element.getBoundingClientRect().y,
      })));
      expect(stackedSlots.map(({ slot }) => slot)).toEqual(["running", "ads", "next"]);
      expect(stackedSlots[0]?.y).toBeLessThan(stackedSlots[1]?.y ?? 0);
      expect(stackedSlots[1]?.y).toBeLessThan(stackedSlots[2]?.y ?? 0);
      expect((await box(adsTile)).height).toBe(188);
    }

    const optionExposure = await cockpitVoteOptionExposure(page);
    if (viewport.width >= 768) {
      const optionMetrics = await voteOptions.evaluate((element) => ({
        scrollTop: (element as HTMLElement).scrollTop,
        scrollHeight: (element as HTMLElement).scrollHeight,
        clientHeight: (element as HTMLElement).clientHeight,
      }));
      expect(optionMetrics.scrollTop).toBe(0);
      expect(optionMetrics.scrollHeight).toBe(optionMetrics.clientHeight);
      expect(optionExposure.visible).toEqual([true, true, true]);
    } else {
      expect(optionExposure.visible.map((visible, index) => visible || optionExposure.reachable[index])).toEqual([true, true, true]);
    }

    await expectCockpitContentReachable(page);
    await expectNoHorizontalScroll(page);
  });
}
