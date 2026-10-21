import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-435-regression";
const sources = [
  {
    name: "wetter",
    url: "https://wetter.example.test/current",
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

const installSourceRoute = async (page: Page, role: "manager" | "operator" = "manager", testResult: "success" | "timeout" = "success"): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId,
    role,
    modules: [{ id: "api_source", enabled: true, settings: "{}" }],
  });
  await page.route(`**/api/channels/${channelId}/modules/api_source/sources**`, async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/sources/test") && route.request().method() === "POST") {
      return route.fulfill(json(testResult === "timeout"
        ? { status: "error", reason: "timeout", httpStatus: 504 }
        : { status: "ok", httpStatus: 200, bytes: 1400, json: { temperature: 21, payload: "x".repeat(1400), ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${String(index)}`, index])) }, value: "21" }));
    }
    if (route.request().method() === "GET") return route.fulfill(json({ sources }));
    return route.fallback();
  });
};

const openLocationSearch = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Standort ändern" }).click();
  await page.getByRole("textbox", { name: "Ort suchen" }).fill("Berlin");
  await page.getByRole("button", { name: "Suchen" }).click();
  await page.getByRole("option", { name: /Berlin/ }).click();
};

const assertLocationLayout = async (page: Page): Promise<void> => {
  const settingsPage = page.locator(".channel-location-page .settings-page");
  const header = settingsPage.locator(":scope > .page-header");
  const columns = settingsPage.locator(":scope > .settings-page__columns");
  const settingsBounds = await settingsPage.boundingBox();
  const headerBounds = await header.boundingBox();
  const columnBounds = await columns.boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(headerBounds).not.toBeNull();
  expect(columnBounds).not.toBeNull();
  if (settingsBounds !== null && headerBounds !== null && columnBounds !== null) {
    expect(Math.abs(headerBounds.x - settingsBounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(headerBounds.width - settingsBounds.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(columnBounds.x - settingsBounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(columnBounds.width - settingsBounds.width)).toBeLessThanOrEqual(1);
  }
  await expect(header.locator(".module-heading-glyph")).toHaveCount(1);
  const saveStyle = await header.locator(".ui-save-bar--persistent").evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, borderTopWidth: style.borderTopWidth };
  });
  expect(saveStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(saveStyle.borderTopWidth).toBe("0px");
  const field = page.locator(".channel-location-field");
  expect(await field.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
  expect(await field.evaluate((element) => getComputedStyle(element).minHeight)).not.toBe("230px");
  const status = page.locator(".channel-location-field__status");
  expect(await status.locator("svg").count()).toBe(0);
  const details = page.locator(".channel-location-field__details");
  if (await details.count() > 0) {
    const detailsStyle = await details.evaluate((element) => getComputedStyle(element).fontSize);
    expect(Number.parseFloat(detailsStyle)).toBeLessThanOrEqual(12);
  }
  const removeStyle = await page.getByRole("button", { name: "Standort entfernen" }).evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(removeStyle).toBe("rgba(0, 0, 0, 0)");
};

test("location changes stay in the page draft until Speichern", async ({ page }) => {
  const requests: string[] = [];
  await installLiveCockpitMocks(page, { channelId });
  let releaseSettings: (() => void) | undefined;
  let signalSettingsRequest: () => void = () => undefined;
  const settingsRequestStarted = new Promise<void>((resolve) => { signalSettingsRequest = resolve; });
  let holdSettings = true;
  await page.route(`**/api/channels/${channelId}/settings`, async (route: Route) => {
    if (holdSettings && route.request().method() === "GET") {
      signalSettingsRequest();
      await new Promise<void>((resolve) => { releaseSettings = resolve; });
    }
    return route.fallback();
  });
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/channels/${channelId}/settings/location`) && request.method() === "PATCH") requests.push(request.url());
  });
  const navigation = page.goto(`/channels/${channelId}/location-weather`);
  await settingsRequestStarted;
  await expect(page.locator(".page-header__save .ui-save-bar--persistent")).toBeVisible();
  const pendingSaveBox = await page.locator(".page-header__save .ui-save-bar--persistent").boundingBox();
  const pendingColumnBox = await page.locator(".settings-page__columns").boundingBox();
  expect(pendingSaveBox).not.toBeNull();
  expect(pendingColumnBox).not.toBeNull();
  releaseSettings?.();
  holdSettings = false;
  await navigation;
  const readySaveBox = await page.locator(".page-header__save .ui-save-bar--persistent").boundingBox();
  const readyColumnBox = await page.locator(".settings-page__columns").boundingBox();
  expect(readySaveBox).not.toBeNull();
  expect(readyColumnBox).not.toBeNull();
  if (pendingSaveBox !== null && readySaveBox !== null && pendingColumnBox !== null && readyColumnBox !== null) {
    expect(Math.abs(pendingSaveBox.y - readySaveBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(pendingSaveBox.height - readySaveBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(pendingColumnBox.y - readyColumnBox.y)).toBeLessThanOrEqual(1);
  }
  await openLocationSearch(page);
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await assertLocationLayout(page);
  }
  await expect(page.locator(".channel-location-field__status")).toContainText("Berlin");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.locator(".channel-location-field__status")).not.toContainText("Berlin");
  expect(requests).toHaveLength(0);

  await openLocationSearch(page);
  await page.keyboard.press("Control+s");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Standort entfernen" }).click();
  await page.getByRole("button", { name: "Standort entfernen", exact: true }).last().click();
  await expect(page.locator(".channel-location-field__status")).toHaveText("Standort fehlt");
  expect(requests).toHaveLength(1);
  const save = page.waitForRequest((request) => request.url().endsWith(`/api/channels/${channelId}/settings/location`) && request.method() === "PATCH");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await save;
  await expect.poll(() => requests.length).toBe(2);
});
test("a time-zone conflict keeps its original revision after another edit", async ({ page }) => {
  await installLiveCockpitMocks(page, { channelId });
  let conflictAfterWrite = false;
  await page.route(`**/api/channels/${channelId}/settings`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(json({
        timeZone: conflictAfterWrite ? "Europe/London" : "Europe/Berlin",
        revision: conflictAfterWrite ? 2 : 1,
        location: null,
        locationRevision: 1,
        defaultChatTarget: "source_only",
        defaultChatTargetRevision: 1,
      }));
    }
    if (route.request().method() === "PATCH") {
      conflictAfterWrite = true;
      return route.fulfill(json({ error: "channel_settings_conflict" }, 409));
    }
    return route.fallback();
  });
  await page.goto(`/channels/${channelId}/location-weather`);

  const timeZone = page.getByRole("combobox", { name: "Kanalzeitzone" });
  await timeZone.fill("Europe/Paris");
  await page.getByRole("option", { name: "Europe/Paris" }).click();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();

  await timeZone.fill("Europe/Amsterdam");
  await page.getByRole("option", { name: "Europe/Amsterdam" }).click();
  await expect(page.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toHaveCount(0);
});

test("data sources use one shell heading, shared collection layout, mono names, and short status chips", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installSourceRoute(page);
  await page.goto(`/channels/${channelId}/modules/api_source`);

  await expect(page.locator(".dashboard-header")).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Datenquellen", level: 1 })).toBeVisible();
  await expect(page.locator(".main-content h1:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Quelle anlegen" })).toBeVisible();
  const searchField = page.locator(".api-source-panel__list-toolbar .ui-field__input");
  await expect(searchField).toBeVisible();
  expect(await page.locator(".api-source-panel").evaluate((element) => element.textContent)).not.toMatch(/JSONata|HTTPS-JSON|booleschen JSONata-Ausdruck/u);
  const searchBox = await searchField.boundingBox();
  const createBox = await page.getByRole("button", { name: "Quelle anlegen" }).boundingBox();
  expect(searchBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  if (searchBox !== null && createBox !== null) {
    expect(Math.abs(searchBox.height - createBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(searchBox.y - createBox.y)).toBeLessThanOrEqual(1);
  }

  const collection = page.locator(".api-source-panel .collection-page");
  await expect(collection).toHaveAttribute("data-single-column", "false");
  const listStyles = await page.locator(".collection-page__list-content").evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    height: element.getBoundingClientRect().height,
  }));
  const detailStyles = await page.locator(".collection-page__detail").evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    height: element.getBoundingClientRect().height,
  }));
  expect(listStyles.overflowY).toBe("auto");
  expect(detailStyles.overflowY).toBe("auto");
  expect(listStyles.height).toBeGreaterThan(300);
  expect(detailStyles.height).toBeGreaterThan(300);

  const rows = page.locator(".api-source-panel__row");
  await expect(rows).toHaveCount(2);
  const rowHeights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(rowHeights[0]).toBe(rowHeights[1]);
  const badgeAlignment = await rows.first().evaluate((element) => {
    const row = element.querySelector<HTMLElement>(".api-source-panel__select");
    const badge = element.querySelector<HTMLElement>(".api-source-panel__row-status");
    if (row === null || badge === null) return false;
    const rowBounds = row.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    return Math.abs(rowBounds.top + rowBounds.height / 2 - (badgeBounds.top + badgeBounds.height / 2)) <= 1;
  });
  expect(badgeAlignment).toBe(true);
  await expect(page.getByRole("button", { name: /wechselkurs/u })).toContainText("Fehler");
  const nameStyle = await page.locator(".api-source-panel__row .mono").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, weight: style.fontWeight };
  });
  expect(nameStyle.family).toContain("IBM Plex Mono");
  expect(nameStyle.weight).toBe("700");

  await page.getByRole("button", { name: /wetter/u }).click();
  const tokenChip = page.locator(".collection-page__detail .ui-token-chip");
  await expect(tokenChip).toContainText("{api.wetter}");
  await expect(tokenChip).toHaveAccessibleName(/\{api\.wetter\} kopieren/u);
  const detailNameStyle = await page.locator(".collection-page__detail .page-header h2 .mono").evaluate((element) => getComputedStyle(element).fontFamily);
  expect(detailNameStyle).toContain("IBM Plex Mono");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(collection).toHaveAttribute("data-single-column", "true");
  await expect(page.locator(".collection-page__detail")).toBeVisible();
  const detailHeader = await page.locator(".collection-page__detail > .page-header").boundingBox();
  const detailTitle = await page.locator(".collection-page__detail > .page-header h2").boundingBox();
  expect(detailHeader).not.toBeNull();
  expect(detailTitle).not.toBeNull();
  if (detailHeader !== null && detailTitle !== null) {
    expect(detailTitle.x).toBeGreaterThanOrEqual(detailHeader.x);
    expect(detailTitle.x + detailTitle.width).toBeLessThanOrEqual(detailHeader.x + detailHeader.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operators can read source properties and see a disabled edit action with one reason", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installSourceRoute(page, "operator");
  await page.goto(`/channels/${channelId}/modules/api_source`);

  await page.getByRole("button", { name: /wetter/u }).click();
  await expect(page.getByRole("button", { name: "Quelle bearbeiten" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Quelle anlegen" })).toBeDisabled();
  const headerReason = page.locator(".module-detail-heading .page-header__meta .page-header__lock");
  await expect(headerReason).toHaveCount(1);
  await expect(headerReason).toContainText("Nur Broadcaster und Verwalter dürfen Module ändern.");
  const reason = page.locator(".api-source-panel .list-toolbar__reason");
  await expect(reason).toHaveCount(1);
  await expect(reason).toHaveClass(/sr-only/u);
  await expect(page.getByRole("button", { name: "Quelle bearbeiten" })).toHaveAttribute("aria-describedby", "api-source-read-only-reason");
  await expect(page.getByText("https://wetter.example.test/current")).toBeVisible();
  const status = page.locator(".api-source-panel__list-toolbar .list-toolbar__status");
  expect(await status.evaluate((element) => getComputedStyle(element).display)).toBe("none");
  const toolbarBounds = await page.locator(".api-source-panel__list-toolbar").boundingBox();
  const rowBounds = await page.locator(".api-source-panel__row").first().boundingBox();
  expect(toolbarBounds).not.toBeNull();
  expect(rowBounds).not.toBeNull();
  if (toolbarBounds !== null && rowBounds !== null) {
    const gap = rowBounds.y - (toolbarBounds.y + toolbarBounds.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(14);
  }
});

test("location operators see read-only properties and one permission reason", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    location: { name: "Berlin, Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
  });
  await page.goto(`/channels/${channelId}/location-weather`);

  await expect(page.locator(".channel-location-page__properties")).toContainText("Europe/Berlin");
  await expect(page.getByRole("combobox", { name: "Kanalzeitzone" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Standort ändern" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Standort entfernen" })).toBeDisabled();
  await expect(page.locator(".channel-location-page .ui-locked-reason:not(.ui-locked-reason--reserved)")).toHaveCount(1);
});

test("location and data source pages scroll in the shell main with a fixed header", async ({ page }) => {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ] as const;
  const pages = [
    { kind: "location", path: `/channels/${channelId}/location-weather` },
    { kind: "data source", path: `/channels/${channelId}/modules/api_source` },
  ] as const;

  await installLiveCockpitMocks(page, { channelId });
  await installSourceRoute(page);

  for (const { kind, path } of pages) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.locator(".dashboard-shell__main")).toBeVisible();
      if (kind === "location") await expect(page.locator(".channel-location-page")).toBeVisible();
      else await expect(page.locator(".api-source-panel .collection-page")).toBeVisible();

      const before = await page.evaluate((pageKind) => {
        const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
        const content = document.querySelector<HTMLElement>(".main-content");
        const header = document.querySelector<HTMLElement>(".dashboard-shell__header");
        const sidebar = document.querySelector<HTMLElement>(".dashboard-shell__navbar");
        if (main === null || content === null || header === null) throw new Error("The dashboard shell is incomplete.");
        const locationSections = Array.from(document.querySelectorAll<HTMLElement>(".channel-location-page .ui-section"));
        const timeZoneHint = document.querySelector<HTMLElement>(".channel-location-page .ui-select__description");
        const nextLocationHeading = locationSections[1]?.querySelector<HTMLElement>(".ui-section__heading") ?? null;
        const locationColumnOverflowY = Array.from(document.querySelectorAll<HTMLElement>(".channel-location-page .settings-page__column"))
          .map((element) => getComputedStyle(element).overflowY);
        const innerScrollRegions = Array.from(content.querySelectorAll<HTMLElement>("*"))
          .filter((element) => !element.matches("textarea, .ui-select__options, .ui-select__dropdown, .ui-template-text-field__suggestions"))
          .filter((element) => {
            const style = getComputedStyle(element);
            return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
          })
          .filter((element) => pageKind !== "data source" || !element.matches(".collection-page__list-content, .collection-page__detail"))
          .map((element) => element.className);
        const headerTop = header.getBoundingClientRect().top;
        const sidebarTop = sidebar?.getBoundingClientRect().top ?? null;
        const spacer = document.createElement("div");
        spacer.setAttribute("aria-hidden", "true");
        spacer.style.height = "1800px";
        spacer.style.flex = "none";
        content.appendChild(spacer);
        return {
          mainOverflowY: getComputedStyle(main).overflowY,
          mainTabIndex: main.tabIndex,
          headerTop,
          sidebarTop,
          locationColumnOverflowY,
          locationSectionGap: timeZoneHint === null || nextLocationHeading === null
            ? null
            : nextLocationHeading.getBoundingClientRect().top - timeZoneHint.getBoundingClientRect().bottom,
          innerScrollRegions,
        };
      }, kind);

      expect(before.mainOverflowY, `${kind} main scrolls at ${String(viewport.width)}px`).toBe("auto");
      expect(before.mainTabIndex).toBe(-1);
      expect(before.innerScrollRegions, `${kind} has no unintended nested scroll regions`).toEqual([]);
      if (kind === "location") expect(before.locationColumnOverflowY).toEqual(["visible", "visible", "visible"]);
      if (kind === "location" && viewport.width === 390) {
        expect(before.locationSectionGap, "location sections keep their natural mobile spacing").not.toBeNull();
        expect(before.locationSectionGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(40);
      }
      await page.locator(".dashboard-shell__main").evaluate((element: HTMLElement) => { element.scrollTop = 240; });
      await expect.poll(() => page.locator(".dashboard-shell__main").evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(0);

      const after = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
        const header = document.querySelector<HTMLElement>(".dashboard-shell__header");
        const sidebar = document.querySelector<HTMLElement>(".dashboard-shell__navbar");
        if (main === null || header === null) throw new Error("The dashboard shell is incomplete.");
        return {
          mainScrollTop: main.scrollTop,
          documentScrollTop: document.documentElement.scrollTop,
          headerTop: header.getBoundingClientRect().top,
          sidebarTop: sidebar?.getBoundingClientRect().top ?? null,
        };
      });
      expect(after.mainScrollTop).toBeGreaterThan(0);
      expect(after.documentScrollTop).toBe(0);
      expect(Math.abs(after.headerTop - before.headerTop)).toBeLessThanOrEqual(1);
      if (before.sidebarTop !== null && after.sidebarTop !== null) {
        expect(Math.abs(after.sidebarTop - before.sidebarTop)).toBeLessThanOrEqual(1);
      }
    }
  }
});

test("source wizard guards dirty drafts and keeps narrow summaries inside the dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSourceRoute(page);
  await page.goto(`/channels/${channelId}/modules/api_source`);
  await page.getByRole("button", { name: "Quelle anlegen" }).click();

  const dialog = page.getByRole("dialog", { name: "Datenquelle anlegen" });
  const url = page.getByRole("textbox", { name: "Webadresse" });
  await url.fill(`https://example.test/current?q=${"x".repeat(160)}`);
  await url.press("Enter");
  await expect(dialog.locator("[data-step='2']")).toBeVisible();

  const field = page.getByRole("textbox", { name: "Wert aus der Antwort" });
  const fieldRow = page.locator(".api-source-panel__step .inspector-field-row");
  const stacked = await fieldRow.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".inspector-field-row__label");
    const control = element.querySelector<HTMLElement>(".inspector-field-row__control");
    return label !== null && control !== null && label.getBoundingClientRect().bottom <= control.getBoundingClientRect().top;
  });
  expect(stacked).toBe(true);
  await expect(field).toBeVisible();
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(dialog.locator("[data-step='3'] code").first()).toBeVisible();
  const dialogOverflow = await dialog.locator(".ui-step-dialog__body").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(dialogOverflow).toBe(false);
  const summaryStyle = await dialog.locator("[data-step='3'] code").first().evaluate((element) => getComputedStyle(element).overflowWrap);
  expect(summaryStyle).toBe("anywhere");
  const testButton = page.getByRole("button", { name: "Testen" });
  const testButtonBox = await testButton.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(testButtonBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  if (testButtonBox !== null && dialogBox !== null) expect(testButtonBox.width).toBeLessThan(dialogBox.width * 0.6);
  await testButton.click();
  const output = page.getByTestId("api-source-test-result");
  await expect(output).toContainText("Erfolgreich · HTTP 200");
  const outputStyle = await output.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderStyle: style.borderStyle, backgroundColor: style.backgroundColor };
  });
  expect(outputStyle.borderStyle).toBe("solid");
  expect(outputStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  const treeStyle = await output.getByTestId("api-source-json-tree").evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(treeStyle.overflowY).toBe("auto");
  expect(treeStyle.scrollHeight).toBeGreaterThan(treeStyle.height);
  expect(dialogBox).not.toBeNull();
  if (dialogBox !== null) expect(dialogBox.height).toBeLessThanOrEqual(844 - 32);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ungespeicherte Änderungen" })).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(dialog.locator("[data-step='3'] code").first()).toHaveText(`https://example.test/current?q=${"x".repeat(160)}`);
  await dialog.getByRole("button", { name: "Zurück" }).click();
  await dialog.getByRole("button", { name: "Zurück" }).click();
  await expect(url).toHaveValue(`https://example.test/current?q=${"x".repeat(160)}`);
});

test("source wizard displays typed test failures inside its bounded result panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSourceRoute(page, "manager", "timeout");
  await page.goto(`/channels/${channelId}/modules/api_source`);
  await page.getByRole("button", { name: "Quelle anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Datenquelle anlegen" });
  await page.getByRole("textbox", { name: "Webadresse" }).fill("https://example.test/weather");
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Wert aus der Antwort" }).fill("$.temperature");
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByRole("button", { name: "Testen" }).click();

  const result = page.getByTestId("api-source-test-result");
  await expect(result.getByRole("alert")).toContainText("Der Endpunkt hat nicht rechtzeitig geantwortet.");
  const resultBox = await result.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(resultBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  if (resultBox !== null && dialogBox !== null) {
    expect(resultBox.width).toBeLessThanOrEqual(dialogBox.width);
    expect(resultBox.height).toBeLessThanOrEqual(320);
  }
});

test("editing a source guards both dialog close and dashboard navigation", async ({ page }) => {
  await installSourceRoute(page);
  await page.goto(`/channels/${channelId}/modules/api_source`);
  await page.getByRole("button", { name: /wetter/u }).click();
  await page.getByRole("button", { name: "Quelle bearbeiten" }).click();
  const editor = page.getByRole("dialog", { name: "Quelle bearbeiten" });
  const url = editor.getByRole("textbox", { name: "Webadresse" });
  await url.fill("https://wetter.example.test/changed");

  await page.keyboard.press("Escape");
  const guard = page.getByRole("dialog", { name: "Ungespeicherte Änderungen" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(url).toHaveValue("https://wetter.example.test/changed");

  await page.locator(".sidebar-nav-link").first().evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })));
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/modules/api_source$`, "u"));
  await guard.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(url).toHaveValue("https://wetter.example.test/changed");
});

test("the cockpit warning slot keeps its tile geometry when the location warning clears", async ({ page }) => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await installLiveCockpitMocks(page, { channelId });
    await page.goto(`/channels/${channelId}`);
    const slot = page.locator(".live-cockpit__warning-slot");
    await expect(slot.locator(".live-cockpit__warning-summary")).toBeVisible();
    await expect(slot.getByRole("button", { name: "Einrichten" })).toBeVisible();
    const beforeSlot = await slot.boundingBox();
    const beforeWall = await page.locator(".live-cockpit__wall").boundingBox();
    const beforeHeader = await page.locator(".live-cockpit-header").boundingBox();
    expect(beforeSlot).not.toBeNull();
    expect(beforeWall).not.toBeNull();
    expect(beforeHeader).not.toBeNull();
    await slot.evaluate((element) => {
      element.dataset.warningCount = "0";
      element.querySelector(".live-cockpit__location-warning")?.remove();
      element.querySelector(".live-cockpit__warning-summary")?.remove();
    });
    const afterSlot = await slot.boundingBox();
    const afterWall = await page.locator(".live-cockpit__wall").boundingBox();
    const afterHeader = await page.locator(".live-cockpit-header").boundingBox();
    expect(afterWall).not.toBeNull();
    expect(afterHeader).not.toBeNull();
    if (beforeWall !== null && afterWall !== null && beforeHeader !== null && afterHeader !== null) {
      expect(Math.abs(beforeHeader.height - afterHeader.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(beforeHeader.y + beforeHeader.height - (afterHeader.y + afterHeader.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(beforeWall.y - afterWall.y)).toBeLessThanOrEqual(1);
    }
    if (viewport.width <= 767) {
      // On mobile the empty slot stays rendered (hidden) so its height is reserved.
      expect(afterSlot).not.toBeNull();
      if (beforeSlot !== null && afterSlot !== null) expect(Math.abs(beforeSlot.height - afterSlot.height)).toBeLessThanOrEqual(1);
    }
    await page.unrouteAll({ behavior: "wait" });
  }
});
