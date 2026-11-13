import { expect, test, type Page } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eWorkerOrigin,
  seedE2EStatisticsWords,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

const signIn = async (page: Page): Promise<void> => {
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
};

test("hides words from a dialog behind the header button and restores them", async ({ page }) => {
  seedE2EStatisticsWords();
  await signIn(page);
  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/modules/statistics`);
  await page.getByRole("link", { name: /^Words/iu }).click();
  await expect(page.getByText("hallway", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Add or remove words" })).toHaveCount(0);

  await page.getByRole("button", { name: /^Hidden · \d+$/u }).click();
  const entry = page.getByRole("textbox", { name: "Add or remove words" });
  // The chip keeps the typed spelling; the doubled letter still matches the stored "hallway" by its folded key.
  await entry.fill("hallwaay");
  await entry.press("Enter");
  await expect(page.getByRole("button", { name: "Remove hallwaay" })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Hidden · 1" })).toBeVisible();
  await expect(page.getByText("hallway", { exact: true })).toHaveCount(0);
  await expect(page.getByText("halloween", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Hidden · 1" }).click();
  await page.getByRole("button", { name: "Remove hallwaay" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("hallway", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hidden · 0" })).toBeVisible();
});

test("opens the channel word list, hides fillers, and searches the seeded words", async ({ page }) => {
  seedE2EStatisticsWords();
  await signIn(page);

  await page.goto(`${e2eWorkerOrigin}/channels/${e2eChannelId}/modules/statistics`);
  const wordsLink = page.getByRole("link", { name: /^Words/iu });
  await expect(wordsLink).toBeVisible();
  await wordsLink.click();
  await expect(wordsLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Words", exact: true })).toBeVisible();
  await expect(page.getByText("halloween", { exact: true })).toBeVisible();
  await expect(page.getByText("lol", { exact: true })).toHaveCount(0);

  const streamResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/modules/statistics/words")
    && new URL(response.url()).searchParams.get("scope") === "stream");
  await page.getByRole("button", { name: "This stream" }).click();
  expect((await streamResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "This stream" })).toHaveAttribute("aria-pressed", "true");

  // The total view is already cached from the first load, so switching back may not hit the network.
  await page.getByRole("button", { name: "Total" }).click();
  await expect(page.getByRole("button", { name: "Total" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("halloween", { exact: true })).toBeVisible();

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
