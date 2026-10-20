import { expect, test, type Page } from "@playwright/test";

import type { DryRunRequest, DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-r5-regressions";

const response = (text: string, muted = false): DryRunResponse => {
  const timeoutRequested = text.trim().startsWith("!timeout viewer_99");
  const entry: DryRunResponse["modules"][number]["entries"][number] = timeoutRequested ? {
    moduleId: "text_commands",
    entry: { kind: "text_command", id: "timeout", label: "!timeout" },
    outcome: "fires",
    match: { kind: "command_name", token: "!timeout" },
    blocks: [],
    effects: [
      {
        kind: "timeout", minSeconds: 30, maxSeconds: 30, reason: "Spam",
        ...(muted ? { suppressedBy: "channel_muted" as const } : {}),
      },
      {
        kind: "chat", text: "Timeout applied", target: "source_only", postsTo: "this_chat",
        reply: true, suppressedBy: muted ? "channel_muted" : null, automated: true, when: "on_success",
      },
      {
        kind: "chat", text: "Timeout failed", target: "source_only", postsTo: "this_chat",
        reply: true, suppressedBy: muted ? "channel_muted" : null, automated: true, when: "on_failure",
      },
    ],
    templateNotes: [],
  } : {
    moduleId: "text_commands",
    entry: { kind: "text_command", id: "discord", label: "!discord" },
    outcome: "fires",
    match: { kind: "alias", token: "dc" },
    blocks: [],
    effects: [{
      kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only", postsTo: "this_chat",
      reply: true, suppressedBy: muted ? "channel_muted" : null, automated: true,
    }],
    templateNotes: [],
  };
  const modules: DryRunResponse["modules"] = [
    { moduleId: "text_commands", status: "reacts", entries: [entry] },
    ...(text.includes("partialfailure") ? [{ moduleId: "faq", status: "error" as const, error: "module_error" as const, entries: [] }] : []),
  ];

  return {
    evaluatedAt: "2030-01-01T12:01:00.000Z",
    controls: { muted, paused: false },
    sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
    modules,
  };
};

const openTestArea = async (page: Page, width: number, height: number, muted = false): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, (route) => {
    const request = route.request().postDataJSON() as DryRunRequest;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response(request.text, muted)),
    });
  });
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
};

const run = async (page: Page): Promise<void> => {
  const responseReceived = page.waitForResponse((candidate) =>
    candidate.url().endsWith(`/api/channels/${CHANNEL_ID}/dry-run`) && candidate.request().method() === "POST");
  await page.locator(".test-area__run-button:visible").click();
  await responseReceived;
  await expect(page.getByTestId("test-area-results-slot")).toHaveAttribute("aria-busy", "false");
};

test("shows a muted row, neutral suppressed effects, an equal-bound timeout, and one dialog heading", async ({ page }) => {
  await openTestArea(page, 1024, 768, true);
  await page.getByRole("textbox", { name: "Nachricht" }).fill("!timeout viewer_99");
  await run(page);

  const row = page.locator(".test-area__result-row").filter({ hasText: "!timeout" });
  await expect(row).toBeVisible();
  await expect(row.locator(".test-area__row-outcome")).toHaveText("Würde antworten (stumm)");
  await expect(row.locator(".status-led")).toHaveAttribute("data-status", "off");
  await row.click();

  const dialog = page.getByRole("dialog", { name: "!timeout" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "!timeout" })).toHaveCount(1);
  await expect(dialog.locator(".test-area__detail-heading h2")).toBeHidden();
  await expect(dialog.locator(".test-area__detail-meta")).toContainText("Textbefehl");
  await expect(dialog.locator(".test-area__detail-meta")).toContainText("Befehlsname");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Timeout 30 s");
  await expect(dialog.locator(".test-area__effect-list")).not.toContainText("Timeout 30–30 s");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Nur bei Erfolg");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Nur bei Fehler");
  const suppressedEffects = dialog.locator(".test-area__effect-list li.is-suppressed");
  await expect(suppressedEffects).toHaveCount(3);
  await expect(suppressedEffects.first().locator(".test-area__effect-icon--suppressed")).toBeVisible();
  await expect(suppressedEffects.first()).toContainText("Unterdrückt: Kanal stummgeschaltet");
});

test("keeps a plain text-command answer unconditional and puts conditions on the timeout command", async ({ page }) => {
  await openTestArea(page, 1920, 1080, true);
  await run(page);

  const plainReplyRow = page.locator(".test-area__result-row").filter({ hasText: "!discord" });
  await plainReplyRow.click();
  const detail = page.locator(".test-area__detail");
  await expect(detail.locator(".test-area__answer-item")).toContainText("Discord: discord.gg/beispiel");
  await expect(detail.locator(".test-area__answer-item .test-area__effect-qualifier")).toHaveCount(0);
  await expect(detail.locator(".test-area__answer-item")).not.toContainText("Nur bei Erfolg");

  await page.getByRole("textbox", { name: "Nachricht" }).fill("!timeout viewer_99");
  await run(page);
  const timeoutRow = page.locator(".test-area__result-row").filter({ hasText: "!timeout" });
  await expect(timeoutRow).toBeVisible();
  await timeoutRow.click();
  const timeoutDetail = page.locator(".test-area__detail");
  await expect(timeoutDetail.locator(".test-area__answer-item .test-area__effect-qualifier")).toHaveText([
    "Nur bei Erfolg",
    "Nur bei Fehler",
  ]);
});

test("keeps the shared-chat to module label gap in the same rhythm at desktop and tablet widths", async ({ page }) => {
  await openTestArea(page, 1920, 1080);

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const label = "label gap at " + String(viewport.width) + " by " + String(viewport.height);
    const gap = await page.evaluate(() => {
      const form = document.querySelector<HTMLElement>(".test-area__context-form");
      const sharedChatLabel = form?.querySelector<HTMLElement>(".ui-switch-row__copy strong");
      const moduleLabel = form?.querySelector<HTMLElement>(".ui-select .ui-field__label");
      if (sharedChatLabel === null || sharedChatLabel === undefined || moduleLabel === null || moduleLabel === undefined) return null;
      return moduleLabel.getBoundingClientRect().top - sharedChatLabel.getBoundingClientRect().bottom;
    });
    expect(gap, label).not.toBeNull();
    expect(gap, label).toBeCloseTo(8, 0);
  }
});

test("keeps the first result row close to its heading and stationary when hints appear at every width", async ({ page }) => {
  await openTestArea(page, 1920, 1080);
  const message = page.getByRole("textbox", { name: "Nachricht" });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    const pageHeaderHeightBeforeRun = await page.locator(".tool-page > .page-header")
      .evaluate((header) => header.getBoundingClientRect().height);
    await message.fill("!dc hallo");
    await run(page);
    const pageHeaderHeightAfterRun = await page.locator(".tool-page > .page-header")
      .evaluate((header) => header.getBoundingClientRect().height);
    expect(pageHeaderHeightAfterRun).toBe(pageHeaderHeightBeforeRun);

    const expectedResultsHeaderHeight = viewport.width <= 820 ? 97 : 70;
    const resultsHeaderHeight = await page.locator(".test-area__results-head")
      .evaluate((header) => header.getBoundingClientRect().height);
    expect(resultsHeaderHeight).toBe(expectedResultsHeaderHeight);

    if (viewport.width > 820) {
      const contextGap = await page.evaluate(() => {
        const moduleField = document.querySelector<HTMLElement>(".test-area__context-fields .ui-select");
        const runButton = document.querySelector<HTMLElement>(".test-area__context-footer .test-area__run-button");
        return moduleField === null || runButton === null
          ? null
          : runButton.getBoundingClientRect().top - moduleField.getBoundingClientRect().bottom;
      });
      expect(contextGap).not.toBeNull();
      expect(contextGap ?? 0).toBeGreaterThanOrEqual(0);
      expect(contextGap ?? 0).toBeLessThanOrEqual(16);

      const fieldLayout = await page.locator(".test-area__context-fields").evaluate((fields) => ({
        overflowY: getComputedStyle(fields).overflowY,
        scrolls: fields.scrollHeight > fields.clientHeight,
      }));
      expect(fieldLayout.overflowY).not.toMatch(/auto|scroll/u);
      expect(fieldLayout.scrolls).toBe(false);
    }

    const firstRow = page.locator(".test-area__result-row").first();
    await expect(firstRow).toBeVisible();
    const geometry = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>(".test-area__results-title");
      const metadata = document.querySelector<HTMLElement>(".test-area__results-meta");
      const row = document.querySelector<HTMLElement>(".test-area__result-row");
      if (title === null || metadata === null || row === null) return null;
      return {
        metadataBottom: metadata.getBoundingClientRect().bottom,
        titleTop: title.getBoundingClientRect().top,
        titleBottom: title.getBoundingClientRect().bottom,
        rowTop: row.getBoundingClientRect().top,
      };
    });
    expect(geometry, `${String(viewport.width)} by ${String(viewport.height)} results geometry`).not.toBeNull();
    expect((geometry?.titleTop ?? 0) - (geometry?.metadataBottom ?? 0)).toBeGreaterThanOrEqual(2);
    const gap = (geometry?.rowTop ?? 0) - (geometry?.titleBottom ?? 0);
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(gap).toBeLessThanOrEqual(12);

    const rowTopBeforeHint = await firstRow.evaluate((row) => row.getBoundingClientRect().top);
    await message.fill(`!dc geaendert-${String(viewport.width)}`);
    await expect(page.locator(".test-area__results-head").getByTestId("test-area-stale-result-hint"))
      .toHaveText("Eingaben geändert – Prüfen aktualisiert das Ergebnis");
    const rowTopAfterHint = await firstRow.evaluate((row) => row.getBoundingClientRect().top);
    expect(rowTopAfterHint).toBe(rowTopBeforeHint);

    await message.fill("!dc partialfailure");
    await run(page);
    const failureHint = page.getByTestId("test-area-incomplete-result-hint");
    await expect(failureHint).toContainText("Ergebnis unvollständig");
    const rowTopWithFailureHint = await firstRow.evaluate((row) => row.getBoundingClientRect().top);
    expect(rowTopWithFailureHint).toBe(rowTopBeforeHint);

    await message.fill(`!dc stale-${String(viewport.width)}`);
    const staleHint = page.getByTestId("test-area-stale-result-hint");
    await expect(staleHint).toBeVisible();
    await expect(failureHint).toBeVisible();
    const titleAndHintGeometry = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>(".test-area__results-title");
      const warning = document.querySelector<HTMLElement>("[data-testid='test-area-incomplete-result-hint']");
      const stale = document.querySelector<HTMLElement>("[data-testid='test-area-stale-result-hint']");
      if (title === null || warning === null || stale === null) return null;
      return {
        titleTop: title.getBoundingClientRect().top,
        warningBottom: warning.getBoundingClientRect().bottom,
        staleBottom: stale.getBoundingClientRect().bottom,
        warningFontSize: getComputedStyle(warning).fontSize,
        warningColor: getComputedStyle(warning).color,
        staleColor: getComputedStyle(stale).color,
      };
    });
    expect(titleAndHintGeometry).not.toBeNull();
    expect(titleAndHintGeometry?.titleTop ?? 0).toBeGreaterThanOrEqual(Math.max(
      titleAndHintGeometry?.warningBottom ?? 0,
      titleAndHintGeometry?.staleBottom ?? 0,
    ));
    expect(titleAndHintGeometry?.warningFontSize).toBe("12px");
    expect(titleAndHintGeometry?.warningColor).not.toBe(titleAndHintGeometry?.staleColor);
    expect(await firstRow.evaluate((row) => row.getBoundingClientRect().top)).toBe(rowTopBeforeHint);

    const gapWithFailureHint = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>(".test-area__results-title");
      const row = document.querySelector<HTMLElement>(".test-area__result-row");
      if (title === null || row === null) return null;
      return row.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
    });
    expect(gapWithFailureHint).not.toBeNull();
    expect(gapWithFailureHint ?? 0).toBeGreaterThanOrEqual(4);
    expect(gapWithFailureHint ?? 0).toBeLessThanOrEqual(12);
  }
});
