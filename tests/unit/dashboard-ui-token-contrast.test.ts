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
