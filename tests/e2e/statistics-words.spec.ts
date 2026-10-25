import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eWorkerOrigin,
  seedE2EStatisticsWords,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("opens the channel word list, hides fillers, and searches the seeded words", async ({ page }) => {
  seedE2EStatisticsWords();
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

  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/modules/statistics`);
  const wordsLink = page.getByRole("link", { name: /^Words/iu });
  await expect(wordsLink).toBeVisible();
  await wordsLink.click();
  await expect(wordsLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Words" })).toBeVisible();
  await expect(page.getByText("halloween", { exact: true })).toBeVisible();
  await expect(page.getByText("lol", { exact: true })).toHaveCount(0);

  const fillerToggle = page.getByRole("switch", { name: "Hide filler words" });
  await fillerToggle.click();
  await expect(page.getByText("lol", { exact: true })).toBeVisible();

  const searchResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/modules/statistics/words")
    && new URL(response.url()).searchParams.get("search") === "hall");
  await page.getByRole("textbox", { name: "Search words" }).fill("hall");
  expect((await searchResponse).status()).toBe(200);
  await expect(page.getByText("1–2 of 2")).toBeVisible();
  await expect(page.getByText("halloween", { exact: true })).toBeVisible();
  await expect(page.getByText("hallway", { exact: true })).toBeVisible();
  await expect(page.getByText("lol", { exact: true })).toHaveCount(0);
});
