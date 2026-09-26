import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

type RestrictedImportPattern = { regex?: string; group?: string[] };
type RestrictedImportPath = string | { name?: string };
type RestrictedImportsRule = [number, { paths?: RestrictedImportPath[]; patterns?: RestrictedImportPattern[] }];
type CalculatedConfig = { rules?: Record<string, unknown> };

interface ImportRestrictions {
  paths: string[];
  patterns: RegExp[];
}

const eslint = new ESLint({ cwd: process.cwd() });

const restrictionsFor = async (filePath: string): Promise<ImportRestrictions> => {
  const config = await eslint.calculateConfigForFile(filePath) as unknown as CalculatedConfig;
  const rule = config.rules?.["no-restricted-imports"] as RestrictedImportsRule | undefined;
  return {
    paths: (rule?.[1].paths ?? []).map((path) => typeof path === "string" ? path : path.name ?? ""),
    patterns: (rule?.[1].patterns ?? []).flatMap((pattern) => [
      ...(pattern.regex === undefined ? [] : [new RegExp(pattern.regex)]),
      ...(pattern.group ?? []).map((group) => new RegExp(`^${group.replaceAll("*", ".*")}$`)),
    ]),
  };
};

const rejects = (restrictions: ImportRestrictions, importPath: string): boolean =>
  restrictions.paths.includes(importPath) || restrictions.patterns.some((pattern) => pattern.test(importPath));

describe("effective ESLint module boundaries", () => {
  it("keeps the overlay boundaries effective, including service.js and worker code", async () => {
    const restrictions = await restrictionsFor("src/modules/example/overlay/view.tsx");

    expect(rejects(restrictions, "../service.js")).toBe(true);
    expect(rejects(restrictions, "../../worker/config")).toBe(true);
    expect(rejects(restrictions, "zod")).toBe(true);
  });

  it("blocks static module overlay view imports from the host renderer", async () => {
    const restrictions = await restrictionsFor("src/overlay/canvas.tsx");

    expect(rejects(restrictions, "../modules/ads/overlay/countdown")).toBe(true);
    expect(rejects(restrictions, "../modules/overlay-element-registry")).toBe(false);
  });

  it("keeps the panel boundaries and module isolation effective", async () => {
    const restrictions = await restrictionsFor("src/modules/example/panel/view.tsx");

    expect(rejects(restrictions, "../worker/config")).toBe(true);
    expect(rejects(restrictions, "../repository.js")).toBe(true);
    expect(rejects(restrictions, "../overlay/view")).toBe(true);
    expect(rejects(restrictions, "../../other-module/contract")).toBe(true);
    expect(rejects(restrictions, "../../text_library/contracts")).toBe(false);
    expect(rejects(restrictions, "../../text_library/adapters/d1")).toBe(true);
    expect(rejects(restrictions, "../../contract")).toBe(false);
    expect(rejects(restrictions, "../../contracts/values")).toBe(false);
    expect(rejects(restrictions, "../service.js")).toBe(false);
  });

  it("keeps Tabler imports inside ui/Icon.tsx and out of panels and the overlay", async () => {
    const panelRestrictions = await restrictionsFor("src/modules/example/panel/view.tsx");
    const overlayRestrictions = await restrictionsFor("src/overlay/main.tsx");
    const workerRestrictions = await restrictionsFor("src/worker/index.ts");
    const testRestrictions = await restrictionsFor("tests/example.test.ts");
    const iconRestrictions = await restrictionsFor("src/dashboard/ui/Icon.tsx");

    expect(rejects(panelRestrictions, "@tabler/icons-react")).toBe(true);
    expect(rejects(overlayRestrictions, "@tabler/icons-react")).toBe(true);
    expect(rejects(workerRestrictions, "@tabler/icons-react")).toBe(true);
    expect(rejects(testRestrictions, "@tabler/icons-react")).toBe(true);
    expect(rejects(iconRestrictions, "@tabler/icons-react")).toBe(false);
  });

  it("keeps rich-textarea imports inside the dashboard UI seam", async () => {
    const dashboardRestrictions = await restrictionsFor("src/dashboard/main.tsx");
    const overlayRestrictions = await restrictionsFor("src/overlay/main.tsx");
    const testRestrictions = await restrictionsFor("tests/example.test.ts");
    const uiRestrictions = await restrictionsFor("src/dashboard/ui/TextArea.tsx");

    expect(rejects(dashboardRestrictions, "rich-textarea")).toBe(true);
    expect(rejects(dashboardRestrictions, "rich-textarea/lib/types")).toBe(true);
    expect(rejects(overlayRestrictions, "rich-textarea")).toBe(true);
    expect(rejects(testRestrictions, "rich-textarea")).toBe(true);
    expect(rejects(uiRestrictions, "rich-textarea")).toBe(false);
    expect(rejects(uiRestrictions, "rich-textarea/lib/types")).toBe(false);
  });
});
