import { expect, test, type Page } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

const channelId = "kanal-541-layout";
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
// The optional third value forces the results column to that border-box width. The narrowest real column (821px) is
// about 256px wide; 258px leaves a 226px content box, the narrowest case a review found, so it stays safe below that.
const viewports: readonly (readonly [number, number, number?])[] = [[390, 844], [821, 800], [821, 800, 258], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];

const entry = (id: string, outcome: "fires" | "blocked" | "indeterminate") => ({
  moduleId: "text_commands",
  entry: { kind: "text_command", id, label: `!${id}` },
  outcome,
  match: { kind: "alias", token: id },
  blocks: outcome === "blocked" ? [{ code: "text_commands.person_cooldown", detail: { remainingSeconds: 42 } }] : [],
  effects: outcome === "fires" ? [{ kind: "chat", text: "Hallo", target: "source_only", postsTo: "this_chat", reply: true, suppressedBy: null, automated: true }] : [],
  templateNotes: [],
});
interface Counts { fires: number; blocked: number; indeterminate: number }
const shortCounts: Counts = { fires: 1, blocked: 1, indeterminate: 1 };
// Multi-digit counts in every part make the longest realistic summary, which wraps in a narrow column.
const longCounts: Counts = { fires: 12, blocked: 10, indeterminate: 11 };
const mixed = (controls: { muted: boolean; paused: boolean }, counts: Counts = shortCounts) => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls,
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [{
    moduleId: "text_commands",
    status: "reacts",
    entries: [
      ...Array.from({ length: counts.fires }, (_, index) => entry(`ok${String(index)}`, "fires")),
      ...Array.from({ length: counts.blocked }, (_, index) => entry(`bl${String(index)}`, "blocked")),
      ...Array.from({ length: counts.indeterminate }, (_, index) => entry(`un${String(index)}`, "indeterminate")),
    ],
  }],
});
const total = (counts: Counts): number => counts.fires + counts.blocked + counts.indeterminate;

const rect = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`No box for ${selector}`);
  return box;
};

for (const [locale, label] of [["de-DE", "German"], ["en-US", "English"]] as const) {
  test.describe(`test area result header (${label})`, () => {
    test.use({ locale });

    for (const [width, height, forcedColumn] of viewports) {
      test(`the summary is fully readable in its own row and nothing moves through badges, loading and a long summary at ${String(width)}px${forcedColumn === undefined ? "" : ` with a ${String(forcedColumn)}px results column`}`, async ({ page }) => {
        let controls = { muted: false, paused: false };
        let counts = shortCounts;
        let gate: Promise<void> | null = null;
        await installLiveCockpitMocks(page, { channelId, role: "manager", streamState: "online", modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
        await page.route(`**/api/channels/${channelId}/dry-run`, async (route) => {
          if (gate !== null) await gate;
          await route.fulfill(json(mixed(controls, counts)));
        });
        await page.setViewportSize({ width, height });
        await page.goto(`/channels/${channelId}/test-area`);
        if (forcedColumn !== undefined) await page.addStyleTag({ content: `.test-area__results { box-sizing: border-box; width: ${String(forcedColumn)}px; justify-self: start; }` });
        const input = page.getByRole("textbox", { name: /^(Nachricht|Message)$/u });
        await expect(input).toBeVisible();
        const run = async (text: string): Promise<void> => {
          await input.fill(text);
          await page.locator(".test-area__run-button:visible").click();
          await expect(page.locator(".test-area__result-row")).toHaveCount(total(counts));
          await expect(page.getByTestId("test-area-results-slot")).toHaveAttribute("aria-busy", "false");
          await waitForWebFonts(page);
        };
        const measure = async () => {
          const [head, title, heading, summary, row] = await Promise.all([
            rect(page, ".test-area__results-head"),
            rect(page, ".test-area__results-title"),
            rect(page, ".test-area__results-title h2"),
            rect(page, ".test-area__results-summary"),
            rect(page, ".test-area__result-row"),
          ]);
          return { head, title, heading, summary, row };
        };
        // Title, badges and the loading label never overlap each other and never leave the title copy.
        const expectCopyIntact = async (state: string): Promise<void> => {
          const problems = await page.locator(".test-area__results-title-copy").evaluate((copy) => {
            const copyBox = copy.getBoundingClientRect();
            const children = [...copy.children].filter((child) => child.getBoundingClientRect().width > 0);
            const found: string[] = [];
            for (const [index, child] of children.entries()) {
              const box = child.getBoundingClientRect();
              if (box.right > copyBox.right + 0.5 || box.bottom > copyBox.bottom + 0.5 || (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth + 0.5) found.push(`clipped: ${child.textContent}`);
              for (const other of children.slice(index + 1)) {
                const otherBox = other.getBoundingClientRect();
                if (box.left < otherBox.right - 0.5 && otherBox.left < box.right - 0.5 && box.top < otherBox.bottom - 0.5 && otherBox.top < box.bottom - 0.5) found.push(`overlap: ${child.textContent} / ${other.textContent}`);
              }
            }
            return found;
          });
          expect(problems, `title copy ${state}`).toEqual([]);
        };

        await run("!eins");
        const plain = await measure();
        // The title row is fixed (one line, or two reserved lines in a narrow column); the summary has its own full-width row below it.
        const titleRow = await page.locator(".test-area__results-title").evaluate((title) => Number.parseFloat(getComputedStyle(title).gridTemplateRows.split(" ")[0] ?? "0"));
        expect(plain.row.y - (plain.head.y + plain.head.height), "gap between header and first row").toBeLessThanOrEqual(16);
        expect(plain.head.height, "header height follows the summary").toBeLessThanOrEqual(titleRow + plain.summary.height + 16);
        expect(plain.summary.width, "summary spans the header").toBeGreaterThanOrEqual(plain.title.width - 1);
        const clipped = await page.locator(".test-area__results-summary").evaluate((element) => ({
          overflow: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow === "ellipsis" && element.scrollWidth > element.clientWidth,
        }));
        expect(clipped, "summary is neither clipped nor ellipsized").toEqual({ overflow: false, ellipsis: false });
        await expectCopyIntact("without badges");

        controls = { muted: true, paused: true };
        await run("!eins ");
        await expect(page.locator(".test-area__results-title-copy .ui-badge")).toHaveCount(2);
        const badges = await measure();
        await expectCopyIntact("with badges");

        // Rerun with both badges while the response is held back, so the loading label shows next to them.
        let release = (): void => undefined;
        gate = new Promise<void>((resolve) => { release = resolve; });
        await input.fill("!eins  ");
        await page.locator(".test-area__run-button:visible").click();
        await expect(page.locator(".test-area__loading-label")).toBeVisible();
        await expect(page.locator(".test-area__results-title-copy .ui-badge")).toHaveCount(2);
        await waitForWebFonts(page);
        const loading = await measure();
        await expectCopyIntact("while loading");
        release();
        gate = null;
        await expect(page.locator(".test-area__loading-label")).toBeHidden();

        // A summary that wraps in a narrow column must not move the rows either: short, long, short again.
        counts = longCounts;
        await run("!eins   ");
        const long = await measure();
        await expectCopyIntact("with a long summary");
        const longSummary = await page.locator(".test-area__results-summary").evaluate((element) => ({ overflow: element.scrollWidth > element.clientWidth, text: element.textContent }));
        expect(longSummary.overflow, `summary ${longSummary.text} is not clipped`).toBe(false);
        counts = shortCounts;
        await run("!eins    ");
        const shortAgain = await measure();

        for (const [state, other] of [["badges", badges], ["loading", loading], ["long summary", long], ["short summary again", shortAgain]] as const) {
          expect(Math.abs(other.head.height - plain.head.height), `header height with ${state}`).toBeLessThanOrEqual(1);
          expect(Math.abs(other.heading.y - plain.heading.y), `heading position with ${state}`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(other.summary.y - plain.summary.y), `summary position with ${state}`).toBeLessThanOrEqual(1);
          expect(Math.abs(other.row.y - plain.row.y), `first row position with ${state}`).toBeLessThanOrEqual(1);
        }
      });
    }
  });
}
