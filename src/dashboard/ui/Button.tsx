import { useContext, type ReactNode, type Ref } from "react";

import { Button as ButtonPrimitive } from "./primitives/button";
import { FormDensity } from "./FormDensity";
import { Icon, type IconName } from "./Icon";

type ButtonVariant = "primary" | "neutral" | "subtle" | "secondary";
export type ButtonSize = "md" | "compact";

interface ButtonBaseProps {
  variant?: ButtonVariant;
  danger?: boolean | "subtle";
  disabled?: boolean;
  ariaDisabled?: boolean;
  describedBy?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  ariaControls?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  autoFocus?: boolean;
  title?: string;
  id?: string;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

type ButtonWithTextProps = ButtonBaseProps & { children: ReactNode; icon?: IconName; iconOnly?: false };
type ButtonIconOnlyProps = ButtonBaseProps & { children?: never; icon: IconName; iconOnly: true; ariaLabel: string };
export type ButtonProps = ButtonWithTextProps | ButtonIconOnlyProps;

export function Button(props: ButtonProps) {
  const formDensity = useContext(FormDensity);
  const {
    variant = "neutral", danger = false, disabled = false, ariaDisabled = false, onClick, type = "button", autoFocus = false,
    title, id, size = "md", ref, className, describedBy, ariaPressed, ariaHasPopup, ariaExpanded, ariaControls,
  } = props;
  const iconOnly = props.iconOnly === true;
  const icon = props.icon;
  const effectiveVariant = danger === true ? "danger" : danger === "subtle" ? "danger-outline" : variant;
  const classes = [
    "ui-button", `ui-button--${variant}`, className,
    !iconOnly && icon !== undefined ? "ui-button--with-icon" : undefined,
    iconOnly ? "ui-button--icon-only" : undefined,
    iconOnly && size === "compact" ? "ui-button--icon-only-compact" : undefined,
    formDensity === "form" ? "ui-button--form-density" : undefined,
  ].filter(Boolean).join(" ");
  const glyph = icon === undefined ? null : <Icon name={icon} size={iconOnly && size === "md" ? 20 : 16} />;

  return <ButtonPrimitive
    ref={ref}
    variant={effectiveVariant}
    size={iconOnly ? "icon" : size}
    disabled={disabled}
    aria-disabled={ariaDisabled || undefined}
    aria-label={props.ariaLabel}
    aria-describedby={describedBy}
    aria-pressed={ariaPressed}
    aria-haspopup={ariaHasPopup}
    aria-expanded={ariaExpanded}
    aria-controls={ariaControls}
    onClick={onClick}
    type={type}
    id={id}
    title={title}
    autoFocus={autoFocus}
    className={classes}
    data-danger={danger || undefined}
  >{iconOnly ? glyph : <>{glyph}{props.children}</>}</ButtonPrimitive>;
}
