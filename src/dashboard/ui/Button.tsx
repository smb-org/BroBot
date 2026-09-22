import { Button as MantineButton } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";

import { colors } from "./theme";

export type ButtonVariant = "primary" | "neutral" | "subtle" | "secondary";

export interface ButtonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  /** "Danger (`danger`, only in `ui/`): red without a border; hover white on
   *  red" in docs/input/DESIGN-neu.md. A deleting action carries this
   *  permanently; it overrides `variant` because a danger button is never
   *  "quiet". */
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Initial focus inside a `ConfirmDialog`: "initial fokussiert" (Abbrechen)
   *  or "initial auf Abbrechen" -- Mantine's focus trap honors
   *  `data-autofocus` on the element it should focus first. */
  autoFocus?: boolean;
}

const subtleStyle: CSSProperties = { "--button-color": colors.text2 } as CSSProperties;

// "There is no Button color="red"" in docs/input/DESIGN-neu.md -- Mantine's
// `variant="filled"` `color` prop auto-darkens on hover, not what "hover
// white on red" asks for. `--button-hover-color` is Mantine's own CSS
// variable (read by its stylesheet's `:hover` rule), set here per-instance
// instead.
const dangerStyle: CSSProperties = {
  "--button-bg": colors.error,
  "--button-hover": colors.error,
  "--button-bd": "none",
  "--button-color": colors.text,
  // Literal white, not a design token: "white on red" is the one place the
  // document names the color "white" rather than one of its own tokens.
  "--button-hover-color": "#ffffff",
} as CSSProperties;

/**
 * "Buttons" in docs/input/DESIGN-neu.md: neutral is Mantine's `default`
 * variant (already themed to Taste/Taste-Hover in `theme.ts`), primary is
 * `filled` on the brand color (autoContrast + `luminanceThreshold` give it
 * dark text, see "the contrast rule"), subtle is `subtle` recolored to
 * Text-2, secondary reuses `default` for the "load more" convention, and
 * danger is hand-built because Mantine's `color` prop can't express its
 * hover rule.
 */
export function Button({
  children,
  variant = "neutral",
  danger = false,
  disabled = false,
  onClick,
  type = "button",
  autoFocus = false,
}: ButtonProps) {
  const mantineVariant = danger ? "filled" : variant === "primary" ? "filled" : variant === "subtle" ? "subtle" : "default";
  const style = danger ? dangerStyle : variant === "subtle" ? subtleStyle : undefined;
  const fontWeight = danger ? undefined : variant === "primary" ? 600 : 500;

  return (
    <MantineButton
      variant={mantineVariant}
      disabled={disabled}
      onClick={onClick}
      type={type}
      data-autofocus={autoFocus ? true : undefined}
      style={{ ...style, fontWeight, ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined) }}
    >
      {children}
    </MantineButton>
  );
}
