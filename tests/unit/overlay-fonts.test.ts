import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (file: string): string => readFileSync(path.resolve(process.cwd(), file), "utf8");
const sharedFontCssPath = path.resolve(process.cwd(), "src/fonts.css");
const sharedFontCss = existsSync(sharedFontCssPath) ? readFileSync(sharedFontCssPath, "utf8") : "";

describe("shared overlay fonts", () => {
  it("loads the same Archivo and IBM Plex Mono faces in the dashboard and overlay entries", () => {
    const overlayEntry = projectFile("src/overlay/main.tsx");
    const dashboardStyles = projectFile("src/dashboard/ui/core.css");

    expect(overlayEntry).toContain('import "../fonts.css";');
    expect(dashboardStyles).toContain('@import "../../fonts.css";');
    expect(dashboardStyles).not.toContain("@font-face");
    expect(sharedFontCss.match(/@font-face/gu)).toHaveLength(2);
    expect(sharedFontCss).toContain('font-family: Archivo;');
    expect(sharedFontCss).toContain('font-family: "IBM Plex Mono";');
    expect(sharedFontCss).toContain('url("./dashboard/fonts/archivo-latin.woff2")');
    expect(sharedFontCss).toContain('url("./dashboard/fonts/plexmono-400-latin.woff2")');
  });

  it("loads the shared fonts into the isolated overlay editor preview document", () => {
    const editorSource = projectFile("src/dashboard/OverlayEditorPage.tsx");

    expect(editorSource).toContain('import("../fonts.css?inline")');
    expect(editorSource).toContain('"data-brobot-overlay-fonts-css"');
  });
});
