import { useId, type KeyboardEvent, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import { Input } from "./primitives/input";
import { TruncatedText } from "./TruncatedText";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

interface FieldBaseProps {
  label: string;
  ariaLabel?: string;
  labelHidden?: boolean;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  readOnly?: boolean;
  type?: "text" | "password";
  autoComplete?: string;
  spellCheck?: boolean;
  mono?: boolean;
  countLength?: (value: string) => number;
  countWhenNearLimitOnly?: boolean;
  name?: string;
  id?: string;
  normalize?: (value: string) => string;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

type FieldCountProps =
  | { maxLength: number; countLabel: (count: number, maxLength: number) => ReactNode }
  | { maxLength?: undefined; countLabel?: never };

type FieldAdornmentProps =
  | { icon: IconName; prefix?: never; leftLabel?: never }
  | { prefix: string; icon?: never; leftLabel?: never }
  | { leftLabel: string; icon?: never; prefix?: never }
  | { icon?: undefined; prefix?: undefined; leftLabel?: undefined };

export type FieldProps = FieldBaseProps & FieldCountProps & (
  | ({ variant: "search"; clearLabel: string } & { icon?: never; prefix?: never; leftLabel?: never })
  | ({ variant?: undefined; clearLabel?: never } & FieldAdornmentProps)
);

export function Field({ label, ariaLabel, labelHidden = false, hint, error, value, onChange, placeholder, disabled = false, required = false, readOnly = false, type = "text", autoComplete, spellCheck, mono = false, countLength, countWhenNearLimitOnly = false, name, id: suppliedId, icon, prefix, leftLabel, normalize, maxLength, countLabel, className, onKeyDown, variant, clearLabel }: FieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const disabledReason = useDisabledFieldReason();
  const searchVariant = variant === "search";
  const effectiveLabelHidden = labelHidden || searchVariant;
  const count = countLength?.(value) ?? value.length;
  const overLimit = maxLength !== undefined && count > maxLength;
  const nearLimit = maxLength !== undefined && count >= maxLength * 0.9;
  const showCount = !countWhenNearLimitOnly || (maxLength !== undefined && count >= Math.ceil(maxLength * 0.8)) || overLimit;
  const effectiveError = error ?? (overLimit ? countLabel(count, maxLength) : undefined);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const leadingLabel = prefix ?? leftLabel;
  const leading = searchVariant ? <Icon name="search" size={16} /> : leadingLabel === undefined ? icon === undefined ? null : <Icon name={icon} size={16} /> : <span className="ui-field__prefix" aria-hidden="true">{leadingLabel}</span>;
  const describedBy = [hintId, effectiveError == null ? null : errorId, disabledReason?.id].filter((part): part is string => part !== null && part !== undefined).join(" ") || undefined;

  return <div data-ui="" className={["ui-field", searchVariant ? "ui-field--search" : undefined, className, leading === null ? undefined : "ui-field--prefixed"].filter(Boolean).join(" ")}>
    <label className={`ui-field__label${effectiveLabelHidden ? " sr-only" : ""}`} htmlFor={id}>{label}</label>
    <div className="ui-field__control">
      {leading === null ? null : <span className="ui-field__leading">{leading}</span>}
      <Input
        id={id}
        aria-label={ariaLabel ?? ((labelHidden || searchVariant) ? label : undefined)}
        aria-describedby={describedBy}
        aria-invalid={effectiveError == null ? undefined : true}
        value={value}
        onChange={(event) => {
          let next = normalize?.(event.currentTarget.value) ?? event.currentTarget.value;
          if (prefix !== undefined && next.startsWith(prefix)) next = next.slice(prefix.length);
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (searchVariant && event.key === "Escape" && value.length > 0) {
            event.preventDefault();
            onChange("");
          }
          onKeyDown?.(event);
        }}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        type={type}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        required={required}
        name={name}
        className={["ui-field__input", mono ? "ui-field__input--mono" : undefined, leading === null && !searchVariant ? undefined : "ui-field__input--with-leading", searchVariant ? "ui-field__input--search" : undefined].filter(Boolean).join(" ")}
      />
      {searchVariant ? <button
        type="button"
        className="ui-field__clear"
        aria-label={clearLabel}
        aria-hidden={value.length === 0 ? true : undefined}
        tabIndex={value.length === 0 ? -1 : undefined}
        disabled={disabled || value.length === 0}
        style={{ visibility: value.length === 0 ? "hidden" : "visible" }}
        onClick={() => { onChange(""); }}
      ><Icon name="close" size={16} /></button> : null}
    </div>
    <span data-ui="" id={hintId} className="ui-field__description">
      {hint === undefined ? null : <TruncatedText className="ui-field__hint" text={hint} />}
      {maxLength === undefined || !showCount ? null : <span className={`ui-field__count${nearLimit && !overLimit ? " ui-field__count--warning" : ""}${overLimit ? " ui-field__count--error" : ""}`}>{countLabel(count, maxLength)}</span>}
      {describedHelper(null, disabledReason, `field-${id}`)}
    </span>
    <span data-ui="" id={errorId} className="ui-field__error" aria-live="polite">{effectiveError == null || effectiveError === "" ? <span aria-hidden="true">&nbsp;</span> : <><span aria-hidden="true">× </span>{typeof effectiveError === "string" ? <TruncatedText className="ui-field__hint" text={effectiveError} /> : effectiveError}</>}</span>
  </div>;
}
