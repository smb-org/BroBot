import { Button as MantineButton } from "@mantine/core";
import { useContext, type CSSProperties, type ReactNode, type Ref } from "react";

import { FormDensity } from "./FormDensity";
import { Icon, type IconName } from "./Icon";
import { colors } from "./theme";

export type ButtonVariant = "primary" | "neutral" | "subtle" | "secondary";
export type ButtonSize = "md" | "compact";

interface ButtonBaseProps {
  variant?: ButtonVariant;
  /** "Danger (`danger`, only in `ui/`): red without a border; hover white on
   *  red" in docs/input/DESIGN-neu.md. A deleting action carries this
   *  permanently; it overrides `variant` because a danger button is never
   *  "quiet". */
  danger?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  /** Points at the reason line for a disabled action -- visible, disabled,
   *  with its reason at the point of effect (editor-konzept 6). */
  describedBy?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Initial focus inside a `ConfirmDialog`: Mantine honors the focus target. */
  autoFocus?: boolean;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

type ButtonWithTextProps = ButtonBaseProps & {
  children: ReactNode;
  icon?: IconName;
  iconOnly?: false;
  ariaLabel?: never;
};

type ButtonIconOnlyProps = ButtonBaseProps & {
  children?: never;
  icon: IconName;
  iconOnly: true;
  ariaLabel: string;
};

export type ButtonProps = ButtonWithTextProps | ButtonIconOnlyProps;

const subtleStyle: CSSProperties = { "--button-color": colors.text2 } as CSSProperties;

// "There is no Button color=\"red\"" in docs/input/DESIGN-neu.md -- Mantine's
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
 * Neutral is Mantine's `default`, primary is `filled` on the brand color,
 * subtle is recolored to Text-2, secondary reuses `default`, and danger is
 * hand-built to preserve its hover rule. Icons always come from the UI seam.
 */
export function Button(props: ButtonProps) {
  const formDensity = useContext(FormDensity);
  const {
    variant = "neutral",
    danger = false,
    disabled = false,
    ariaDisabled = false,
    onClick,
    type = "button",
    autoFocus = false,
    size = "md",
    ref,
    className,
    describedBy,
  } = props;
  const iconOnly = props.iconOnly === true;
  const icon = props.icon;
  const mantineVariant = danger ? "filled" : variant === "primary" ? "filled" : variant === "subtle" ? "subtle" : "default";
  const buttonStyle = danger ? dangerStyle : variant === "subtle" ? subtleStyle : undefined;
  const fontWeight = danger ? undefined : variant === "primary" ? 600 : 500;
  const buttonClassName = [className, leadingIconClassName(props), iconOnly ? "ui-button--icon-only" : "", iconOnly && size === "compact" ? "ui-button--icon-only-compact" : ""]
    .filter(Boolean)
    .join(" ") || undefined;
  const style = {
    ...buttonStyle,
    ...(formDensity === "form" ? { "--button-fz": "14px" } : undefined),
    ...(iconOnly ? { width: size === "compact" ? 34 : 44, minWidth: size === "compact" ? 34 : 44, paddingInline: 0 } : undefined),
    fontWeight,
    ...(disabled || ariaDisabled ? { opacity: 0.55, cursor: "not-allowed" } : undefined),
  } as CSSProperties;
  const label = iconOnly ? undefined : props.children;
  const leadingIcon = iconOnly || icon === undefined ? undefined : <Icon name={icon} size={16} />;
  const iconOnlyGlyph = props.iconOnly === true
    ? <Icon name={props.icon} size={size === "compact" ? 16 : 20} />
    : undefined;

  return (
    <MantineButton
      ref={ref}
      variant={mantineVariant}
      size={size === "compact" ? "compact-md" : "md"}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      onClick={onClick}
      type={type}
      aria-label={iconOnly ? props.ariaLabel : undefined}
      aria-describedby={describedBy}
      data-autofocus={autoFocus ? true : undefined}
      className={buttonClassName}
      leftSection={leadingIcon}
      style={style}
    >
      {iconOnlyGlyph ?? label}
    </MantineButton>
  );
}

const leadingIconClassName = (props: ButtonProps): string =>
  props.iconOnly !== true && props.icon !== undefined ? "ui-button--with-icon" : "";
