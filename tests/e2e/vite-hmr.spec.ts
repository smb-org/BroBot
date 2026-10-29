import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

test("React Fast Refresh preserves module component state after an edit", async ({ page }) => {
  // Must exceed both HMR waits below; the default 30 s test timeout would cut them short.
  test.setTimeout(150_000);
  const counterPath = join(process.cwd(), "tests/e2e/vite-hmr-counter.tsx");
  const originalSource = await readFile(counterPath, "utf8");
  const updatedSource = originalSource.replace("Count {count}", "Clicks {count}");
  expect(updatedSource).not.toBe(originalSource);

  let restored = false;
  try {
    await page.goto("/tests/e2e/vite-hmr-fixture.html");
    const counter = page.getByRole("button");
    await expect(counter).toHaveText("Count 0");
    await counter.click();
    await expect(counter).toHaveText("Count 1");

    // Write until the HMR update shows up (with the count kept). Under CPU load
    // Vite's file watcher is slow and can drop a change that follows another
    // write closely, so a single write plus a long wait is not enough (#623).
    // The timeouts are ceilings, not delays.
    const writeUntilApplied = async (source: string, expectedText: string): Promise<void> => {
      await expect(async () => {
        await writeFile(counterPath, source);
        await expect(counter).toHaveText(expectedText, { timeout: 10_000 });
      }).toPass({ timeout: 60_000 });
    };

    await writeUntilApplied(updatedSource, "Clicks 1");

    // The restore must reach the dev server too; otherwise the next run can load
    // the stale edited module ("Clicks 0") before the watcher caught up.
    await writeUntilApplied(originalSource, "Count 1");
    restored = true;
  } finally {
    if (!restored) await writeFile(counterPath, originalSource);
  }
});
