import { expect, test, type Page } from "@playwright/test";

const TIMESTAMP = "2030-01-01T12:00:00.000Z";
const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

const routeJson = async (page: Page, path: string, value: unknown): Promise<void> => {
  await page.route(`**${path}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
};

const openDirtyEditor = async (page: Page, panel: "faq" | "text_commands", viewport: (typeof VIEWPORTS)[number]): Promise<void> => {
  await page.setViewportSize(viewport);
  await routeJson(page, "/api/channels/channel-a/settings", {
    timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
    defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
  });
  await routeJson(page, "/api/channels/channel-a/template-variables", { variables: [] });
  await routeJson(page, "/api/channels/channel-a/modules/faq/entries", { orderRevision: 1, entries: [{
    id: "faq-a", name: "hallo", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello!",
    minimumTier: "everyone", cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: "source_only", order: 0, revision: 1,
    lastUsedAt: null, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
  }] });
  await routeJson(page, "/api/channels/channel-a/modules/text_commands/commands", {
    commands: [{
      channelId: "channel-a", name: "hallo", text: "Hallo {user}", kind: "text", enabled: true, minimumTier: "everyone",
      cooldownSeconds: 30, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", variableAction: null,
      useCount: 0, lastUsedAt: null, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
    }],
    variables: [],
  });

  await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}&lang=de`);
  if (panel === "text_commands") {
    await page.locator("main.main-content").evaluate((element) => {
      Object.assign(element.style, { display: "flex", flexDirection: "column", height: "100dvh", minHeight: "0" });
    });
  }
  if (panel === "faq") {
    const entry = page.locator(".faq-panel__entry").filter({ hasText: "hallo" });
    await expect(entry).toBeVisible();
    await entry.click();
    await page.locator(".faq-panel__answer-preview textarea").fill("Hallo, geändert!");
  } else {
    const entry = page.locator(".text-command-row").filter({ hasText: "!hallo" });
    await expect(entry).toBeVisible();
    await entry.click();
    await page.locator(".text-command-editor textarea").first().fill("Hallo, geändert!");
  }

  await expect(page.locator(".page-header--editor .page-header__action-hint")).toContainText("Speichere oder verwerfe Änderungen");
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
}

const expectEditorHeaderGeometry = async (page: Page, panel: "faq" | "text_commands"): Promise<void> => {
  const header = page.locator(".page-header--editor");
  const title = header.locator(".page-header__title-row :is(h1, h2, h3)");
  const expectedTitle = panel === "text_commands" ? "!hallo" : "hallo";
  await expect(title).toHaveText(expectedTitle);

  const geometry = await header.evaluate((element) => {
    const box = (node: Element | null): { x: number; y: number; right: number; bottom: number; width: number; height: number } | null => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const parts: { name: string; rect: NonNullable<ReturnType<typeof box>> }[] = [];
    const add = (name: string, node: Element | null): void => {
      const rect = box(node);
      if (rect !== null && rect.width > 0 && rect.height > 0) parts.push({ name, rect });
    };

    add("title", element.querySelector(".page-header__title-row :is(h1, h2, h3)"));
    element.querySelectorAll(".page-header__module-switch, .page-header__badges, .page-header__meta").forEach((node, index) => { add(`status-${String(index)}`, node); });
    element.querySelectorAll<HTMLElement>(".page-header__page-actions button, .page-header__overflow-trigger").forEach((node, index) => { add(`action-${String(index)}`, node); });
    add("hint", element.querySelector(".page-header__action-hint"));

    const titleNode = element.querySelector<HTMLElement>(".page-header__title-row :is(h1, h2, h3)");
    const hintNode = element.querySelector<HTMLElement>(".page-header__action-hint");
    const copyNode = element.querySelector<HTMLElement>(".page-header__copy");
    const actionNodes = Array.from(element.querySelectorAll<HTMLElement>(".page-header__page-actions button, .page-header__overflow-trigger"));
    const actionRects = actionNodes.map((node) => node.getBoundingClientRect());
    const commonActionRow = actionRects.length > 0
      && Math.min(...actionRects.map((rect) => rect.bottom)) > Math.max(...actionRects.map((rect) => rect.top));
    const titleStyle = titleNode === null ? null : getComputedStyle(titleNode);
    return {
      parts,
      commonActionRow,
      actionCount: actionNodes.length,
      titleHeight: titleNode?.getBoundingClientRect().height ?? 0,
      titleLineHeight: titleStyle === null ? 0 : Number.parseFloat(titleStyle.lineHeight),
      copyBottom: copyNode?.getBoundingClientRect().bottom ?? 0,
      actionTop: actionRects.length === 0 ? 0 : Math.min(...actionRects.map((rect) => rect.top)),
      actionBottom: actionRects.length === 0 ? 0 : Math.max(...actionRects.map((rect) => rect.bottom)),
      hintTop: hintNode?.getBoundingClientRect().top ?? 0,
      hintBottom: hintNode?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
      hintScrollWidth: hintNode?.scrollWidth ?? 0,
      hintClientWidth: hintNode?.clientWidth ?? 0,
      hintScrollHeight: hintNode?.scrollHeight ?? 0,
      hintClientHeight: hintNode?.clientHeight ?? 0,
      hintTextOverflow: hintNode === null ? "missing" : getComputedStyle(hintNode).textOverflow,
    };
  });

  const collisions: string[] = [];
  for (let left = 0; left < geometry.parts.length; left += 1) {
    for (let right = left + 1; right < geometry.parts.length; right += 1) {
      const first = geometry.parts[left];
      const second = geometry.parts[right];
      if (first === undefined || second === undefined) continue;
      const overlapX = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.x, second.rect.x);
      const overlapY = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.y, second.rect.y);
      if (overlapX > 0.5 && overlapY > 0.5) collisions.push(`${first.name} intersects ${second.name}`);
    }
  }

  expect(collisions).toEqual([]);
  expect(geometry.actionCount).toBe(2);
  expect(geometry.commonActionRow).toBe(true);
  expect(geometry.hintTop).toBeGreaterThanOrEqual(geometry.actionBottom - 0.5);
  expect(geometry.hintBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  if (geometry.actionTop >= geometry.copyBottom - 0.5) {
    expect(geometry.actionTop - geometry.copyBottom).toBeLessThanOrEqual(24);
  }
  expect(geometry.hintScrollWidth).toBeLessThanOrEqual(geometry.hintClientWidth);
  expect(geometry.hintScrollHeight).toBeLessThanOrEqual(geometry.hintClientHeight + 1);
  expect(geometry.hintTextOverflow).not.toBe("ellipsis");
  expect(geometry.titleHeight).toBeLessThanOrEqual(geometry.titleLineHeight + 1.5);
};

const expectMobileSaveBarGeometry = async (page: Page, panel: "faq" | "text_commands"): Promise<void> => {
  const saveBar = page.locator(".page-header--editor .page-header__save");
  await expect(saveBar).toBeVisible();
  await expect(saveBar.getByRole("button", { name: "Speichern", exact: true })).toBeVisible();
  await expect(saveBar.getByRole("button", { name: "Verwerfen", exact: true })).toBeVisible();

  const geometry = await page.evaluate((editorPanel) => {
    const saveBarNode = document.querySelector<HTMLElement>(".page-header--editor .page-header__save");
    const scroll = editorPanel === "faq"
      ? document.querySelector<HTMLElement>(".faq-panel__editor")
      : document.querySelector<HTMLElement>(".text-command-editor__scroll");
    const finalField = editorPanel === "faq"
      ? document.querySelector<HTMLElement>(".faq-panel__editor > :last-child")
      : document.querySelector<HTMLElement>(".text-command-editor__scroll .command-usage-advanced > summary");
    if (saveBarNode === null || scroll === null || finalField === null) throw new Error("The mobile editor save geometry is incomplete.");

    scroll.scrollTop = scroll.scrollHeight;
    const saveRect = saveBarNode.getBoundingClientRect();
    const fieldRect = finalField.getBoundingClientRect();
    return {
      position: getComputedStyle(saveBarNode).position,
      saveLeft: saveRect.left,
      saveTop: saveRect.top,
      saveRight: saveRect.right,
      saveBottom: saveRect.bottom,
      fieldBottom: fieldRect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }, panel);

  expect(geometry.position).toBe("fixed");
  expect(geometry.saveLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.saveRight).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.saveTop).toBeGreaterThanOrEqual(0);
  expect(geometry.saveBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.fieldBottom).toBeLessThanOrEqual(geometry.saveTop);
};

for (const panel of ["text_commands", "faq"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`${panel} editor header stays readable at ${String(viewport.width)}x${String(viewport.height)}`, async ({ page }) => {
      await openDirtyEditor(page, panel, viewport);
      await expectEditorHeaderGeometry(page, panel);
      if (viewport.width <= 768) await expectMobileSaveBarGeometry(page, panel);
    });
  }
}
