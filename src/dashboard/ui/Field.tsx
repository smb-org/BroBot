import { TextInput } from "@mantine/core";
import type { KeyboardEvent, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

interface FieldBaseProps {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** A value the field only displays, never edits (the invitation link). */
  readOnly?: boolean;
  /** Monospace value, for a field whose exact characters matter (the invitation link). */
  mono?: boolean;
  name?: string;
  id?: string;
  normalize?: (value: string) => string;
  className?: string;
  /** A caller that commits its own debounced draft on Enter (see the
   *  events person filter, #157) -- optional, nothing else needs it. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export type FieldProps = FieldBaseProps & (
  | { maxLength: number; countLabel: (count: number, maxLength: number) => ReactNode }
  | { maxLength?: undefined; countLabel?: never }
) & (
  | { icon: IconName; prefix?: never }
  | { prefix: string; icon?: never }
  | { icon?: undefined; prefix?: undefined }
);

/**
 * A single-line text field. Project vocabulary only: `label`, `hint`,
 * `error` -- never Mantine's `description`/`error` render-prop shape.
 * "Inputs / Fields" in docs/input/DESIGN-neu.md: error carries a leading
 * `×` and the border stays strong (wired in the theme's `Input`
 * override, not here).
 */
export function Field({ label, hint, error, value, onChange, placeholder, disabled = false, required = false, readOnly = false, mono = false, name, id, icon, prefix, normalize, maxLength, countLabel, className, onKeyDown }: FieldProps) {
  const disabledReason = useDisabledFieldReason();
  const count = value.length;
  const overLimit = maxLength !== undefined && count > maxLength;
  const nearLimit = maxLength !== undefined && count >= maxLength * 0.9;
  const effectiveError = error ?? (overLimit ? countLabel(count, maxLength) : undefined);
  const errorNode = effectiveError === undefined || effectiveError === "" ? undefined : (
    <span><span aria-hidden="true">× </span>{effectiveError}</span>
  );
  const leading = prefix === undefined ? (icon === undefined ? undefined : <Icon name={icon} size={16} />) : (
    <span className="ui-field__prefix" aria-hidden="true">{prefix}</span>
  );
  const description: ReactNode = hint === undefined && maxLength === undefined && disabledReason === null ? undefined : (
    <span className="ui-field__description">
      {hint === undefined ? null : <span className="ui-field__hint">{hint}</span>}
      {maxLength === undefined ? null : <span className={`ui-field__count${nearLimit && !overLimit ? " ui-field__count--warning" : ""}${overLimit ? " ui-field__count--error" : ""}`}>{countLabel(count, maxLength)}</span>}
      {describedHelper(null, disabledReason, `field-${id ?? label}`)}
    </span>
  );

  return (
    <TextInput
      className={className}
      label={label}
      description={description}
      error={errorNode}
      inputWrapperOrder={["label", "input", "description", "error"]}
      value={value}
      onChange={(event) => {
        let next = normalize?.(event.currentTarget.value) ?? event.currentTarget.value;
        if (prefix !== undefined && next.startsWith(prefix)) next = next.slice(prefix.length);
        onChange(next);
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      name={name}
      id={id}
      leftSection={leading}
      leftSectionPointerEvents="none"
      styles={{
        ...(prefix === undefined ? {} : { section: { color: "var(--text-3)", fontFamily: "var(--mantine-font-family-monospace)", borderRight: "1px solid var(--line)" } }),
        ...(mono ? { input: { fontFamily: "var(--mantine-font-family-monospace)" } } : {}),
      }}
    />
  );
}
