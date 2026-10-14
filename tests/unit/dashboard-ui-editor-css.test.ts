import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(path.resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");

describe("editor seam styles", () => {
  it("uses the editor container threshold for FieldPair without viewport JavaScript", () => {
    expect(styles).toMatch(/@container editor \(min-width: 380px\)\s*\{\s*\.ui-field-pair\s*\{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/u);
    expect(styles).toMatch(/\.ui-field-pair \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
  });

  it("keeps template text field geometry and token decoration metrics aligned", () => {
    const geometry = styles.match(/\.template-text-field \.template-text-field__input\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(geometry).toContain("font-size: 14px;");
    expect(geometry).toContain("line-height: 1.5;");
    expect(geometry).toContain("padding: var(--s3) var(--s3) var(--s2);");
    expect(styles).not.toContain("template-text-field__mirror");
    expect(styles).not.toContain("data-highlight-ready");
    const module = styles.match(/\.template-text-field__decoration--module\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(module).toContain("color: var(--brand-text);");
    expect(module).toContain("background: var(--tint-1);");
    expect(module).not.toMatch(/padding|border|letter-spacing|font(?:-family|-size|-weight)?\s*:/u);
    const unknown = styles.match(/\.template-text-field__decoration--unknown\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(unknown).toContain("text-decoration: underline wavy var(--warn);");
    expect(unknown).not.toMatch(/padding|border|letter-spacing|font(?:-family|-size|-weight)?\s*:/u);
  });

  it("keeps unit inputs and confirmation actions readable at narrow widths", () => {
    expect(styles).toContain(".unit-input__control { position: relative; min-width: 0; }");
    expect(styles).toContain(".unit-input__input { padding-right: 4rem; font-family: \"IBM Plex Mono\", ui-monospace, monospace; }");
    expect(styles).toContain(".unit-input__unit { position: absolute; top: 0; right: 10px;");
    expect(styles).toContain(".ui-field__input--with-leading:not(.ui-field__input--with-prefix) { padding-left: 34px; }");
    expect(styles).toContain(".ui-field__leading--prefix { position: static; display: flex; flex: 0 0 auto; width: auto; padding: 0 8px; }");
    expect(styles).toContain(".ui-field__input--with-prefix { flex: 1 1 0%; width: auto; min-width: 0; padding-left: 0; }");
    expect(styles).toContain(".ui-confirm-dialog__actions { display: flex; flex-wrap: wrap;");
    expect(styles).toContain("@media (max-width: 600px)");
    expect(styles).toContain(".ui-confirm-dialog__actions { flex-direction: column; align-items: stretch; }");
    expect(styles).toContain(".ui-editor-shell { display: flex; height: max-content; flex-direction: column;");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain(".ui-editor-shell__body { flex: 1 1 auto; min-height: 0; overflow: auto;");
    expect(styles).toContain(".ui-save-bar { box-sizing: border-box; display: grid; grid-template-columns: minmax(0, 1fr) auto;");
    expect(styles).toContain(".ui-save-bar__invalid-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
  });

  it("applies the shared hand-drawn SVG stroke family to command palette module icons", () => {
    expect(styles).toMatch(/\.module-glyph \{[^}]*fill: none; stroke: currentColor; stroke-width: 1\.5; stroke-linecap: round; stroke-linejoin: round;/u);
    expect(styles).toContain(".command-palette-module-icon { width: 20px; height: 20px; }");
  });
});
