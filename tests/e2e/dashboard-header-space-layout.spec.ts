import { expect, test, type Page } from "@playwright/test";

const channelId = "header-space-layout";
const timestamp = "2030-01-01T12:00:00.000Z";
const locationName = "Sankt Ulrich am Pillersee bei Kitzbühel, Tirol, Österreich";
const widths = [
  ...Array.from({ length: 113 }, (_, index) => 320 + index * 4),
  ...Array.from({ length: 24 }, (_, index) => 769 + index * 50),
  1701,
];
const channel = {
  channelId,
  login: "header-space-layout",
  displayName: "Brotkrumen-Kanal",
  language: "de" as const,
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "header-space-layout", reason: null, updatedAt: timestamp },
  chatSubscriptionNeeded: false,
  streamState: "online" as const,
  streamStartedAt: timestamp,
  streamStateCheckedAt: timestamp,
  controls: {
    mute: { active: true, until: null, mode: "unlimited" as const },
    pause: { active: true, until: null, mode: "until_stream_end" as const },
  },
  tokens: {
    botExpiresAt: "2099-01-01T00:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-01-01T00:00:00.000Z",
  },
  lastError: null,
  location: { name: locationName, latitude: 47.4831, longitude: 12.5652, timeZone: "Europe/Vienna" },
};

const installHeaderFixture = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], viewerUserId: "header-viewer", bot: channel.bot }) });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });
};

for (const locale of ["de-DE", "en-US"] as const) {
  test.describe(`dashboard header space layout (${locale})`, () => {
    test.use({ locale });

    for (const expectedMode of ["live", "setup"] as const) {
      test(`keeps every topbar item in its cell and hit-testable (${expectedMode})`, async ({ page }) => {
        await installHeaderFixture(page);
        await page.goto(`/channels/${channelId}/overview`);
        await expect(page.locator(".dashboard-header__stream")).toHaveAttribute("data-state", "live");

        const targetMode = page.getByRole("button", { name: expectedMode === "live" ? /^Live$/ : /^(Einrichten|Setup)$/ });
        await targetMode.click();
        await expect(targetMode).toHaveAttribute("aria-pressed", "true");

        const controlsSelector =
          ".dashboard-shell__burger, .dashboard-header__mode button, .dashboard-header__start a, .dashboard-header__start button, .dashboard-header__start [role='combobox'], " +
          ".dashboard-header__end a, .dashboard-header__end button, .dashboard-header__end [role='combobox']";

        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          // Wait for the browser to apply the new viewport and lay out each header cell before measuring it.
          await page.waitForFunction((expectedWidth) => {
            if (window.innerWidth !== expectedWidth) return false;
            return [".dashboard-header", ".dashboard-header__start", ".dashboard-header__mode", ".dashboard-header__end"]
              .every((selector) => {
                const box = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
                return box !== undefined && box.width > 0 && box.height > 0;
              });
          }, width);

          const geometry = await page.evaluate((selector) => {
            const header = document.querySelector<HTMLElement>(".dashboard-header");
            const headerBox = header?.getBoundingClientRect();
            if (headerBox === undefined) return null;
            const cells = [".dashboard-header__start", ".dashboard-header__mode", ".dashboard-header__end"];
            const violations: string[] = [];
            for (const selector of cells) {
              const cell = document.querySelector<HTMLElement>(selector);
              const cellBox = cell?.getBoundingClientRect();
              if (cell === null || cellBox === undefined) {
                violations.push(`${selector} is missing`);
                continue;
              }
              if (cellBox.left < headerBox.left - 1 || cellBox.right > headerBox.right + 1) {
                violations.push(`${selector} escapes the header grid`);
              }
              for (const element of cell.querySelectorAll<HTMLElement>("*")) {
                const style = getComputedStyle(element);
                const box = element.getBoundingClientRect();
                if ((element instanceof HTMLInputElement && element.type === "hidden") || element.getAttribute("aria-hidden") === "true") continue;
                if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) continue;
                if (box.left < cellBox.left - 1 || box.right > cellBox.right + 1) {
                  violations.push(`${selector} child ${element.className || element.tagName} escapes its cell (left ${box.left.toFixed(1)}, right ${box.right.toFixed(1)})`);
                }
              }
            }
            const value = document.querySelector<HTMLElement>(".dashboard-header__channel-select .ui-select__value");
            const valueBox = value?.getBoundingClientRect();
            const valueIsVisible = value !== null && valueBox !== undefined && getComputedStyle(value).display !== "none";
            let visibleChannelName: number | null = null;
            let eightCh: number | null = null;
            if (valueIsVisible) {
              visibleChannelName = valueBox.width;
              const context = document.createElement("canvas").getContext("2d");
              if (context === null) eightCh = Number.POSITIVE_INFINITY;
              else {
                context.font = getComputedStyle(value).font;
                eightCh = context.measureText("0").width * 8;
              }
            }
            const modeWidth = document.querySelector<HTMLElement>(".dashboard-header__mode")?.getBoundingClientRect().width ?? null;
            const controlHits = [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) return [];
              const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return [{
                label: element.getAttribute("aria-label") || element.className || element.tagName,
                hit: target !== null && (target === element || element.contains(target)),
              }];
            });
            return { violations, visibleChannelName, eightCh, modeWidth, controlHits };
          }, controlsSelector);

          expect(geometry, `layout data at ${String(width)}px`).not.toBeNull();
          expect(geometry?.violations, `topbar items fit their cells at ${String(width)}px`).toEqual([]);
          if (width > 768 && geometry?.visibleChannelName !== null) {
            expect(geometry?.visibleChannelName ?? 0, `channel name has eight visible ch at ${String(width)}px`).toBeGreaterThanOrEqual(geometry?.eightCh ?? Number.POSITIVE_INFINITY);
          }

          expect(geometry?.modeWidth ?? 0, `mode switch exists at ${String(width)}px`).toBeGreaterThan(0);
          for (const control of geometry?.controlHits ?? []) {
            expect(control.hit, `${control.label} center is hit-testable at ${String(width)}px`).toBe(true);
          }
        }
      });
    }

    test("keeps channel controls available in the compact account menu and palette", async ({ page }) => {
      await installHeaderFixture(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/channels/${channelId}/overview`);
      await expect(page.locator(".dashboard-header__channel-avatar")).toBeVisible();

      const accountName = locale === "de-DE" ? "Konto" : "Account";
      await page.getByRole("button", { name: accountName }).click();
      const muteMenuItem = locale === "de-DE" ? /Stummschaltung aufheben.*Kanal stumm/ : /Unmute channel.*Muted/;
      const pauseMenuItem = locale === "de-DE" ? /Automatische Aktionen fortsetzen.*Pausiert/ : /Resume automatic actions.*Paused/;
      await expect(page.getByRole("menuitem", { name: muteMenuItem })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: pauseMenuItem })).toBeVisible();
      const stateLabels = page.locator(".dashboard-header__account-control-state");
      await expect(stateLabels).toHaveCount(2);
      for (const stateLabel of await stateLabels.all()) {
        const fits = await stateLabel.evaluate((element) => element.scrollWidth <= element.clientWidth && element.clientHeight > 0);
        expect(fits, "account menu shows each control state without clipping").toBe(true);
      }

      await page.keyboard.press("Escape");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      const search = page.locator("[cmdk-input]");
      await search.fill(locale === "de-DE" ? "Stummschaltung aufheben" : "Unmute channel");
      await expect(page.getByRole("option", { name: muteMenuItem })).toBeVisible();
      await search.fill(locale === "de-DE" ? "Automatische Aktionen fortsetzen" : "Resume automatic actions");
      await expect(page.getByRole("option", { name: pauseMenuItem })).toBeVisible();
    });

    test("shows the compact channel initial and chevron with the token gap", async ({ page }) => {
      await installHeaderFixture(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/channels/${channelId}/overview`);
      await expect(page.locator(".dashboard-header__channel-avatar")).toBeVisible();

      const geometry = await page.evaluate(() => {
        const brand = document.querySelector<HTMLElement>(".dashboard-header__brand")?.getBoundingClientRect();
        const channel = document.querySelector<HTMLElement>(".dashboard-header__channel")?.getBoundingClientRect();
        const selector = document.querySelector<HTMLElement>(".dashboard-header__channel-select")?.getBoundingClientRect();
        const avatar = document.querySelector<HTMLElement>(".dashboard-header__channel-avatar");
        const trigger = document.querySelector<HTMLElement>(".dashboard-header__channel-select .ui-select__trigger");
        const icon = trigger?.querySelector<SVGElement>("svg");
        const iconBox = icon?.getBoundingClientRect();
        const avatarBox = avatar?.getBoundingClientRect();
        if (brand === undefined || channel === undefined || selector === undefined || avatar === null || trigger === null || icon == null || iconBox === undefined || avatarBox === undefined) return null;
        const iconStyle = getComputedStyle(icon);
        const target = document.elementFromPoint(iconBox.left + iconBox.width / 2, iconBox.top + iconBox.height / 2);
        return {
          initial: avatar.textContent.trim(),
          gap: channel.left - brand.right,
          iconVisible: iconStyle.display !== "none" && iconStyle.visibility !== "hidden" && Number(iconStyle.opacity) > 0 && iconBox.width > 0 && iconBox.height > 0,
          iconInsideSelector: iconBox.left >= selector.left && iconBox.right <= selector.right,
          iconAfterInitial: iconBox.left >= avatarBox.right,
          iconHitTestable: target !== null && (target === trigger || trigger.contains(target)),
        };
      });

      expect(geometry).not.toBeNull();
      expect(geometry?.initial).not.toBe("");
      expect(geometry?.gap).toBeGreaterThanOrEqual(7);
      expect(geometry?.gap).toBeLessThanOrEqual(9);
      expect(geometry?.iconVisible).toBe(true);
      expect(geometry?.iconInsideSelector).toBe(true);
      expect(geometry?.iconAfterInitial).toBe(true);
      expect(geometry?.iconHitTestable).toBe(true);
    });

    test("keeps the channel name clear of its avatar", async ({ page }) => {
      await installHeaderFixture(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/channels/${channelId}/overview`);

      const trigger = page.locator(".dashboard-header__channel-select .ui-select__trigger");
      const avatar = page.locator(".dashboard-header__channel-avatar");
      const value = page.locator(".dashboard-header__channel-select .ui-select__value");
      await expect(trigger).toBeVisible();
      await expect(avatar).toBeVisible();
      await expect(value).toBeVisible();

      const geometry = await page.evaluate(() => {
        const trigger = document.querySelector<HTMLElement>(".dashboard-header__channel-select .ui-select__trigger");
        const avatar = document.querySelector<HTMLElement>(".dashboard-header__channel-avatar");
        const value = document.querySelector<HTMLElement>(".dashboard-header__channel-select .ui-select__value");
        if (trigger === null || avatar === null || value === null) return null;
        return {
          paddingLeft: getComputedStyle(trigger).paddingLeft,
          avatarRight: avatar.getBoundingClientRect().right,
          valueLeft: value.getBoundingClientRect().left,
        };
      });

      expect(geometry).not.toBeNull();
      expect(geometry?.paddingLeft).toBe("38px");
      expect(geometry?.avatarRight ?? Number.POSITIVE_INFINITY).toBeLessThan(geometry?.valueLeft ?? Number.NEGATIVE_INFINITY);
    });
  });
}
