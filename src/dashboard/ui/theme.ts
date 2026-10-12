import { createTheme } from "@mantine/core";
import type { MantineColorsTuple, MantineTheme, MantineThemeOverride } from "@mantine/core";

interface StateToken {
  readonly color: string;
  readonly background?: string;
  readonly wordColor?: string;
}

interface FamilyToken {
  readonly color: string;
  readonly background: string;
}

// Mantine types `theme.other` as `Record<string, any>`. This augmentation
// gives `StatusLed` typed access to its token groups under strict
// type checking.
declare module "@mantine/core" {
  interface MantineThemeOther {
    rail: string;
    inspector: string;
    hairline: string;
    text4: string;
    tint1: string;
    tint2: string;
    s8: string;
    s10: string;
    s12: string;
    /** Status-color tokens. */
    state: {
      green: StateToken;
      amber: StateToken;
      red: StateToken;
      off: StateToken;
    };
    /** Event-family color tokens. */
    family: {
      community: FamilyToken;
      raid: FamilyToken;
      moderation: FamilyToken;
    };
  }
}

/** Legacy Mantine styles read existing dashboard tokens through CSS variables. */
export const colors = {
  ground: "var(--background)",
  rail: "var(--rail)",
  surface: "var(--surface)",
  surfaceHover: "var(--surface-hover)",
  inspector: "var(--surface-inspector)",
  well: "var(--surface-well)",
  depth: "var(--surface-depth)",
  hairline: "var(--line)",
  hairlineStrong: "var(--line-strong)",
  hairlineLight: "var(--line-light)",
  text: "var(--text)",
  text2: "var(--text-2)",
  text3: "var(--text-3)",
  text4: "var(--text-4)",
  brand: "var(--brand)",
  brandHover: "var(--brand-hover)",
  brandPress: "var(--brand-press)",
  brandText: "var(--brand-text)",
  brandHairline: "var(--brand-line)",
  onBrand: "var(--on-brand)",
  tint1: "var(--tint-1)",
  tint2: "var(--tint-2)",
  green: "var(--green)",
  greenFill: "var(--green-surface)",
  amber: "var(--warn)",
  amberFill: "var(--warning-surface)",
  error: "var(--error)",
  errorText: "var(--error-text)",
  errorFill: "var(--error-surface)",
  community: "var(--community)",
  communityFill: "var(--community-surface)",
  raid: "var(--raid)",
  raidFill: "var(--raid-surface)",
  moderation: "var(--moderation)",
  moderationFill: "var(--moderation-surface)",
} as const;

/**
 * Keep Mantine's contrast threshold aligned with the existing primary action
 * while legacy components remain on Mantine.
 */
export const luminanceThreshold = 0.2;

/** Builds Mantine colors from computed CSS values so its contrast checks receive parseable colors. */
export const createDashboardTheme = (readCssColor: (variable: string) => string): MantineThemeOverride => {
  const resolve = (variable: string, fallback: string): string => readCssColor(variable).trim() || fallback;
  const dark: MantineColorsTuple = [
    resolve("--text", colors.text), // dark.0 -- text
    resolve("--text-2", colors.text2), // dark.1 -- second text stage
    resolve("--text-3", colors.text3), // dark.2 -- dimmed, placeholder, column heads
    resolve("--line-light", colors.hairlineLight), // dark.3 -- hover border
    resolve("--line-strong", colors.hairlineStrong), // dark.4 -- default field/button border
    resolve("--surface-hover", colors.surfaceHover), // dark.5 -- hover surface
    resolve("--surface", colors.surface), // dark.6 -- default surface: neutral button, paper, modal, drawer
    resolve("--background", colors.ground), // dark.7 -- body
    resolve("--surface-well", colors.well), // dark.8 -- input fields, pre, "off" icon tile
    resolve("--surface-depth", colors.depth), // dark.9 -- backdrop behind floating layers
  ];
  // Brand shades follow Mantine's light-to-dark order; shade 6 is the filled
  // action, and shade 7 is its pressed state.
  const brand: MantineColorsTuple = [
    resolve("--brand-text", colors.brandText),
    resolve("--brand-text", colors.brandText),
    resolve("--brand-text", colors.brandText), // brand.2 -- links, focus ring, active nav entry, command name
    resolve("--brand-hover", colors.brandHover),
    resolve("--brand-hover", colors.brandHover), // brand.4 -- hover of the primary action
    resolve("--brand", colors.brand),
    resolve("--brand", colors.brand), // brand.6 -- primary action, selected-row/button brand edge
    resolve("--brand-press", colors.brandPress), // brand.7 -- press
    resolve("--brand-press", colors.brandPress),
    resolve("--brand-press", colors.brandPress),
  ];

  return createTheme({
    colors: { dark, brand },
    primaryColor: "brand",
    primaryShade: 6,
    autoContrast: true,
    luminanceThreshold,
    // Mantine uses `theme.black` for dark primary-action contrast.
    black: resolve("--on-brand", colors.onBrand),
    focusRing: "auto",
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif",
    fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, monospace',
    fontSizes: {
      xs: "11px", // Navigation label
      sm: "12px", // Field name, LED word, number
      md: "13px", // Body, section, and button text
      lg: "15px", // Section title
      xl: "22px", // Page title
    },
    lineHeights: { md: "1.5" },
    headings: {
      fontWeight: "600",
      sizes: {
        h1: { fontSize: "22px", lineHeight: "1.25" },
        h2: { fontSize: "15px", lineHeight: "1.5" },
        h3: { fontSize: "13px", lineHeight: "1.5" },
      },
    },
    radius: { sm: "6px", md: "12px" },
    defaultRadius: "sm",
    spacing: { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px" },
    breakpoints: { xs: "420px", sm: "640px", md: "768px", lg: "1024px", xl: "1400px" },
    shadows: {
      // "Shadows only for floating layers" rule in docs/input/DESIGN-neu.md: exactly one shadow exists, and it
      // belongs only to floating layers (Modal, Drawer, Popover, Menu, the
      // Select dropdown). Every other shadow level falls back to none, so a
      // component's larger default shadow is silenced by the theme itself.
      xs: "var(--shadow-floating)",
      sm: "none",
      md: "none",
      lg: "none",
      xl: "none",
    },
    other: {
      rail: colors.rail,
      inspector: colors.inspector,
      hairline: colors.hairline,
      text4: colors.text4,
      tint1: colors.tint1,
      tint2: colors.tint2,
      s8: "32px",
      s10: "40px",
      s12: "48px",
      // State and event-family tokens each use one color per state or family,
      // rather than ten-step Mantine scales. `StatusLed` reads these.
      state: {
        green: { color: colors.green, background: colors.greenFill },
        amber: { color: colors.amber, background: colors.amberFill },
        red: { color: colors.error, wordColor: colors.errorText, background: colors.errorFill },
        off: { color: colors.text4 },
      },
      family: {
        community: { color: colors.community, background: colors.communityFill },
        raid: { color: colors.raid, background: colors.raidFill },
        moderation: { color: colors.moderation, background: colors.moderationFill },
      },
    },
    components: {
      Button: {
        defaultProps: { size: "md" },
        vars: (_theme: MantineTheme, props: { color?: string; variant?: string }) => ({
          root: {
            ...(props.color === undefined || props.color === "brand") &&
              (props.variant === undefined || props.variant === "filled")
              ? { "--button-color": colors.onBrand }
              : {},
            "--button-height-md": "44px",
            "--button-height-compact-md": "34px",
            "--button-padding-x-md": "16px",
            "--button-fz": "13px",
          },
        }),
      },
      // Input is the shared base of TextInput, NumberInput, Select and
      // Textarea (Mantine keys every one of them under `["Input", <own
      // name>]`), so this one override moves every field's surface into the
      // well without repeating it per field type.
      Input: {
        defaultProps: { size: "md" },
        vars: (_theme: MantineTheme, props: { size?: string }) => ({
          wrapper: {
            "--input-bg": colors.well,
            "--input-bd": colors.hairlineStrong,
            "--input-height-md": "44px",
            "--input-height-compact-md": "34px",
            "--input-fz": typeof props.size === "string" && props.size.startsWith("compact-") ? "13px" : "14px",
            "--input-padding": "12px",
            "--input-padding-y-md": "10px",
          },
        }),
      },
      InputWrapper: {
        styles: {
          label: { fontSize: "13px", fontWeight: 500 },
          description: { fontSize: "12px" },
          error: { fontSize: "12px" },
        },
      },
      Switch: {
        defaultProps: { size: "md", radius: "md" },
        styles: {
          thumb: { borderRadius: "var(--mantine-radius-sm)" },
        },
        vars: () => ({
          root: {
            "--switch-height-md": "20px",
            "--switch-width-md": "36px",
            "--switch-thumb-size-md": "14px",
          },
        }),
      },
      Modal: {
        defaultProps: {
          radius: "md",
          shadow: "xs",
          overlayProps: { color: colors.depth, backgroundOpacity: 0.6 },
        },
        styles: {
          content: { backgroundColor: colors.surface, border: `1px solid ${colors.hairline}` },
          header: { backgroundColor: colors.surface },
        },
      },
    },
  });
};
