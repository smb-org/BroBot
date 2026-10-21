import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-435-r3-location";
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

test("location removal stays disabled during a time-zone save and does not erase the saved location", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    location: { name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
  });

  let releasePatch: (() => void) | undefined;
  let resolvePatchStarted: (() => void) | undefined;
  const patchStarted = new Promise<void>((resolve) => { resolvePatchStarted = resolve; });
  await page.route(`**/api/channels/${channelId}/settings`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { timeZone: string };
    resolvePatchStarted?.();
    await new Promise<void>((resolve) => { releasePatch = resolve; });
    return route.fulfill(json({ ok: true, timeZone: body.timeZone, revision: 2 }));
  });

  await page.goto(`/channels/${channelId}/location-weather`);
  const timeZone = page.getByRole("combobox", { name: "Kanalzeitzone" });
  await expect(timeZone).toHaveValue("Europe/Berlin");
  await timeZone.click();
  await page.getByRole("option", { name: "Europe/Paris" }).click();

  const removeButton = page.getByRole("button", { name: "Standort entfernen" });
  await removeButton.click();
  const confirmation = page.getByRole("dialog", { name: "Standort entfernen?" });
  const confirmRemoval = confirmation.getByRole("button", { name: "Standort entfernen" });
  await expect(confirmation).toBeVisible();

  await page.keyboard.press("Control+s");
  await patchStarted;

  await expect(page.locator(".ui-select__search-input")).toBeDisabled();
  await expect(page.locator(".channel-location-field__actions > .ui-button").first()).toBeDisabled();
  await expect(page.locator(".channel-location-field__remove")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Zeitzone übernehmen", includeHidden: true })).toBeDisabled();
  await expect(page.locator(".ui-save-bar__discard")).toBeDisabled();
  await expect(confirmRemoval).toBeDisabled();
  await confirmRemoval.evaluate((button: HTMLButtonElement) => { button.click(); });
  await expect(confirmation).toBeVisible();
  await expect(page.getByText("Berlin, Berlin, Deutschland", { exact: true })).toBeVisible();

  releasePatch?.();
  await expect(page.locator(".ui-save-bar__save")).toBeDisabled();
  await expect(confirmation).toBeVisible();
  await expect(page.getByText("Berlin, Berlin, Deutschland", { exact: true })).toBeVisible();

  await confirmation.getByRole("button", { name: "Standort entfernen" }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByText("Standort fehlt")).toBeVisible();
  await expect(page.locator(".ui-save-bar__save")).toBeEnabled();
});
