import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokenStyles = readFileSync(resolve(process.cwd(), "src/dashboard/ui/tokens.css"), "utf8");
const WCAG_AA_NORMAL_TEXT = 4.5;

type PaletteName = "nachtschicht" | "indigo-nacht";

function paletteTokens(palette: PaletteName): Map<string, string> {
  const selector = palette === "nachtschicht"
    ? /:root\[data-palette="nachtschicht"\],\s*:root:not\(\[data-palette\]\)\s*\{([^}]*)\}/u
    : /:root\[data-palette="indigo-nacht"\]\s*\{([^}]*)\}/u;
  const declarations = selector.exec(tokenStyles)?.[1];
  if (declarations === undefined) throw new Error(`Missing token block for ${palette}`);
  return new Map(Array.from(declarations.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/giu), ([, name, value]) => [name ?? "", value ?? ""]));
}

function gammaCorrect(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const red = gammaCorrect(Number.parseInt(value.slice(0, 2), 16) / 255);
  const green = gammaCorrect(Number.parseInt(value.slice(2, 4), 16) / 255);
  const blue = gammaCorrect(Number.parseInt(value.slice(4, 6), 16) / 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function sharedPaletteTokens(): Map<string, string> {
  const selector = /:root\[data-palette="nachtschicht"\],\s*:root\[data-palette="indigo-nacht"\],\s*:root:not\(\[data-palette\]\)\s*\{([^}]*)\}/u;
  const declarations = selector.exec(tokenStyles)?.[1];
  if (declarations === undefined) throw new Error("Missing shared palette token block");
  return new Map(Array.from(declarations.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/giu), ([, name, value]) => [name ?? "", value ?? ""]));
}

function oklchHue(hex: string): number {
  const value = hex.replace("#", "");
  const linear = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const [red, green, blue] = linear as [number, number, number];
  const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
  const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
  const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const a = 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot;
  const b = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot;
  return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
}

describe("filled-control token contrast", () => {
  it.each(["nachtschicht", "indigo-nacht"] as const)("keeps every filled-control foreground at WCAG AA in %s", (palette) => {
    const values = paletteTokens(palette);
    const pairs = [
      { foreground: "--color-brand-on", backgrounds: ["--color-brand", "--color-brand-hover", "--color-brand-press"] },
      { foreground: "--color-on-gold", backgrounds: ["--color-gold", "--color-gold-hover", "--color-gold-press"] },
      { foreground: "--color-orange-on", backgrounds: ["--color-orange"] },
      { foreground: "--color-on-error", backgrounds: ["--color-error"] },
    ];

    for (const { foreground, backgrounds } of pairs) {
      const textColor = values.get(foreground);
      expect(textColor, `${palette} must define ${foreground}`).toBeDefined();
      for (const background of backgrounds) {
        const fillColor = values.get(background);
        expect(fillColor, `${palette} must define ${background}`).toBeDefined();
        expect(
          contrastRatio(textColor ?? "", fillColor ?? ""),
          `${palette}: ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      }
    }
  });
});

describe("games badge tokens", () => {
  it.each(["nachtschicht", "indigo-nacht"] as const)(
    `keeps the games badge readable and distinct in %s (protects=games badge foreground contrast and category hue separation; fails_when=contrast is below 4.5:1 or OKLCH hue distance from the Data badge is below 30 degrees; no_claim=shared badge tokens are repeated for both palettes, but browser rendering is not asserted)`,
    (palette) => {
      const values = sharedPaletteTokens();
      const foreground = values.get("--badge-games");
      const fill = values.get("--badge-games-fill");
      const data = values.get("--badge-data");
      expect(foreground, `${palette} must define --badge-games`).toBeDefined();
      expect(fill, `${palette} must define --badge-games-fill`).toBeDefined();
      expect(data, `${palette} must define --badge-data`).toBeDefined();
      expect(contrastRatio(foreground ?? "", fill ?? ""), `${palette} games foreground on fill`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      const rawDistance = Math.abs(oklchHue(foreground ?? "") - oklchHue(data ?? ""));
      expect(Math.min(rawDistance, 360 - rawDistance), `${palette} games and Data OKLCH hue distance`).toBeGreaterThanOrEqual(30);
    },
  );
});
