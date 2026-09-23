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
    expect(styles).toContain("color: CanvasText !important;");
    expect(styles).toMatch(/\.template-field__input, \.template-field textarea, \.template-field \.mantine-Input-input \{[^}]*position: relative; z-index: 2;/u);
    expect(styles).toContain("background: transparent !important; box-shadow: none !important;");
    expect(styles).toContain("color: transparent !important; -webkit-text-fill-color: transparent !important;");
    expect(styles).toContain("color: var(--text) !important; -webkit-text-fill-color: var(--text) !important;");
    expect(styles).toContain("border: 0 !important;");
  });

  it("keeps stepped number fields in one row and confirmation actions readable at narrow widths", () => {
    expect(styles).toContain(".ui-number-field__stepper { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; grid-template-rows: auto 44px auto auto;");
    expect(styles).toContain(".ui-number-field__stepper .mantine-NumberInput-input { padding-right: calc(var(--input-right-section-width) + var(--input-padding)); text-align: left;");
    expect(styles).toContain(".ui-number-field__stepper .mantine-InputWrapper-description { grid-column: 1 / -1; grid-row: 3;");
    expect(styles).toContain(".ui-field--prefixed input.mantine-Input-input.mantine-TextInput-input { padding-left: calc(var(--input-left-section-width) + var(--input-padding)); }");
    expect(styles).toContain(".ui-confirm-dialog__actions { display: flex; flex-wrap: wrap;");
    expect(styles).toContain("@media (max-width: 600px)");
    expect(styles).toContain(".ui-confirm-dialog__actions { flex-direction: column; align-items: stretch; }");
    expect(styles).toContain(".ui-editor-shell { display: flex; height: max-content; flex-direction: column;");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain(".ui-editor-shell__body { flex: 1 1 auto; min-height: 0; overflow: auto;");
    expect(styles).toContain(".ui-save-bar__footer { grid-row: 2; grid-column: 1 / -1; justify-self: start; }");
    expect(styles).toContain(".ui-save-bar__actions { grid-row: 3; grid-column: 1 / -1; justify-content: flex-end; }");
  });

  it("applies the shared hand-drawn SVG stroke family to Spotlight module icons", () => {
    expect(styles).toMatch(/\.module-glyph \{[^}]*fill: none; stroke: currentColor; stroke-width: 1\.5; stroke-linecap: round; stroke-linejoin: round;/u);
    expect(styles).toContain(".spotlight-module-icon { width: 20px; height: 20px; }");
  });
});
