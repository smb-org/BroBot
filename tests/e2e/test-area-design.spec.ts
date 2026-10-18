import { expect, test, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const CHANNEL_ID = "test-area-design";

const response: DryRunResponse = {
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [
    {
      moduleId: "text_commands",
      status: "reacts",
      entries: [{
        moduleId: "text_commands",
        entry: { kind: "text_command", id: "discord", label: "!discord" },
        outcome: "fires",
        match: { kind: "alias", token: "dc" },
        blocks: [],
        effects: [{
          kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only", postsTo: "this_chat",
          reply: true, suppressedBy: null, automated: true,
        }],
        templateNotes: [],
      }],
    },
    {
      moduleId: "faq",
      status: "blocked",
      entries: [{
        moduleId: "faq",
        entry: { kind: "faq_entry", id: "faq-greeting", label: "Begrüßung" },
        outcome: "blocked",
        match: { kind: "keyword", pattern: "hallo" },
        blocks: [{ code: "faq.person_cooldown", detail: { remainingSeconds: 42 } }],
        effects: [],
        templateNotes: [],
      }],
    },
    { moduleId: "chat_voting", status: "silent", entries: [] },
    { moduleId: "votekick", status: "not_testable", entries: [] },
  ],
};

const openTestArea = async (page: Page, width: number, height: number): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(response),
  }));
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  await expect(page.locator(".test-area__context-form .ui-game-multi-select__single-value-name")).toHaveText("Just Chatting");
};

const submitProbe = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Prüfen", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
};

test("aligns the desktop context, fixed result rows, and highlighted detail with the prototype", async ({ page }) => {
  await openTestArea(page, 1920, 1080);
  await submitProbe(page);

  const geometry = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".page-header");
    const area = document.querySelector<HTMLElement>(".test-area");
    const form = document.querySelector<HTMLElement>(".test-area__context-form");
    const formChildren = form === null ? [] : Array.from(form.children);
    const formGaps = formChildren.slice(1).map((child, index) => {
      const previous = formChildren[index];
      return previous === undefined ? 0 : child.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    const heights = Array.from(document.querySelectorAll<HTMLElement>(
      ".test-area__badges .ui-chip-group__option, .test-area__context-form .segment-choice__option",
    )).map((button) => Math.round(button.getBoundingClientRect().height));
    const badgeLabel = document.querySelector<HTMLElement>(".test-area__badge-field > .ui-field__label");
    const badgeOption = document.querySelector<HTMLElement>(".test-area__badges .ui-chip-group__option");
    const game = document.querySelector<HTMLElement>(".test-area__context-form .ui-game-multi-select");
    const gameInput = game?.querySelector<HTMLInputElement>(".ui-game-multi-select__search > input");
    const gameValue = game?.querySelector<HTMLElement>(".ui-game-multi-select__single-value");
    const row = document.querySelector<HTMLElement>(".test-area__result-row");
    const moduleBadge = row?.querySelector<HTMLElement>(".test-area__module-badge");
    const roleOption = document.querySelector<HTMLElement>(".test-area__badges .ui-chip-group__option:not([aria-pressed='true'])");
    return {
      headerSeam: header === null || area === null ? null : area.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
      areaBorderTop: area === null ? null : getComputedStyle(area).borderTopWidth,
      formGaps,
      heights,
      badgeLabelText: badgeLabel?.textContent,
      badgeLabelBottom: badgeLabel?.getBoundingClientRect().bottom ?? null,
      badgeOptionTop: badgeOption?.getBoundingClientRect().top ?? null,
      gameInputBorder: gameInput === null || gameInput === undefined ? null : getComputedStyle(gameInput).borderTopWidth,
      gameValueBorder: gameValue === null || gameValue === undefined ? null : getComputedStyle(gameValue).borderTopWidth,
      missingArtCount: game?.querySelectorAll(".ui-game-multi-select__cover-placeholder").length ?? null,
      roleBorder: roleOption === null ? null : getComputedStyle(roleOption).borderTopWidth,
      roleBorderStyle: roleOption === null ? null : getComputedStyle(roleOption).borderTopStyle,
      badgeFill: moduleBadge === null || moduleBadge === undefined ? null : getComputedStyle(moduleBadge).backgroundColor,
      resultHeights: Array.from(document.querySelectorAll<HTMLElement>(".test-area__result-row")).map((resultRow) => resultRow.getBoundingClientRect().height),
      resultMainLineCounts: Array.from(document.querySelectorAll<HTMLElement>(".test-area__row-main")).map((main) => main.children.length),
    };
  });

  expect(geometry.headerSeam).toBeCloseTo(0, 0);
  expect(geometry.areaBorderTop).toBe("0px");
  expect(geometry.formGaps.length).toBeGreaterThan(5);
  for (const gap of geometry.formGaps) expect(gap).toBeCloseTo(8, 0);
  expect(new Set(geometry.heights)).toEqual(new Set([30]));
  expect(geometry.badgeLabelText).toBe("Abzeichen");
  expect(geometry.badgeLabelBottom).not.toBeNull();
  expect(geometry.badgeOptionTop).not.toBeNull();
  expect((geometry.badgeOptionTop ?? 0) - (geometry.badgeLabelBottom ?? 0)).toBeGreaterThanOrEqual(3);
  expect(geometry.gameInputBorder).toBe("1px");
  expect(geometry.gameValueBorder).toBe("0px");
  expect(geometry.missingArtCount).toBe(0);
  expect(geometry.roleBorder).toBe("1px");
  expect(geometry.roleBorderStyle).toBe("solid");
  expect(geometry.badgeFill).not.toBe("rgba(0, 0, 0, 0)");
  expect(new Set(geometry.resultHeights)).toEqual(new Set([62]));
  expect(geometry.resultMainLineCounts).toEqual([2, 2]);

  await expect(page.getByText("1 reagiert · 1 blockiert")).toBeVisible();
  const explanation = page.locator(".test-area__detail .test-area__match-explanation");
  await expect(explanation).toContainText("Alias „dc“ in der Nachricht !dc hallo");
  await expect(explanation.locator("mark")).toHaveText("dc");
  await expect(explanation.locator(".ui-token-chip")).toHaveCount(0);

  const blockedRow = page.getByRole("button", { name: /Begrüßung/u });
  await expect(blockedRow).not.toContainText("noch 42 s");
  await blockedRow.click();
  await expect(page.locator(".test-area__detail")).toContainText("Abklingzeit pro Person: noch 42 s.");
  await expect(page.locator(".test-area__detail .test-area__match-explanation mark")).toHaveText("hallo");
});

test("keeps the compact desktop context on one field rhythm at 1280 by 800", async ({ page }) => {
  await openTestArea(page, 1280, 800);

  const gaps = await page.locator(".test-area__context-form").evaluate((form) => {
    const children = Array.from(form.children);
    return children.slice(1).map((child, index) => {
      const previous = children[index];
      return previous === undefined ? 0 : child.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
  });
  expect(gaps.length).toBeGreaterThan(5);
  for (const gap of gaps) expect(gap).toBeCloseTo(8, 0);
});

test("keeps the mobile main screen compact and free of horizontal scroll", async ({ page }) => {
  await openTestArea(page, 390, 844);
  await submitProbe(page);

  await expect(page.locator(".page-header__icon")).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prüfen", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ändern" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verlauf" })).toBeVisible();
  await expect(page.locator(".test-area__mobile-context-copy")).toContainText("viewer_42");
  await expect(page.locator(".test-area__mobile-context-copy")).toContainText("Sub");
  await expect(page.locator(".test-area__mobile-context-copy")).toContainText("Live");
  await expect(page.locator(".test-area__mobile-context-copy")).toContainText("Just Chatting");
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();

  const dimensions = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  const controls = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".test-area__mobile-message .ui-field__control input");
    const button = document.querySelector<HTMLElement>(".test-area__mobile-message .test-area__run-button");
    if (input === null || button === null) return null;
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      inputCenter: inputRect.top + inputRect.height / 2,
      buttonCenter: buttonRect.top + buttonRect.height / 2,
      inputTop: inputRect.top,
      buttonTop: buttonRect.top,
    };
  });
  expect(controls).not.toBeNull();
  expect(Math.abs((controls?.inputCenter ?? 0) - (controls?.buttonCenter ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((controls?.inputTop ?? 0) - (controls?.buttonTop ?? 0))).toBeLessThanOrEqual(1);
});

test("closing the mobile context dialog keeps the edited fields", async ({ page }) => {
  await openTestArea(page, 390, 844);
  await page.getByRole("button", { name: "Ändern" }).click();
  const dialog = page.getByRole("dialog", { name: "Kontext" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(680);
  await dialog.getByRole("textbox", { name: "Absender" }).fill("viewer_99");
  await dialog.locator(".ui-dialog__close").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".test-area__mobile-context-copy")).toContainText("viewer_99");

  await page.getByRole("button", { name: "Ändern" }).click();
  await expect(page.getByRole("dialog", { name: "Kontext" }).getByRole("textbox", { name: "Absender" })).toHaveValue("viewer_99");
});
