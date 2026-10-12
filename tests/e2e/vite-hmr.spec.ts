import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

test("React Fast Refresh preserves module component state after an edit", async ({ page }) => {
  const counterPath = join(process.cwd(), "tests/e2e/vite-hmr-counter.tsx");
  const originalSource = await readFile(counterPath, "utf8");
  const updatedSource = originalSource.replace("Count {count}", "Clicks {count}");
  expect(updatedSource).not.toBe(originalSource);

  try {
    await page.goto("/tests/e2e/vite-hmr-fixture.html");
    const counter = page.getByRole("button");
    await expect(counter).toHaveText("Count 0");
    await counter.click();
    await expect(counter).toHaveText("Count 1");

    await writeFile(counterPath, updatedSource);
    await expect(counter).toHaveText("Clicks 1", { timeout: 10_000 });
  } finally {
    await writeFile(counterPath, originalSource);
  }
});
