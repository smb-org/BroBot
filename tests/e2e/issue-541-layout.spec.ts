import { expect, test, type Page } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

const channelId = "kanal-541-layout";
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
const viewports = [[390, 844], [821, 800], [1024, 768], [1440, 900], [1920, 1080]] as const;

const entry = (id: string, outcome: "fires" | "blocked" | "indeterminate") => ({
  moduleId: "text_commands",
  entry: { kind: "text_command", id, label: `!${id}` },
  outcome,
  match: { kind: "alias", token: id },
  blocks: outcome === "blocked" ? [{ code: "text_commands.person_cooldown", detail: { remainingSeconds: 42 } }] : [],
  effects: outcome === "fires" ? [{ kind: "chat", text: "Hallo", target: "source_only", postsTo: "this_chat", reply: true, suppressedBy: null, automated: true }] : [],
  templateNotes: [],
});
const mixed = (controls: { muted: boolean; paused: boolean }) => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls,
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [{ moduleId: "text_commands", status: "reacts", entries: [entry("eins", "fires"), entry("zwei", "blocked"), entry("drei", "indeterminate")] }],
});

const rect = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`No box for ${selector}`);
  return box;
};

for (const [locale, label] of [["de-DE", "German"], ["en-US", "English"]] as const) {
  test.describe(`test area result header (${label})`, () => {
    test.use({ locale });

    for (const [width, height] of viewports) {
      test(`the summary is fully readable in its own row and nothing moves when Muted and Paused appear at ${String(width)}px`, async ({ page }) => {
        let controls = { muted: false, paused: false };
        await installLiveCockpitMocks(page, { channelId, role: "manager", streamState: "online", modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
        await page.route(`**/api/channels/${channelId}/dry-run`, (route) => route.fulfill(json(mixed(controls))));
        await page.setViewportSize({ width, height });
        await page.goto(`/channels/${channelId}/test-area`);
        const input = page.getByRole("textbox", { name: /^(Nachricht|Message)$/u });
        await expect(input).toBeVisible();
        const run = async (text: string): Promise<void> => {
          await input.fill(text);
          await page.locator(".test-area__run-button:visible").click();
          await expect(page.locator(".test-area__result-row")).toHaveCount(3);
          await waitForWebFonts(page);
        };
        const measure = async () => {
          const [head, title, summary, row] = await Promise.all([
            rect(page, ".test-area__results-head"),
            rect(page, ".test-area__results-title"),
            rect(page, ".test-area__results-summary"),
            rect(page, ".test-area__result-row"),
          ]);
          return { head, title, summary, row };
        };

        // Just above 820px the column is narrow and the badges get a reserved second line.
        const titleRow = width === 821 ? 44 : 24;
        await run("!eins");
        const before = await measure();
        // The summary has its own full-width row: its height follows the text, no oversized reservation above the rows.
        expect(before.row.y - (before.head.y + before.head.height), "gap between header and first row").toBeLessThanOrEqual(16);
        expect(before.head.height, "header height follows the summary").toBeLessThanOrEqual(titleRow + before.summary.height + 16);
        expect(before.summary.width, "summary spans the header").toBeGreaterThanOrEqual(before.title.width - 1);
        const clipped = await page.locator(".test-area__results-summary").evaluate((element) => ({
          overflow: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow === "ellipsis" && element.scrollWidth > element.clientWidth,
        }));
        expect(clipped, "summary is neither clipped nor ellipsized").toEqual({ overflow: false, ellipsis: false });

        controls = { muted: true, paused: true };
        await run("!eins ");
        await expect(page.locator(".test-area__results-title-copy .ui-badge")).toHaveCount(2);
        const after = await measure();
        expect(Math.abs(after.head.height - before.head.height), "header height").toBeLessThanOrEqual(1);
        expect(Math.abs(after.row.y - before.row.y), "first row position").toBeLessThanOrEqual(1);
        expect(Math.abs(after.summary.y - before.summary.y), "summary position").toBeLessThanOrEqual(1);
        const badgesClipped = await page.locator(".test-area__results-title-copy").evaluate((copy) => {
          const copyBox = copy.getBoundingClientRect();
          return [...copy.children].filter((child) => {
            const box = child.getBoundingClientRect();
            return box.width > 0 && (box.right > copyBox.right + 0.5 || box.bottom > copyBox.bottom + 0.5 || (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth + 0.5);
          }).map((child) => child.textContent);
        });
        expect(badgesClipped).toEqual([]);
      });
    }
  });
}
