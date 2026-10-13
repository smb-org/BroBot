import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { Button, FormDensity, UiProvider } from "../../src/dashboard/ui";
import { colors, createDashboardTheme, luminanceThreshold } from "../../src/dashboard/ui/theme";

// Mirrors Mantine's own `luminance()`/`isLightColor()` (see
// @mantine/core/esm/core/MantineProvider/color-functions/luminance) so this
// test proves the threshold's effect with the same formula Mantine uses at
// runtime, not a hand-waved approximation.
function gammaCorrect(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = gammaCorrect(parseInt(value.slice(0, 2), 16) / 255);
  const g = gammaCorrect(parseInt(value.slice(2, 4), 16) / 255);
  const b = gammaCorrect(parseInt(value.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const WCAG_AA_NORMAL_TEXT = 4.5;
const legacyStyles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");
const tokenStyles = readFileSync(resolve(process.cwd(), "src/dashboard/ui/tokens.css"), "utf8");
const designDocument = readFileSync(resolve(process.cwd(), "DESIGN.md"), "utf8");

type PaletteName = "nachtschicht" | "indigo-nacht";

function paletteTokens(palette: PaletteName): Map<string, string> {
  const selector = palette === "nachtschicht"
    ? /:root\[data-palette="nachtschicht"\],\s*:root:not\(\[data-palette\]\)\s*\{([^}]*)\}/u
    : /:root\[data-palette="indigo-nacht"\]\s*\{([^}]*)\}/u;
  const declarations = selector.exec(tokenStyles)?.[1];
  if (declarations === undefined) throw new Error(`Missing token block for ${palette}`);
  return new Map(Array.from(declarations.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/giu), ([, name, value]) => [name ?? "", value ?? ""]));
}

function resolveLegacyColor(variable: string): string {
  const value = new RegExp(`${variable}:\\s*([^;]+)`).exec(legacyStyles)?.[1]?.trim();
  if (value === undefined) throw new Error(`Missing color token ${variable}`);
  const reference = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
  if (reference !== undefined) return resolveLegacyColor(reference);
  if (!/^#[\da-fA-F]{6}$/u.test(value)) throw new Error(`Color token ${variable} must resolve to a six-digit hex value`);
  return value;
}

const theme = createDashboardTheme(resolveLegacyColor);

interface ComponentThemeValues {
  vars?: (theme: unknown, props: { size: string; color?: string; variant?: string }, context: unknown) => { root?: Record<string, string>; wrapper?: Record<string, string> };
  styles?: Record<string, Record<string, string | number>>;
}

const componentValues = theme.components as unknown as Record<string, ComponentThemeValues>;
const mantinePaletteColors = theme.colors as unknown as Record<string, readonly string[]>;

describe("theme contrast rule", () => {
  it("keeps luminanceThreshold at 0.2, not Mantine's 0.3 default", () => {
    // Not a stray override: see "Die Kontrastregel" in theme.ts and
    // docs/input/DESIGN-neu.md. Raising this back to 0.3 silently breaks
    // every primary button's contrast -- the next two assertions show why.
    expect(luminanceThreshold).toBe(0.2);
    expect(theme.luminanceThreshold).toBe(0.2);
  });

  it("places {colors.brand}'s luminance between 0.2 and 0.3, where the threshold choice flips the outcome", () => {
    expect(colors.brand).toBe("var(--brand)");
    const brandLuminance = relativeLuminance(resolveLegacyColor("--brand"));
    expect(brandLuminance).toBeGreaterThan(0.2);
    expect(brandLuminance).toBeLessThan(0.3);
  });

  it("counter-probe: Mantine's default 0.3 threshold would put white text on brand and fail WCAG AA", () => {
    const brandColor = resolveLegacyColor("--brand");
    const brandLuminance = relativeLuminance(brandColor);
    const defaultThreshold = 0.3;

    // Mantine's isLightColor: `luminance(color) > threshold`. Below the
    // default 0.3 threshold, brand reads as "not light" and autoContrast
    // picks white text.
    const isLightUnderDefault = brandLuminance > defaultThreshold;
    expect(isLightUnderDefault).toBe(false);

    const whiteOnBrand = contrastRatio("#ffffff", brandColor);
    expect(whiteOnBrand).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  it("at the configured 0.2 threshold, brand reads as light and autoContrast picks the dark on-brand text, which passes AA", () => {
    const brandColor = resolveLegacyColor("--brand");
    const onBrandColor = resolveLegacyColor("--on-brand");
    const brandLuminance = relativeLuminance(brandColor);
    const isLightUnderConfiguredThreshold = brandLuminance > luminanceThreshold;
    expect(isLightUnderConfiguredThreshold).toBe(true);

    // theme.black backs autoContrast's dark-text branch; it must be
    // onBrand from the active palette, not Mantine's default pure black, so
    // the button text matches the contrast value defined by the design.
    expect(theme.black).toBe(onBrandColor);

    const onBrandOnBrand = contrastRatio(onBrandColor, brandColor);
    expect(onBrandOnBrand).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it("passes resolved palette colors to Mantine so every color consumer keeps auto-contrast", () => {
    for (const paletteName of ["dark", "brand"] as const) {
      const palette = mantinePaletteColors[paletteName];
      expect(palette, `Mantine must define ${paletteName}`).toBeDefined();
      for (const color of palette ?? []) {
        expect(color, `${paletteName} entries must be resolved colors`).not.toMatch(/^var\(/u);
      }
    }

    const primaryFill = mantinePaletteColors.brand?.[6] ?? "";
    const primaryLuminance = primaryFill.startsWith("var(") ? 0 : relativeLuminance(primaryFill);
    expect(primaryLuminance).toBeGreaterThan(luminanceThreshold);
    expect(theme.black).toBe(resolveLegacyColor("--on-brand"));
  });
});

describe("design token documentation", () => {
  it("maps the 13px label and section title row to the 13px section token", () => {
    expect(designDocument).toMatch(/\| Label \/ Abschnittstitel \| 13px \/ 500 in `--color-text` \(Abschnitt: 600\) \| `--text-field-label`, `--text-section` \|/u);
  });
});

describe("palette contrast tokens", () => {
  it("defines the unset overlay content color separately from error contrast", () => {
    expect(tokenStyles).toContain("--content-default: #ffffff;");
    expect(tokenStyles).toContain("--color-on-error: #000000;");
  });

  it.each(["nachtschicht", "indigo-nacht"] as const)("keeps every documented filled-control pair AA compliant in %s", (palette) => {
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

describe("legacy dashboard CSS compatibility", () => {
  it("keeps the generic font reset away from Mantine controls", () => {
    expect(tokenStyles).toContain('@import "../styles.css";');
    expect(tokenStyles).not.toContain('@import "../styles.css" layer(');
    for (const control of ["button", "select", "input", "textarea"]) {
      expect(legacyStyles).toContain(`${control}:not([class*="mantine-"])`);
    }
  });

  it("leaves legacy surface variables owned by styles.css", () => {
    const legacySurfaceTokens = [
      "--background", "--rail", "--surface-raised", "--surface", "--surface-hover",
      "--surface-inspector", "--surface-well", "--surface-depth", "--line", "--line-strong", "--line-light",
    ];
    for (const token of legacySurfaceTokens) {
      expect(legacyStyles).toMatch(new RegExp(`${token}:\\s*[^;]+;`, "u"));
      expect(tokenStyles).not.toMatch(new RegExp(`(?:^|\\s)${token}:`, "u"));
    }
    expect(legacyStyles).toContain("--background: #141312;");
  });
});

describe("form density size step", () => {
  it("uses 14px and 44px for md inputs while compact-md stays 13px and 34px", () => {
    const inputVars = componentValues.Input?.vars?.(theme, { size: "md" }, {});
    const compactInputVars = componentValues.Input?.vars?.(theme, { size: "compact-md" }, {});
    expect(inputVars?.wrapper).toMatchObject({
      "--input-fz": "14px",
      "--input-padding": "12px",
      "--input-padding-y-md": "10px",
      "--input-height-md": "44px",
      "--input-height-compact-md": "34px",
    });
    expect(compactInputVars?.wrapper?.["--input-fz"]).toBe("13px");
    expect(componentValues.InputWrapper?.styles).toMatchObject({
      label: { fontSize: "13px", fontWeight: 500 },
      description: { fontSize: "12px" },
      error: { fontSize: "12px" },
    });
  });

  it("keeps button text at 13px by default and marks buttons inside FormDensity", () => {
    const { container } = render(
      createElement(
        UiProvider,
        null,
        createElement(Button, null, "Outside"),
        createElement(Button, { variant: "primary", iconOnly: false, children: "Primary" }),
        createElement(FormDensity.Provider, { value: "form" }, createElement(Button, null, "Inside")),
      ),
    );
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));

    expect(buttons[0]).toHaveClass("text-[13px]");
    expect(screen.getByRole("button", { name: "Primary" })).toHaveAttribute("data-variant", "primary");
    expect(screen.getByRole("button", { name: "Inside" })).toHaveClass("ui-button--form-density");
  });
});
