import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eWorkerOrigin,
  seedE2EStatisticsStreams,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("shows seeded stream history, changes metrics, and links a chart marker to its event", async ({ page }) => {
  seedE2EStatisticsStreams();
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    {
      name: "__Host-brobot_session",
      value: credentials.cookie,
      domain: localWorkerHost,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "__Host-brobot_csrf",
      value: credentials.csrfToken,
      domain: localWorkerHost,
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/modules/statistics`);
  await expect(page.getByRole("heading", { name: "E2E Stream" })).toBeVisible();
  await expect(page.getByText("335", { exact: true })).toBeVisible();
  await expect(page.getByText("Game One", { exact: true })).toBeVisible();

  const chatter = page.getByRole("button", { name: "Chatter" });
  await chatter.click();
  await expect(chatter).toHaveAttribute("aria-pressed", "true");

  const bitrate = page.getByRole("button", { name: "Bitrate" });
  await expect(bitrate).toBeEnabled();
  await bitrate.click();
  await expect(bitrate).toHaveAttribute("aria-pressed", "true");

  const clipMarker = page.getByRole("button", { name: /clip: e2e highlight/iu });
  // Keep the pointer off the event list so hover cannot take over the highlight while the page scrolls.
  await page.mouse.move(0, 0);
  await clipMarker.focus();
  await expect(page.getByRole("tooltip")).toContainText("E2E highlight");
  await expect(page.getByRole("listitem", { name: /clip e2e highlight/iu })).toHaveAttribute("data-highlighted", "true");
});
