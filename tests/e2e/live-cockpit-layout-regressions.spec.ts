import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("availability retry stays in one shared Sofortaktionen header slot", async ({ page }) => {
  const channelId = "kanal-live-action-retry-layout";
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}`);
  const retry = page.getByRole("button", { name: "Erneut versuchen" });
  await expect(retry).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".live-action__retry")).toHaveCount(0);
  await expect(retry).toHaveCount(1);

  const geometry = await retry.evaluate((button) => {
    const heading = button.closest<HTMLElement>(".live-cockpit-actions__heading");
    const copy = heading?.querySelector<HTMLElement>(":scope > div:first-child");
    const count = heading?.querySelector<HTMLElement>(".live-cockpit-actions__count");
    if (heading === null || copy == null || count == null) return null;
    const headingBox = heading.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    return {
      insideHeading: buttonBox.top >= headingBox.top && buttonBox.bottom <= headingBox.bottom,
      afterHeadingCopy: buttonBox.left >= copyBox.right,
      beforeCount: buttonBox.right <= countBox.left,
    };
  });
  expect(geometry).toEqual({ insideHeading: true, afterHeadingCopy: true, beforeCount: true });

  const requestsBeforeRetry = mocks.currentStateRequestCount();
  await retry.click();
  await expect.poll(mocks.currentStateRequestCount).toBeGreaterThan(requestsBeforeRetry);
});

test("availability warning copy uses one color for stale and unverified checks", async ({ page }) => {
  const channelId = "kanal-live-action-warning-colors";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "chat_voting", enabled: true, settings: "{}" }],
    currentStateError: true,
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.getByText("Prüfung veraltet; Aktion bleibt verfügbar.").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Die Verfügbarkeit konnte nicht geprüft werden.").first()).toBeVisible();
  const warningStyles = await page.locator(".live-action__reason.is-availability-warning").evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent.trim(),
    color: getComputedStyle(element).color,
  })));
  expect(warningStyles.some((item) => item.text === "Prüfung veraltet; Aktion bleibt verfügbar.")).toBe(true);
  expect(warningStyles.some((item) => item.text === "Die Verfügbarkeit konnte nicht geprüft werden.")).toBe(true);
  expect(new Set(warningStyles.map((item) => item.color)).size).toBe(1);
});

test("event load errors keep a fixed table slot and retry in that slot", async ({ page }) => {
  const channelId = "kanal-live-events-error-layout";
  const mocks = await installLiveCockpitMocks(page, { channelId, eventsError: true });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}`);
  const panel = page.locator(".live-cockpit-event-feed");
  const scroll = page.locator(".live-cockpit-event-feed__scroll");
  const error = page.locator(".live-cockpit-event-feed__error");
  await expect(error).toBeVisible({ timeout: 10_000 });
  await waitForWebFonts(page);
  const initialGeometry = await Promise.all([
    panel.boundingBox(),
    scroll.evaluate((element) => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight })),
    error.evaluate((element) => ({ height: element.getBoundingClientRect().height, scrollTop: element.getBoundingClientRect().top })),
  ]);
  const retry = error.getByRole("button", { name: "Erneut versuchen" });
  const retryInsideSlot = await retry.evaluate((button) => {
    const slot = button.closest<HTMLElement>(".live-cockpit-event-feed__error");
    const slotBox = slot?.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return slotBox !== undefined && buttonBox.top >= slotBox.top && buttonBox.bottom <= slotBox.bottom;
  });
  expect(retryInsideSlot).toBe(true);

  const requestsBeforeRetry = mocks.eventRequestCount();
  mocks.setEventsError(false);
  await retry.click();
  await expect.poll(mocks.eventRequestCount).toBeGreaterThan(requestsBeforeRetry);
  await expect(error).toHaveCount(0);

  const recoveredGeometry = await Promise.all([
    panel.boundingBox(),
    scroll.evaluate((element) => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight })),
  ]);
  expect(initialGeometry[0]).not.toBeNull();
  expect(recoveredGeometry[0]).not.toBeNull();
  if (initialGeometry[0] === null || recoveredGeometry[0] === null) throw new Error("The event panel needs a layout box.");
  expect(Math.abs(initialGeometry[0].height - recoveredGeometry[0].height)).toBeLessThanOrEqual(1);
  expect(Math.abs(initialGeometry[1].height - recoveredGeometry[1].height)).toBeLessThanOrEqual(1);
  expect(Math.abs(initialGeometry[1].scrollHeight - recoveredGeometry[1].scrollHeight)).toBeLessThanOrEqual(1);
  expect(initialGeometry[2].height).toBe(420);
});
