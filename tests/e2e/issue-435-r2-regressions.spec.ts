import { expect, test, type Page, type Route } from "@playwright/test";

import type { ApiSource } from "../../src/modules/api_source/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const sourceChannelId = "kanal-435-r2-sources";
const locationChannelId = "kanal-435-r2-location";
const viewports = [
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

const sources = [
  {
    name: "wetter",
    url: "https://wetter.example.test/current?region=berlin",
    expression: "$.temperature",
    revision: 2,
    updatedAt: "2026-10-15T09:00:00.000Z",
    lastFetchedAt: "2026-10-16T08:30:00.000Z",
    lastStatus: "ok",
    lastError: null,
  },
  {
    name: "wechselkurs",
    url: "https://rates.example.test/latest",
    expression: "$.rates.EUR",
    revision: 1,
    updatedAt: "2026-10-15T09:00:00.000Z",
    lastFetchedAt: "2026-10-16T08:25:00.000Z",
    lastStatus: "error",
    lastError: "timeout",
  },
] as const;

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

const installSourceMocks = async (page: Page, role: "manager" | "operator" = "manager"): Promise<void> => {
  const mockSources: ApiSource[] = [...sources];
  await installLiveCockpitMocks(page, {
    channelId: sourceChannelId,
    role,
    modules: [{ id: "api_source", enabled: true, settings: "{}" }],
  });
  await page.route(`**/api/channels/${sourceChannelId}/modules/api_source/sources**`, async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/sources/test") && route.request().method() === "POST") {
      return route.fulfill(json({
        status: "ok",
        httpStatus: 200,
        bytes: 1400,
        json: { temperature: 21, payload: "x".repeat(1400) },
        value: "21",
      }));
    }
    if (route.request().method() === "GET") return route.fulfill(json({ sources: mockSources }));
    if (route.request().method() === "POST" && pathname.endsWith("/sources")) {
      const source = { ...sources[0], name: "new_weather", expression: "$.temperature", revision: 3 };
      mockSources.push(source);
      return route.fulfill(json({ source }));
    }
    return route.fallback();
  });
};

const assertNoHorizontalOverflow = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};

test("data-source layouts align the list, detail, properties, and localized status", async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await installSourceMocks(page);
    await page.goto(`/channels/${sourceChannelId}/modules/api_source`);
    await expect(page.locator(".api-source-panel__row")).toHaveCount(2);

    const statusSlot = page.locator(".api-source-panel__list-toolbar .list-toolbar__status");
    expect(await statusSlot.evaluate((element) => getComputedStyle(element).display)).toBe("none");
    const toolbarBox = await page.locator(".api-source-panel__list-toolbar").boundingBox();
    const firstRowBox = await page.locator(".api-source-panel__row").first().boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(firstRowBox).not.toBeNull();
    if (toolbarBox !== null && firstRowBox !== null) {
      const gap = firstRowBox.y - (toolbarBox.y + toolbarBox.height);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(14);
    }

    const heading = page.locator(".module-detail-heading");
    await expect(heading.locator(".page-header__main > p")).toHaveCount(1);
    await expect(heading.locator(".page-header__meta")).toHaveCount(0);
    await expect(heading.locator(".page-header__module-switch")).toContainText("Läuft · immer aktiv");

    await page.getByRole("button", { name: /wetter/u }).click();
    const detailHeader = page.locator(".collection-page__detail > .page-header");
    const detailContent = page.locator(".api-source-panel__detail-content");
    const headerBox = await detailHeader.boundingBox();
    const contentBox = await detailContent.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (headerBox !== null && contentBox !== null) {
      expect(Math.abs(headerBox.x - contentBox.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(headerBox.x + headerBox.width - contentBox.x - contentBox.width)).toBeLessThanOrEqual(1);
    }

    const urlRow = page.locator(".api-source-panel__detail-content .inspector-field-row").first();
    const urlLabel = urlRow.locator(".inspector-field-row__label");
    const urlValue = page.locator(".api-source-panel__url");
    await expect(urlRow).toHaveClass(/inspector-field-row--stacked/u);
    const labelBox = await urlLabel.boundingBox();
    const valueBox = await urlValue.boundingBox();
    expect(labelBox).not.toBeNull();
    expect(valueBox).not.toBeNull();
    if (labelBox !== null && valueBox !== null) {
      expect(Math.abs(labelBox.x - valueBox.x)).toBeLessThanOrEqual(1);
      expect(valueBox.y).toBeGreaterThanOrEqual(labelBox.y + labelBox.height);
    }

    await expect(page.locator(".api-source-panel__status-detail time")).toHaveText("Zuletzt abgefragt 16.10.2026, 10:30");
    await assertNoHorizontalOverflow(page);

    if (viewport.width <= 600) await page.locator(".collection-page__detail-back").click();
    await page.getByRole("button", { name: /wechselkurs/u }).click();
    await expect(page.locator(".api-source-panel__failure-detail")).toHaveText("Der Endpunkt hat nicht rechtzeitig geantwortet.");
    await assertNoHorizontalOverflow(page);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("operators get one module permission reason below the description", async ({ page }) => {
  await installSourceMocks(page, "operator");
  await page.goto(`/channels/${sourceChannelId}/modules/api_source`);
  const heading = page.locator(".module-detail-heading");
  await expect(heading.locator(".page-header__main > p")).toHaveCount(1);
  await expect(heading.locator(".page-header__module-switch")).toContainText("Läuft · immer aktiv");
  const permissionReason = heading.locator(".page-header__meta .page-header__lock");
  await expect(permissionReason).toHaveCount(1);
  await expect(permissionReason).toContainText("Nur Broadcaster und Verwalter dürfen Module ändern.");
  await expect(page.locator(".api-source-panel__list-toolbar .list-toolbar__reason:not(.sr-only)")).toHaveCount(0);
  const statusSlot = page.locator(".api-source-panel__list-toolbar .list-toolbar__status");
  expect(await statusSlot.evaluate((element) => getComputedStyle(element).display)).toBe("none");
  const toolbarBox = await page.locator(".api-source-panel__list-toolbar").boundingBox();
  const rowBox = await page.locator(".api-source-panel__row").first().boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  if (toolbarBox !== null && rowBox !== null) {
    const gap = rowBox.y - (toolbarBox.y + toolbarBox.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(14);
  }
  const createButton = page.getByRole("button", { name: "Quelle anlegen" });
  await expect(createButton).toBeDisabled();
  const reasonId = await createButton.getAttribute("aria-describedby");
  expect(reasonId).not.toBeNull();
  const accessibleReason = page.locator(`[id="${reasonId ?? ""}"]`);
  await expect(accessibleReason).toHaveClass(/sr-only/u);
  await expect(accessibleReason).toContainText("Operatoren können Datenquellen ansehen, aber nicht ändern.");
  await expect(heading.locator(".page-header__main > p")).toContainText("öffentliche Webadressen");
});

test("location page uses the settings-page header gap and aligns the saved place above its actions", async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await installLiveCockpitMocks(page, {
      channelId: locationChannelId,
      location: { name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
    });
    await page.goto(`/channels/${locationChannelId}/location-weather`);

    const headerBox = await page.locator(".channel-location-page .settings-page > .page-header").boundingBox();
    const header = page.locator(".channel-location-page .settings-page > .page-header");
    const firstSectionHeading = await page.locator(".channel-location-page .settings-page__column:first-child .ui-section__heading").boundingBox();
    const headerBorder = await header.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderBottomWidth));
    expect(headerBox).not.toBeNull();
    expect(firstSectionHeading).not.toBeNull();
    if (headerBox !== null && firstSectionHeading !== null) {
      const dividerY = headerBox.y + headerBox.height - headerBorder / 2;
      const expectedGap = viewport.width <= 600 ? 36.5 : 32.5;
      expect(Math.abs(firstSectionHeading.y - dividerY - expectedGap)).toBeLessThanOrEqual(1);
    }

    const current = page.locator(".channel-location-field__current");
    const actions = page.locator(".channel-location-field__actions");
    const currentBox = await current.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(currentBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    if (currentBox !== null && actionsBox !== null) {
      expect(Math.abs(currentBox.x - actionsBox.x)).toBeLessThanOrEqual(1);
      expect(actionsBox.y).toBeGreaterThanOrEqual(currentBox.y + currentBox.height);
      expect(actionsBox.y - currentBox.y - currentBox.height).toBeLessThanOrEqual(14);
    }
    await assertNoHorizontalOverflow(page);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("the source wizard submits every step from the keyboard and keeps test output fixed", async ({ page }) => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await installSourceMocks(page);
    await page.goto(`/channels/${sourceChannelId}/modules/api_source`);
    const listName = page.locator(".api-source-panel__row .mono").first();
    const listFont = await listName.evaluate((element) => getComputedStyle(element).fontFamily);
    await page.getByRole("button", { name: "Quelle anlegen" }).click();
    const dialog = page.getByRole("dialog", { name: "Datenquelle anlegen" });
    const url = dialog.getByRole("textbox", { name: "Webadresse" });
    await url.fill("https://example.test/weather");
    expect(await url.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(listFont);
    await url.press("Enter");
    await expect(dialog.locator("[data-step='2']")).toBeVisible();

    const expression = dialog.getByRole("textbox", { name: "Wert aus der Antwort" });
    await expression.fill("$.temperature");
    expect(await expression.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(listFont);
    await expression.press("Control+Enter");
    await expect(dialog.locator("[data-step='3']")).toBeVisible();
    const summaryCode = dialog.locator("[data-step='3'] .api-source-panel__test-summary code");
    await expect(summaryCode).toHaveCount(2);
    const summaryFonts = await summaryCode.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontFamily));
    expect(summaryFonts).toEqual([listFont, listFont]);

    const output = dialog.getByTestId("api-source-test-result");
    const continueButton = dialog.getByRole("button", { name: "Weiter" });
    const beforeOutput = await output.boundingBox();
    const beforeContinue = await continueButton.boundingBox();
    const beforeDialog = await dialog.boundingBox();
    expect(beforeOutput).not.toBeNull();
    expect(beforeContinue).not.toBeNull();
    expect(beforeDialog).not.toBeNull();
    if (beforeOutput !== null) expect(beforeOutput.height).toBe(116);

    await dialog.getByRole("button", { name: "Testen" }).click();
    await expect(output.getByRole("status")).toContainText("Erfolgreich · HTTP 200");
    expect(await output.locator("pre").evaluate((element) => getComputedStyle(element).fontFamily)).toBe(listFont);
    const afterOutput = await output.boundingBox();
    const afterContinue = await continueButton.boundingBox();
    const afterDialog = await dialog.boundingBox();
    expect(afterOutput).not.toBeNull();
    expect(afterContinue).not.toBeNull();
    expect(afterDialog).not.toBeNull();
    const outputStyle = await output.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(outputStyle.overflowY).toBe("auto");
    expect(outputStyle.height).toBe(116);
    expect(outputStyle.scrollHeight).toBeGreaterThan(outputStyle.clientHeight);
    if (beforeContinue !== null && afterContinue !== null) expect(Math.abs(beforeContinue.y - afterContinue.y)).toBeLessThanOrEqual(1);
    if (beforeDialog !== null && afterDialog !== null) expect(Math.abs(beforeDialog.height - afterDialog.height)).toBeLessThanOrEqual(1);

    await continueButton.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.locator("[data-step='4']")).toBeVisible();
    const name = dialog.getByRole("textbox", { name: "Name" });
    await name.press("Control+Enter");
    await expect(dialog).toBeVisible();
    await name.fill("new_weather");
    await name.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".collection-page__detail > .page-header")).toContainText("new_weather");
    await page.unrouteAll({ behavior: "wait" });
  }
});
