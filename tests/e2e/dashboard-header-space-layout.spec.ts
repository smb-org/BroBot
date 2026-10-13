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

        const mode = page.locator(".dashboard-header__mode");
        const targetMode = page.getByRole("button", { name: expectedMode === "live" ? /^Live$/ : /^(Einrichten|Setup)$/ });
        await targetMode.click();
        await expect(targetMode).toHaveAttribute("aria-pressed", "true");

        const controls = page.locator(
          ".dashboard-shell__burger, .dashboard-header__mode button, .dashboard-header__start a, .dashboard-header__start button, .dashboard-header__start [role='combobox'], " +
          ".dashboard-header__end a, .dashboard-header__end button, .dashboard-header__end [role='combobox']",
        );

        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          const layout = await page.evaluate(() => {
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
            if (value === null || valueBox === undefined || getComputedStyle(value).display === "none") {
              return { violations, visibleChannelName: null, eightCh: null };
            }
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (context === null) return { violations, visibleChannelName: valueBox.width, eightCh: Number.POSITIVE_INFINITY };
            context.font = getComputedStyle(value).font;
            return { violations, visibleChannelName: valueBox.width, eightCh: context.measureText("0").width * 8 };
          });

          expect(layout, `layout data at ${String(width)}px`).not.toBeNull();
          expect(layout?.violations, `topbar items fit their cells at ${String(width)}px`).toEqual([]);
          if (width > 768 && layout?.visibleChannelName !== null) {
            expect(layout?.visibleChannelName ?? 0, `channel name has eight visible ch at ${String(width)}px`).toBeGreaterThanOrEqual(layout?.eightCh ?? Number.POSITIVE_INFINITY);
          }

          const modeBox = await mode.boundingBox();
          expect(modeBox, `mode switch exists at ${String(width)}px`).not.toBeNull();
          for (const control of await controls.all()) {
            if (!(await control.isVisible())) continue;
            const hit = await control.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return target !== null && (target === element || element.contains(target));
            });
            expect(hit, `control center is hit-testable at ${String(width)}px`).toBe(true);
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
  });
}
