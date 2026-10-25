import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eWorkerOrigin,
  seedE2EStatisticsStreams,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("shows seeded stream trends and switches the comparison range", async ({ page }) => {
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
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/modules/statistics?page=trends`);
  await expect(page.getByRole("heading", { name: "Trends" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Trends/u })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: /^Streams/u })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: /weekly activity|wochenverlauf/iu })).toBeVisible();
  await expect(page.getByRole("table", { name: /categories|kategorien/iu })).toContainText("Game One");
  await expect(page.getByRole("table", { name: /categories|kategorien/iu })).toContainText("Game Two");

  const fourWeeks = page.getByRole("button", { name: /^4 (weeks|Wochen)$/u });
  await fourWeeks.click();
  await expect(fourWeeks).toHaveAttribute("aria-pressed", "true");
});
