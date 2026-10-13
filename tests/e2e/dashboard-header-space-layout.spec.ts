import { expect, test, type Page } from "@playwright/test";

const channelId = "header-space-layout";
const timestamp = "2030-01-01T12:00:00.000Z";
const locationName = "Sankt Ulrich am Pillersee bei Kitzbühel, Tirol, Österreich";
const widths = [...Array.from({ length: 24 }, (_, index) => 769 + index * 50), 1701];
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

    test("keeps the side groups inside their cells and the channel name readable", async ({ page }) => {
      await installHeaderFixture(page);
      await page.goto(`/channels/${channelId}/overview`);
      await expect(page.locator(".dashboard-header__stream")).toHaveAttribute("data-state", "live");

      const mode = page.locator(".dashboard-header__mode");
      const controls = page.locator(
        ".dashboard-header__mode button, .dashboard-header__start a, .dashboard-header__start button, .dashboard-header__start [role='combobox'], " +
        ".dashboard-header__end a, .dashboard-header__end button, .dashboard-header__end [role='combobox']",
      );

      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => {
          const modeElement = document.querySelector<HTMLElement>(".dashboard-header__mode");
          const modeBox = modeElement?.getBoundingClientRect();
          if (modeBox === undefined) return null;
          const groups = [".dashboard-header__start", ".dashboard-header__end"];
          const violations: string[] = [];
          for (const selector of groups) {
            const group = document.querySelector<HTMLElement>(selector);
            const groupBox = group?.getBoundingClientRect();
            if (group === null || groupBox === undefined) {
              violations.push(`${selector} is missing`);
              continue;
            }
            for (const element of group.querySelectorAll<HTMLElement>("*")) {
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              if ((element instanceof HTMLInputElement && element.type === "hidden") || element.getAttribute("aria-hidden") === "true") continue;
              if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) continue;
              if (box.left < groupBox.left - 1 || box.right > groupBox.right + 1) {
                violations.push(`${selector} child ${element.className || element.tagName} escapes its cell (left ${box.left.toFixed(1)}, right ${box.right.toFixed(1)})`);
              }
              if (box.left < modeBox.right && box.right > modeBox.left && box.top < modeBox.bottom && box.bottom > modeBox.top) {
                violations.push(`${selector} child ${element.className || element.tagName} intersects the mode switch`);
              }
            }
          }
          const value = document.querySelector<HTMLElement>(".dashboard-header__channel-select .ui-select__value");
          const valueBox = value?.getBoundingClientRect();
          if (value === null || valueBox === undefined) return { violations, visibleChannelName: 0, eightCh: 0 };
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (context === null) return { violations, visibleChannelName: valueBox.width, eightCh: Number.POSITIVE_INFINITY };
          context.font = getComputedStyle(value).font;
          return { violations, visibleChannelName: valueBox.width, eightCh: context.measureText("0").width * 8 };
        });

        expect(layout, `layout data at ${String(width)}px`).not.toBeNull();
        expect(layout?.violations, `side groups fit at ${String(width)}px`).toEqual([]);
        expect(layout?.visibleChannelName ?? 0, `channel name has eight visible ch at ${String(width)}px`).toBeGreaterThanOrEqual(layout?.eightCh ?? Number.POSITIVE_INFINITY);

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
  });
}
