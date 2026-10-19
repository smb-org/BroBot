import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eWorkerOrigin,
  seedE2ETestArea,
} from "./worker-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("runs a seeded text command through the local Worker and renders its real result", async ({ page }) => {
  seedE2ETestArea();
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

  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/test-area`);
  await expect(page.locator(".test-area")).toBeVisible();
  const dryRunResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/channels/${e2eChannelId}/dry-run`,
  );
  await page.locator(".test-area__context-form .test-area__run-button").click();

  const response = await dryRunResponse;
  expect(response.status()).toBe(200);
  await expect(page.locator(".test-area__result-row").filter({ hasText: "!discord" })).toBeVisible();
});
