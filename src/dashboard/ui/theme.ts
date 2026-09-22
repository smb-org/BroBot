import { createTheme } from "@mantine/core";
import type { MantineColorsTuple, MantineThemeOverride } from "@mantine/core";

export interface StateToken {
  readonly color: string;
  readonly background?: string;
  readonly wordColor?: string;
}

export interface FamilyToken {
  readonly color: string;
  readonly background: string;
}

// `theme.other` is typed `Record<string, any>` by Mantine; this augmentation
// gives `Led` and `Chip` a typed read of the two groups they own, instead of
// every `theme.other.state.*` access silently widening to `any` under
// strictTypeChecked. The design document names this property `theme.other.
// zustand`/`familie` (German); kept in English here per the project's
// identifier rule, with the German names quoted below for traceability.
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
    /** "theme.other.zustand" in docs/input/DESIGN-neu.md. */
    state: {
      green: StateToken;
      amber: StateToken;
      red: StateToken;
      off: StateToken;
    };
    /** "theme.other.familie" in docs/input/DESIGN-neu.md. */
    family: {
      community: FamilyToken;
      raid: FamilyToken;
      moderation: FamilyToken;
    };
  }
}

/**
 * Color tokens transcribed from `docs/input/DESIGN-neu.md` ("Colors") and
 * `DESIGN.md`, whose `colors.*` placeholders these values resolve. This is
 * the single source `ui/` reads from; nothing here duplicates a literal hex
 * value anywhere else in `ui/`. Keys are English (project rule); each one's
 * German source name from `src/dashboard/styles.css` is quoted in its
 * comment so the mapping back to that file and to the design document stays
 * traceable.
 *
 * The `depth` value ("Tiefe") has no hex value anywhere in either document
 * -- the design doc calls it "*neu*" and only describes it verbally ("the
 * darkest surface, only the background behind Modal/Drawer, at 60%
 * opacity, darker than the well"). One step below `well` on the same warm
 * near-black scale: deep enough to separate a floating layer, warm enough not
 * to read as a hole next to a running stream. Decided 2026-09-22.
 */
export const colors = {
  ground: "#141312", // "--grund"
  rail: "#181716", // "--rail"
  surface: "#1e1c1a", // "--taste"
  surfaceHover: "#262321", // "--taste-hover"
  inspector: "#1a1917", // "--inspektor"
  well: "#100f0e", // "--rinne"
  depth: "#0a0908", // "--tiefe" (decided 2026-09-22, see above)
  hairline: "#312e2b", // "--linie"
  hairlineStrong: "#403c38", // "--linie-stark"
  hairlineLight: "#68615a", // "--linie-hell"
  text: "#f2efeb", // "--text"
  text2: "#b3aca4", // "--text-2"
  text3: "#8b857e", // "--text-3"
  text4: "#615c56", // "--text-4"
  brand: "#538dcc", // "--marke"
  brandHover: "#659cd7", // "--marke-hover"
  brandPress: "#4c80bc", // "--marke-press"
  brandText: "#9bc3ed", // "--marke-text"
  brandHairline: "#60758c", // "--marke-linie"
  onBrand: "#0a0c10", // "--marke-auf"
  tint1: "#172638", // "--tint-1"
  tint2: "#14202e", // "--tint-2"
  green: "#3ddc84", // "--gruen"
  greenFill: "rgba(61, 220, 132, 0.12)", // "--gruen-grund"
  amber: "#d9a441", // "--warn"
  amberFill: "rgba(217, 164, 65, 0.09)", // "--warn-grund"
  error: "#e2564d", // "--fehler"
  errorText: "#e8655d", // "--fehler-text"
  errorFill: "rgba(226, 86, 77, 0.09)", // "--fehler-grund"
  community: "#c4a3f5", // "--gemeinschaft"
  communityFill: "rgba(196, 163, 245, 0.12)", // "--gemeinschaft-grund"
  raid: "#f4a2d3", // "--raid"
  raidFill: "rgba(244, 162, 211, 0.12)", // "--raid-grund"
  moderation: "#5cc9c4", // "--moderation"
  moderationFill: "rgba(92, 201, 196, 0.12)", // "--moderation-grund"
} as const;

// "Color scheme and base tone" in docs/input/DESIGN-neu.md: the warm palette poured into Mantine's ten-step
// dark scale, 0 (lightest text) to 9 (deepest surface).
const dark: MantineColorsTuple = [
  colors.text, // dark.0 -- text
  colors.text2, // dark.1 -- second text stage
  colors.text3, // dark.2 -- dimmed, placeholder, column heads
  colors.hairlineLight, // dark.3 -- hover border
  colors.hairlineStrong, // dark.4 -- default field/button border
  colors.surfaceHover, // dark.5 -- hover surface
  colors.surface, // dark.6 -- default surface: neutral button, paper, modal, drawer
  colors.ground, // dark.7 -- body
  colors.well, // dark.8 -- input fields, pre, "off" icon tile
  colors.depth, // dark.9 -- backdrop behind floating layers
];

// "Marke": built light-to-dark so Mantine's convention (shade 6 filled,
// shade 7 pressed) lands on today's values. Shades 0/1/3/5/8/9 are unused
// interpolation steps the document does not name.
const brand: MantineColorsTuple = [
  "#e6f0fa",
  "#c9ddf3",
  colors.brandText, // brand.2 -- links, focus ring, active nav entry, command name
  "#7fb0e2",
  colors.brandHover, // brand.4 -- hover of the primary action
  "#5b95d2",
  colors.brand, // brand.6 -- primary action, selected-row/button brand edge
  colors.brandPress, // brand.7 -- press
  "#3d6797",
  "#2d4a6c",
];

/**
 * "The contrast rule" in docs/input/DESIGN-neu.md: Mantine's `autoContrast`
 * default `luminanceThreshold` is 0.3. `{colors.marke}` (#538dcc) has a
 * relative luminance of 0.25 -- below Mantine's default threshold, so
 * `autoContrast` would treat it as "dark enough" and put white text on it:
 * 3.47:1, failing WCAG AA on every primary button. At 0.2, `autoContrast`
 * instead picks `{colors.marke-auf}` (5.6:1). This is not a stray override
 * -- raising it back to 0.3 breaks every primary button's contrast.
 */
export const luminanceThreshold = 0.2;

export const theme: MantineThemeOverride = createTheme({
  colors: { dark, brand },
  primaryColor: "brand",
  primaryShade: 6,
  autoContrast: true,
  luminanceThreshold,
  // `autoContrast`'s dark branch reaches for `theme.black`, not a
  // per-color token; without this override it renders pure `#000` instead
  // of `{colors.marke-auf}` on the primary button. Not pure black: the doc
  // is explicit that the button text is a dark shade of the palette, and
  // gives its own contrast ratio (5.6:1) against it.
  black: colors.onBrand,
  focusRing: "auto",
  fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif",
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, monospace',
  fontSizes: {
    xs: "11px", // Navetikett
    sm: "12px", // Feldname, LED-Wort, Zahl
    md: "13px", // Body, Abschnitt, Knopftext -- Mantine's default for every component
    lg: "15px", // Bereichstitel
    xl: "22px", // Seitentitel
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
    xs: "0 8px 24px rgba(0, 0, 0, 0.45)",
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
    // Zustand and Herkunft are one shade and one field each -- deliberately
    // not modeled as ten-step Mantine colors. Only `Led` and `Chip` read
    // these.
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
      vars: () => ({
        root: {
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
      vars: () => ({
        wrapper: {
          "--input-bg": colors.well,
          "--input-bd": colors.hairlineStrong,
          "--input-height-md": "44px",
          "--input-height-compact-md": "34px",
        },
      }),
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
