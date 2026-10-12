import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(import.meta.dirname, "../../src");

const catalogueFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return catalogueFiles(filePath);
    return /(?:locale(?:-[^/]*)?|labels|module-labels)\.ts$/u.test(entry.name) ? [filePath] : [];
  })
  .sort((left, right) => left.localeCompare(right));

describe("unused locale keys", () => {
  it("removes labels for controls replaced by unit inputs and chips", () => {
    const catalogues = catalogueFiles(srcRoot);
    expect(catalogues.length).toBeGreaterThan(0);

    const staleKeys = ["increaseLabel", "decreaseLabel", "tagInputMessages"];
    const matches = catalogues.flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return staleKeys
        .filter((key) => new RegExp(`\\b${key}\\s*:`, "u").test(source))
        .map((key) => `${path.relative(srcRoot, filePath)}:${key}`);
    });

    expect(matches).toEqual([]);
  });
});
