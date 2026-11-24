import { expect, test } from "@playwright/test";

import { e2eWorkerOrigin, seedE2EOverlay } from "./worker-fixtures";

test.use({ locale: "en-US" });

test("signs in with Discord, links the verified Twitch account, and unlinks it", async ({ page }) => {
  // Applies the D1 migrations to the shared E2E database; the linking page itself needs no channel.
  seedE2EOverlay();
  await page.goto(`${e2eWorkerOrigin}/discord/link?lang=en`);
  await page.getByRole("link", { name: "Continue with Discord" }).click();

  await expect(page.getByRole("heading", { name: "Accounts linked" })).toBeVisible();
  await expect(page).toHaveURL(/\/discord\/link\?discord=linked$/u);
  await expect(page.getByText("nightowl", { exact: true })).toBeVisible();
  await expect(page.getByText("@nightowl_dev")).toBeVisible();

  await page.getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByRole("heading", { name: "Sign in with Discord" })).toBeVisible();
  await expect(page.getByText("nightowl_dev")).toHaveCount(0);
});
