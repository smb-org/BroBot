import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

type RestrictedImportPattern = { regex?: string };
type RestrictedImportsRule = [number, { patterns?: RestrictedImportPattern[] }];
type CalculatedConfig = { rules?: Record<string, unknown> };

const eslint = new ESLint({ cwd: process.cwd() });

const restrictedPatternsFor = async (filePath: string): Promise<RegExp[]> => {
  const config = await eslint.calculateConfigForFile(filePath) as unknown as CalculatedConfig;
  const rule = config.rules?.["no-restricted-imports"] as RestrictedImportsRule | undefined;
  if (rule === undefined) throw new Error(`Keine no-restricted-imports-Regel für ${filePath}`);
  return (rule[1].patterns ?? [])
    .flatMap((pattern) => pattern.regex === undefined ? [] : [new RegExp(pattern.regex)]);
};

const rejects = (patterns: RegExp[], importPath: string): boolean =>
  patterns.some((pattern) => pattern.test(importPath));

describe("effective ESLint module boundaries", () => {
  it("keeps the overlay boundaries effective, including service.js and worker code", async () => {
    const patterns = await restrictedPatternsFor("src/modules/example/overlay/view.tsx");

    expect(rejects(patterns, "../service.js")).toBe(true);
    expect(rejects(patterns, "../../worker/config")).toBe(true);
    expect(rejects(patterns, "zod")).toBe(true);
  });

  it("keeps the panel boundaries and module isolation effective", async () => {
    const patterns = await restrictedPatternsFor("src/modules/example/panel/view.tsx");

    expect(rejects(patterns, "../worker/config")).toBe(true);
    expect(rejects(patterns, "../repository.js")).toBe(true);
    expect(rejects(patterns, "../overlay/view")).toBe(true);
    expect(rejects(patterns, "../../other-module/contract")).toBe(true);
    expect(rejects(patterns, "../service.js")).toBe(false);
  });
});
