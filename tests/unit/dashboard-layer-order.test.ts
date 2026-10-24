// @vitest-environment node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const builtClientDirectory = path.join(projectRoot, "dist/client");
const builtDashboardHtmlPath = path.join(builtClientDirectory, "index.html");
const hasBuiltDashboard = existsSync(builtDashboardHtmlPath);
// CI sets REQUIRE_BUILT_DASHBOARD=1 so a missing build fails instead of falling back or skipping.
if (process.env.REQUIRE_BUILT_DASHBOARD === "1" && !hasBuiltDashboard) {
  throw new Error(`REQUIRE_BUILT_DASHBOARD=1 but ${builtDashboardHtmlPath} is missing; run "pnpm run build" first.`);
}
const dashboardHtml = readFileSync(
  hasBuiltDashboard ? builtDashboardHtmlPath : path.join(projectRoot, "index.html"),
  "utf8",
);
const tokensCss = readFileSync(path.join(projectRoot, "src/dashboard/ui/tokens.css"), "utf8");
const layerOrderStatements = [
  "@layer theme, base, utilities, components;",
  "@layer components.base, components.kit, components.pages, components.modules;",
];

const readCssFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return readCssFiles(entryPath);
  return entry.isFile() && entry.name.endsWith(".css") ? [readFileSync(entryPath, "utf8")] : [];
});

describe("built dashboard cascade layers", () => {
  it("declares the cascade order in the first inline style before linked stylesheets", () => {
    const firstStyle = dashboardHtml.match(/<style\b[^>]*>([\s\S]*?)<\/style>/iu);
    const firstStyleText = firstStyle?.[1]?.replace(/\s+/gu, " ").trim() ?? "";
    const stylesheetIndex = dashboardHtml.search(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/iu);
    const scriptIndex = dashboardHtml.search(/<script\b/iu);
    const firstResourceIndex = [stylesheetIndex, scriptIndex]
      .filter((index) => index >= 0)
      .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);

    expect(firstStyleText).toBe(layerOrderStatements.join(" "));
    expect(firstResourceIndex).toBeGreaterThan(0);
    expect(dashboardHtml.indexOf(firstStyle?.[0] ?? "")).toBeLessThan(firstResourceIndex);
    if (hasBuiltDashboard) expect(stylesheetIndex).toBeGreaterThan(0);
  });

  it("keeps the layer order statements in tokens.css identical to index.html", () => {
    const sourceHtml = readFileSync(path.join(projectRoot, "index.html"), "utf8");
    const statementsIn = (text: string) => text.match(/@layer [^;{]+;/gu)?.slice(0, 2).map((s) => s.replace(/\s+/gu, " ")) ?? [];

    expect(statementsIn(tokensCss)).toEqual(layerOrderStatements);
    expect(statementsIn(sourceHtml)).toEqual(layerOrderStatements);
  });

  it.skipIf(!hasBuiltDashboard)("emits dashboard kit styles in the built CSS assets", () => {
    const cssFiles = readCssFiles(builtClientDirectory);

    expect(cssFiles.length).toBeGreaterThan(0);
    expect(cssFiles.some((css) => css.includes("@layer components.kit"))).toBe(true);
  });
});
