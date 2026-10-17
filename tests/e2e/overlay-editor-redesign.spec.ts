import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-overlay-redesign";
const overlayId = "overlay-redesign";
const channel = {
  channelId,
  login: "overlay-redesign",
  displayName: "Overlay redesign",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-10T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-10T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-redesign", reason: null, updatedAt: "2026-10-10T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};

const overlay = {
  id: overlayId,
  channelId,
  name: "Stream-Overlay",
  width: 1920,
  height: 1080,
  css: "",
  revision: 1,
  createdAt: "2026-10-10T20:15:00.000Z",
  updatedAt: "2026-10-10T20:15:00.000Z",
  elements: [
    { id: "element-score", kind: "variable", label: "Punktestand", variableName: "score", text: "Punkte: {value}", config: {}, x: 80, y: 80, scalePercent: 100, z: 0, inComposition: true },
    { id: "element-streak", kind: "variable", label: "Serie", variableName: "streak", text: "Serie: {value}", config: {}, x: 80, y: 180, scalePercent: 100, z: 1, inComposition: true },
  ],
};

const routeApi = async (page: Page, overlayUnavailable = false, createMode: "success" | "error" = "success"): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200): Promise<void> => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === "/api/csrf") return json({ token: "csrf-overlay-redesign" });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}`) {
      return overlayUnavailable
        ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "overlay_not_found" }) })
        : json({ overlay });
    }
    if (pathname === `/api/channels/${channelId}/overlays` && method === "POST") {
      if (createMode === "error") return json({ error: "overlay_data_invalid" }, 400);
      const body = route.request().postDataJSON() as { name: string; width: number; height: number; elements: typeof overlay.elements };
      return json({ overlay: {
        ...overlay,
        id: "overlay-created",
        name: body.name,
        width: body.width,
        height: body.height,
        revision: 1,
        elements: body.elements,
      } }, 201);
    }
    if (pathname === `/api/channels/${channelId}/overlays/overlay-created/accesses` && method === "POST") {
      return json({
        tokenId: "access-created", label: "OBS-Einbindung", expiresAt: null,
        overlayUrl: `https://example.test/overlay#token=${"a".repeat(43)}`,
      }, 201);
    }
    if (pathname === `/api/channels/${channelId}/overlays/overlay-created/accesses` && method === "GET") {
      return json({ accesses: [{
        tokenId: "access-created", overlayId: "overlay-created", label: "OBS-Einbindung",
        createdAt: "2026-10-10T20:15:00.000Z", expiresAt: null, revokedAt: null, lastUsedAt: null, recoverable: true,
      }], activeCount: 1, maximum: 10 });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({
      variables: [
        { name: "score", value: 42, description: "Punktestand" },
        { name: "streak", value: 8, description: "Serie" },
      ], count: 2, maximum: 20,
    });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

test("overlay workspace fills desktop viewport without page scrolling and adapts at all target widths", async ({ page }) => {
  await routeApi(page);
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Stream-Overlay" })).toBeVisible();

  for (const width of [1920, 1280, 1024, 769, 390, 2560]) {
    const height = width === 390 ? 844 : width === 2560 ? 1440 : width === 1920 ? 1080 : 800;
    await page.setViewportSize({ width, height });
    if (width < 769 && await page.locator(".dashboard-shell__burger").getAttribute("aria-expanded") === "true") {
      await page.locator(".dashboard-shell__burger").click();
    }
    const geometry = await page.locator(".overlay-editor__workspace").evaluate((workspace) => {
      const editor = workspace.closest(".overlay-editor") as HTMLElement;
      const shellMain = document.querySelector<HTMLElement>(".dashboard-shell__main");
      const columns = Array.from(workspace.children, (child) => {
        const rect = child.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      });
      const computed = getComputedStyle(workspace);
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        titleHeight: document.querySelector<HTMLElement>(".page-header h1")?.getBoundingClientRect().height ?? 0,
        gridTemplateColumns: computed.gridTemplateColumns,
        workspaceOverflowY: computed.overflowY,
        columnOverflowY: Array.from(workspace.children, (child) => getComputedStyle(child).overflowY),
        shellMain: shellMain === null ? null : {
          scrollHeight: shellMain.scrollHeight,
          clientHeight: shellMain.clientHeight,
        },
        editorHeight: editor.getBoundingClientRect().height,
        columns,
      };
    });

    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    expect(geometry.titleHeight).toBeLessThanOrEqual(32);
    if (width >= 1280) {
      expect(geometry.documentHeight).toBeLessThanOrEqual(height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(3);
      expect(geometry.columns[0]?.width).toBeGreaterThanOrEqual(width === 1280 ? 190 : 230);
      expect(geometry.columns[1]?.width).toBeGreaterThanOrEqual(width === 1280 ? 260 : 500);
      expect(geometry.columns[2]?.width).toBeGreaterThanOrEqual(width === 1280 ? 340 : 540);
    } else if (width >= 761) {
      expect(geometry.documentHeight).toBeLessThanOrEqual(height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(2);
      expect(geometry.columns[0]?.width).toBeGreaterThanOrEqual(180);
      expect(geometry.columns[1]?.width).toBeGreaterThan(240);
      expect(geometry.columns[0]?.right).toBeLessThanOrEqual(geometry.columns[1]?.left ?? 0);
    } else {
      expect(geometry.shellMain?.scrollHeight).toBeGreaterThan(geometry.shellMain?.clientHeight ?? height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(1);
      expect(geometry.columns[0]?.width).toBeLessThanOrEqual(width);
    }
  }
});

test("canvas and element list share selection with full-row highlighting at target widths", async ({ page }) => {
  await routeApi(page);

  const scoreRow = page.locator('[data-element-row="element-score"] .overlay-editor__element-select');
  const streakRow = page.locator('[data-element-row="element-streak"] .overlay-editor__element-select');
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
    if (viewport.width < 761 && await page.locator(".dashboard-shell__burger").getAttribute("aria-expanded") === "true") {
      await page.locator(".dashboard-shell__burger").click();
    }
    await expect(scoreRow).toHaveAttribute("aria-pressed", "true");
    const initialSelection = await page.locator('[data-element-row="element-score"]').evaluate((row) => {
      const th = row.querySelector<HTMLElement>("th");
      const td = row.querySelector<HTMLElement>("td");
      if (th === null || td === null) throw new Error("The selected row is missing a cell.");
      const rowBox = row.getBoundingClientRect();
      const thBox = th.getBoundingClientRect();
      const tdBox = td.getBoundingClientRect();
      return {
        leftGap: Math.abs(thBox.left - rowBox.left),
        rightGap: Math.abs(tdBox.right - rowBox.right),
        rowShadow: getComputedStyle(row).boxShadow,
        beforeContent: getComputedStyle(row, "::before").content,
        thBackground: getComputedStyle(th).backgroundColor,
        tdBackground: getComputedStyle(td).backgroundColor,
        leftBorder: getComputedStyle(th).borderLeftWidth,
        rightBorder: getComputedStyle(td).borderRightWidth,
      };
    });
    expect(initialSelection.leftGap).toBeLessThanOrEqual(1);
    expect(initialSelection.rightGap).toBeLessThanOrEqual(1);
    expect(initialSelection.rowShadow).toBe("none");
    expect(["none", "normal"]).toContain(initialSelection.beforeContent);
    expect(initialSelection.thBackground).toBe(initialSelection.tdBackground);
    expect(initialSelection.leftBorder).toBe("1px");
    expect(initialSelection.rightBorder).toBe("1px");

    const propertyLayout = await page.locator(".overlay-editor__property-fields").evaluate((fields) => {
      const numeric = fields.querySelector<HTMLElement>(".overlay-editor__numeric-fields");
      const layerActions = fields.querySelector<HTMLElement>(".overlay-editor__layer-actions");
      if (numeric === null || layerActions === null) throw new Error("The selected element properties are missing.");
      const numericInputs = Array.from(numeric.querySelectorAll<HTMLElement>(".unit-input"), (input) => input.getBoundingClientRect());
      const buttons = Array.from(layerActions.querySelectorAll<HTMLButtonElement>("button"));
      return {
        fieldsGap: getComputedStyle(fields).rowGap,
        numericGap: getComputedStyle(numeric).columnGap,
        numericWidths: numericInputs.map(({ width }) => width),
        layerGap: getComputedStyle(layerActions).columnGap,
        layerWidths: buttons.map(({ offsetWidth }) => offsetWidth),
        layerTitles: buttons.map((button) => button.title),
        backwardTransform: buttons[1]?.querySelector("svg") === null || buttons[1]?.querySelector("svg") === undefined
          ? "none"
          : getComputedStyle(buttons[1].querySelector("svg") as SVGElement).transform,
      };
    });
    expect(propertyLayout.fieldsGap).toBe("8px");
    expect(propertyLayout.numericGap).toBe("8px");
    expect(propertyLayout.numericWidths).toHaveLength(4);
    expect(Math.abs((propertyLayout.numericWidths[0] ?? 0) - (propertyLayout.numericWidths[1] ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((propertyLayout.numericWidths[2] ?? 0) - (propertyLayout.numericWidths[3] ?? 0))).toBeLessThanOrEqual(1);
    expect(propertyLayout.layerGap).toBe("8px");
    expect(propertyLayout.layerWidths).toEqual([36, 36]);
    expect(propertyLayout.layerTitles).toEqual(["Eine Ebene nach vorn", "Eine Ebene nach hinten"]);
    expect(propertyLayout.backwardTransform).not.toBe("none");

    await streakRow.click();
    await expect(streakRow).toHaveAttribute("aria-pressed", "true");
    await expect(scoreRow).toHaveAttribute("aria-pressed", "false");
    await page.frameLocator('[data-testid="overlay-editor-renderer"]').locator('[data-element="element-score"]').click();
    await expect(scoreRow).toHaveAttribute("aria-pressed", "true");
    await expect(streakRow).toHaveAttribute("aria-pressed", "false");
    const selectedBounds = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
      const host = frame?.contentDocument?.querySelector<HTMLElement>("[data-brobot-editor-bounds-layer]");
      const bounds = host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-brobot-editor-bound]") ?? [];
      const selected = host?.shadowRoot?.querySelector<HTMLElement>('[data-brobot-editor-bound][data-selected="true"]');
      return {
        count: bounds.length,
        selectedId: selected?.dataset.brobotEditorBound,
        borderWidth: selected === null || selected === undefined ? null : getComputedStyle(selected).borderTopWidth,
        borderStyle: selected === null || selected === undefined ? null : getComputedStyle(selected).borderTopStyle,
      };
    });
    expect(selectedBounds).toEqual({ count: 1, selectedId: "element-score", borderWidth: "1px", borderStyle: "solid" });

    await page.getByRole("textbox", { name: "Elementname" }).fill("Punktestand live");
    const saveStatus = page.locator(".ui-save-bar__status");
    await expect(saveStatus.getByText("Ungespeicherte Änderungen", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Verwerfen", exact: true })).toBeVisible();
    await expect(page.locator(".overlay-editor__preview-foot")).toHaveAttribute("title", "Gespeicherte Komposition. Änderungen werden erst nach dem Speichern live.");
    const statusBox = await saveStatus.boundingBox();
    const discardBox = await page.getByRole("button", { name: "Verwerfen", exact: true }).boundingBox();
    expect(statusBox).not.toBeNull();
    expect(discardBox).not.toBeNull();
    if (statusBox !== null && discardBox !== null) {
      expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(discardBox.x + discardBox.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }
});

test("creation wizard keeps a fixed dialog and error row while picker controls stay inline", async ({ page }) => {
  await routeApi(page, false, "error");
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/overlays/new`);

    const dialog = page.locator(".ui-step-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Test overlay");
    const detailsBox = await dialog.boundingBox();
    const detailsErrorBox = await dialog.locator(".overlay-editor__create-error").boundingBox();
    expect(detailsBox).not.toBeNull();
    expect(detailsErrorBox?.height ?? 0).toBeGreaterThanOrEqual(40);

    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    const elementsBox = await dialog.boundingBox();
    expect(elementsBox).not.toBeNull();
    if (detailsBox !== null && elementsBox !== null) {
      expect(Math.abs(elementsBox.x - detailsBox.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(elementsBox.y - detailsBox.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(elementsBox.width - detailsBox.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(elementsBox.height - detailsBox.height)).toBeLessThanOrEqual(0.5);
    }
    const selectBox = await dialog.locator("#overlay-editor-create-element").boundingBox();
    const addButton = dialog.getByRole("button", { name: "Hinzufügen", exact: true });
    const addBox = await addButton.boundingBox();
    expect(selectBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    if (selectBox !== null && addBox !== null) {
      expect(Math.abs(selectBox.y + selectBox.height - addBox.y - addBox.height)).toBeLessThanOrEqual(4);
      expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(addBox.x + 1);
    }
    await addButton.click();
    await dialog.getByRole("button", { name: "Overlay anlegen und OBS-Link erstellen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("ungültig");
    const errorBox = await dialog.boundingBox();
    const populatedErrorBox = await dialog.locator(".overlay-editor__create-error").boundingBox();
    expect(populatedErrorBox?.height ?? 0).toBeGreaterThanOrEqual(40);
    expect(populatedErrorBox?.height).toBe(detailsErrorBox?.height);
    expect(errorBox?.height).toBe(detailsBox?.height);
  }
});

test("created OBS link and copy action remain on one row at narrow width", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await routeApi(page);
  await page.goto(`/channels/${channelId}/overlays/new`);
  const dialog = page.locator(".ui-step-dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Mobile overlay");
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await dialog.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  let createPayload: { elements?: readonly unknown[] } | undefined;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/channels/${channelId}/overlays`)) {
      createPayload = request.postDataJSON() as { elements?: readonly unknown[] };
    }
  });
  await dialog.getByRole("button", { name: "Overlay anlegen und OBS-Link erstellen" }).click();
  const link = dialog.locator(".overlay-editor__create-link code");
  const copy = dialog.getByRole("button", { name: "Link kopieren" });
  await expect(link).toContainText("#token=");
  expect(createPayload?.elements).toHaveLength(1);
  const linkBox = await link.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(linkBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  if (linkBox !== null && copyBox !== null) {
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(copyBox.x + 1);
    expect(Math.abs((linkBox.y + linkBox.height / 2) - (copyBox.y + copyBox.height / 2))).toBeLessThanOrEqual(2);
  }
  await copy.click();
  await expect(page.getByText("Link kopiert").last()).toBeVisible();
});

test("overlay load errors stay inline without a duplicate toast", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeApi(page, true);
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);

  await expect(page.locator(".overlay-editor--message [role=alert]")).toBeVisible();
  await expect(page.locator(".ui-toast")).toHaveCount(0);
});
