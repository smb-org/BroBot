import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(path.resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");

describe("editor seam styles", () => {
  it("uses the editor container threshold for FieldPair without viewport JavaScript", () => {
    expect(styles).toMatch(/@container editor \(min-width: 380px\)\s*\{\s*\.ui-field-pair\s*\{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/u);
    expect(styles).toMatch(/\.ui-field-pair \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
  });

  it("keeps the text mirror and textarea geometry shared, with fonts and forced-colors fallbacks", () => {
    const geometry = styles.match(/\.template-field__mirror, \.template-field__input\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(geometry).toContain("font-size: 14px;");
    expect(geometry).toContain("line-height: 1.5;");
    expect(geometry).toContain("padding: 10px 12px;");
    expect(styles).toContain(".template-field[data-highlight-ready=\"false\"] .template-field__mirror { visibility: hidden; }");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain(".template-field[data-highlight-ready=\"true\"] .template-field__mirror { display: none; }");
    expect(styles).toContain("color: CanvasText;");
  });

  it("applies the shared hand-drawn SVG stroke family to Spotlight module icons", () => {
    expect(styles).toMatch(/\.module-glyph \{[^}]*fill: none; stroke: currentColor; stroke-width: 1\.5; stroke-linecap: round; stroke-linejoin: round;/u);
    expect(styles).toContain(".spotlight-module-icon { width: 20px; height: 20px; }");
  });
});
