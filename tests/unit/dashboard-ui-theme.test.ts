import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { Button, FormDensity, UiProvider } from "../../src/dashboard/ui";
import { colors, luminanceThreshold, theme } from "../../src/dashboard/ui/theme";

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

interface ComponentThemeValues {
  vars?: (theme: unknown, props: { size: string }, context: unknown) => { root?: Record<string, string>; wrapper?: Record<string, string> };
  styles?: Record<string, Record<string, string | number>>;
}

const componentValues = theme.components as unknown as Record<string, ComponentThemeValues>;

describe("theme contrast rule", () => {
  it("keeps luminanceThreshold at 0.2, not Mantine's 0.3 default", () => {
    // Not a stray override: see "Die Kontrastregel" in theme.ts and
    // docs/input/DESIGN-neu.md. Raising this back to 0.3 silently breaks
    // every primary button's contrast -- the next two assertions show why.
    expect(luminanceThreshold).toBe(0.2);
    expect(theme.luminanceThreshold).toBe(0.2);
  });

  it("places {colors.brand}'s luminance between 0.2 and 0.3, where the threshold choice flips the outcome", () => {
    const brandLuminance = relativeLuminance(colors.brand);
    expect(brandLuminance).toBeGreaterThan(0.2);
    expect(brandLuminance).toBeLessThan(0.3);
  });

  it("counter-probe: Mantine's default 0.3 threshold would put white text on brand and fail WCAG AA", () => {
    const brandLuminance = relativeLuminance(colors.brand);
    const defaultThreshold = 0.3;

    // Mantine's isLightColor: `luminance(color) > threshold`. Below the
    // default 0.3 threshold, brand reads as "not light" and autoContrast
    // picks white text.
    const isLightUnderDefault = brandLuminance > defaultThreshold;
    expect(isLightUnderDefault).toBe(false);

    const whiteOnBrand = contrastRatio("#ffffff", colors.brand);
    expect(whiteOnBrand).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  it("at the configured 0.2 threshold, brand reads as light and autoContrast picks the dark on-brand text, which passes AA", () => {
    const brandLuminance = relativeLuminance(colors.brand);
    const isLightUnderConfiguredThreshold = brandLuminance > luminanceThreshold;
    expect(isLightUnderConfiguredThreshold).toBe(true);

    // theme.black backs autoContrast's dark-text branch; it must be
    // onBrand ("marke-auf" in the design document), not Mantine's default
    // pure black, or the button text doesn't match the document's own
    // contrast figure.
    expect(theme.black).toBe(colors.onBrand);

    const onBrandOnBrand = contrastRatio(colors.onBrand, colors.brand);
    expect(onBrandOnBrand).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
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

  it("keeps button text at 13px by default and sets 14px on buttons inside FormDensity", () => {
    const { container } = render(
      createElement(
        UiProvider,
        null,
        createElement(Button, null, "Outside"),
        createElement(FormDensity.Provider, { value: "form" }, createElement(Button, null, "Inside")),
      ),
    );
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));

    expect(componentValues.Button?.vars?.(theme, { size: "md" }, {}).root?.["--button-fz"]).toBe("13px");
    expect(buttons[0]?.style.getPropertyValue("--button-fz")).toBe("13px");
    expect(screen.getByRole("button", { name: "Inside" }).style.getPropertyValue("--button-fz")).toBe("14px");
  });
});
